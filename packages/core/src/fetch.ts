import { HttpResponseError } from "./errors";
import { parseWithSchema } from "./schema";
import { FetchTransportError, isAbortError } from "./transport";
import type {
  ApiClientConfig,
  ApiServiceConfig,
  EndpointConfig,
  EndpointFetchOptions,
  EndpointRequest,
  EndpointRequestContext,
  EndpointRequestInit,
} from "./types";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const PATH_PARAM_PATTERN = /:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const URL_BASE = "http://direttore.local";

type EndpointRuntime<TMeta, TAuth, TServiceName extends string> = {
  serviceName?: TServiceName | undefined;
  service?: ApiServiceConfig<TMeta, TAuth, TServiceName> | undefined;
};

export async function createRequestContext<
  TInput,
  TResponse,
  TOutput,
  TError,
  TMeta,
  TAuth,
  TServiceName extends string,
>(
  client: ApiClientConfig<TMeta, TAuth>,
  config: EndpointConfig<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
  rawInput: TInput,
  options?: EndpointFetchOptions<TMeta>,
  runtime: EndpointRuntime<TMeta, TAuth, TServiceName> = {},
): Promise<
  EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >
> {
  const input = await parseWithSchema(config.input, rawInput, "input");
  const method = config.method;
  const path = resolvePath(config.path, input, config.name);
  const serviceName = runtime.serviceName;
  const service = runtime.service;
  const headers = mergeHeaders(client.headers, service?.headers);
  const init = createRequestInit(
    headers,
    method,
    options?.signal,
    client.requestInit,
    service?.requestInit,
    config.requestInit,
    options?.requestInit,
  );
  const request: EndpointRequest = {
    url: buildUrl(config.baseUrl ?? service?.baseUrl ?? client.baseUrl, path),
    init,
  };
  const ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  > = {
    input,
    method,
    path,
    serviceName,
    service,
    auth: config.auth,
    meta: options?.meta ?? config.meta ?? service?.meta ?? client.meta,
    endpointName: config.name,
    request,
    response: undefined,
    config,
    client,
  };

  mergeHeadersInto(headers, await resolveHeaders(config.headers, ctx));
  const getAuthHeaders = service?.getAuthHeaders ?? client.getAuthHeaders;
  mergeHeadersInto(headers, await getAuthHeaders?.(ctx));
  mergeHeadersInto(headers, options?.headers);

  request.url = request.url
    ? appendQuery(
        request.url,
        config.query ? await config.query(input) : getInputProperty(input, "query"),
      )
    : undefined;

  if (!method || !BODYLESS_METHODS.has(method)) {
    const body = await resolveBody(config.body, input);
    if (body !== undefined) request.init.body = serializeBody(body, headers);
  }

  return ctx;
}

export async function executeEndpoint<
  TInput,
  TResponse,
  TOutput,
  TError,
  TMeta,
  TAuth,
  TServiceName extends string,
>(
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
): Promise<TOutput> {
  const responseData = ctx.config.request
    ? await ctx.config.request(ctx)
    : await executeHttpRequest(ctx);
  const parsedResponse = await parseWithSchema(
    ctx.config.response,
    responseData,
    "response",
  );
  const output = ctx.config.transformResponse
    ? await ctx.config.transformResponse(parsedResponse, ctx)
    : (parsedResponse as unknown as TOutput);

  return parseWithSchema(ctx.config.output, output, "output");
}

async function executeHttpRequest(
  ctx: EndpointRequestContext<any, any, any, any, any, any, any>,
) {
  if (!ctx.request.url) {
    throw new Error(`Endpoint "${ctx.endpointName}" requires a path.`);
  }

  const fetchImpl = ctx.service?.fetch ?? ctx.client.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("No fetch implementation is available.");

  const response = await fetchImpl(ctx.request.url, ctx.request.init).catch(
    (error: unknown) => {
      if (isAbortError(error)) throw error;
      throw new FetchTransportError(error);
    },
  );
  ctx.response = response;

  if (!response.ok) {
    const { body, bodyParseError } = await parseErrorBody(response, ctx);
    throw new HttpResponseError(response, body, { bodyParseError });
  }

  return ctx.config.parseResponse
    ? ctx.config.parseResponse(response, ctx)
    : parseResponse(response);
}

export async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  return isJsonContentType(contentType) ? response.json() : response.text();
}

export async function parseErrorResponse(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;

  const text = await response.text();
  if (!text) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  if (!isJsonContentType(contentType)) return text;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function parseErrorBody(
  response: Response,
  ctx: EndpointRequestContext<any, any, any, any, any, any, any>,
): Promise<{ body: unknown; bodyParseError: unknown | undefined }> {
  const parser =
    ctx.config.parseErrorResponse ??
    ctx.service?.parseErrorResponse ??
    ctx.client.parseErrorResponse ??
    parseErrorResponse;

  try {
    return {
      body: await parser(response.clone(), ctx),
      bodyParseError: undefined,
    };
  } catch (bodyParseError) {
    return {
      body: undefined,
      bodyParseError,
    };
  }
}

function resolvePath<TInput>(
  path: EndpointConfig<TInput>["path"],
  input: TInput,
  endpointName: string,
): string | undefined {
  if (typeof path === "function") return path(input);
  if (!path) return undefined;

  const missing = new Set<string>();
  const resolved = path.replace(PATH_PARAM_PATTERN, (match, colon, brace) => {
    const key = colon || brace;
    const value =
      getInputProperty(input, key) ??
      getInputProperty(getInputProperty(input, "params"), key);

    if (value === undefined || value === null) {
      missing.add(key);
      return match;
    }

    return encodeURIComponent(String(value));
  });

  if (missing.size > 0) {
    throw new Error(
      `Endpoint "${endpointName}" is missing path parameter${missing.size === 1 ? "" : "s"}: ${[
        ...missing,
      ].join(", ")}.`,
    );
  }

  return resolved;
}

function buildUrl(baseUrl: string | undefined, path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (isAbsoluteUrl(path) || !baseUrl) return path;

  const absoluteBase = isAbsoluteUrl(baseUrl);
  const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`, URL_BASE);
  const url = new URL(path.replace(/^\/+/, ""), base);

  return formatUrl(url, absoluteBase || baseUrl.startsWith("/"));
}

function createRequestInit(
  headers: Headers,
  method: string | undefined,
  signal: AbortSignal | undefined,
  ...defaults: (EndpointRequestInit | undefined)[]
): RequestInit & { headers: Headers } {
  const init: RequestInit & { headers: Headers } = {
    ...Object.assign({}, ...defaults),
    headers,
  };

  if (method) init.method = method;
  if (signal) init.signal = signal;

  return init;
}

async function resolveHeaders<
  TInput,
  TResponse,
  TOutput,
  TError,
  TMeta,
  TAuth,
  TServiceName extends string,
>(
  headers: EndpointConfig<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >["headers"],
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
): Promise<HeadersInit | undefined> {
  return typeof headers === "function" ? headers(ctx) : headers;
}

async function resolveBody<TInput>(
  bodyFactory: EndpointConfig<TInput>["body"],
  input: TInput,
): Promise<BodyInit | Record<string, unknown> | unknown[] | undefined> {
  if (bodyFactory) return bodyFactory(input);
  return getInputProperty(input, "body") as
    | BodyInit
    | Record<string, unknown>
    | unknown[]
    | undefined;
}

function appendQuery(
  url: string,
  query: Record<string, unknown> | URLSearchParams | unknown,
): string {
  const params = query instanceof URLSearchParams ? query : objectToSearchParams(query);
  if ([...params].length === 0) return url;

  const absolute = isAbsoluteUrl(url);
  const parsed = new URL(url, URL_BASE);
  params.forEach((value, key) => parsed.searchParams.append(key, value));

  return formatUrl(parsed, absolute || url.startsWith("/"));
}

function objectToSearchParams(value: unknown): URLSearchParams {
  if (!isRecord(value)) return new URLSearchParams();

  return Object.entries(value).reduce((params, [key, entry]) => {
    if (entry === undefined || entry === null) return params;

    const values = Array.isArray(entry) ? entry : [entry];
    values.forEach((item) => params.append(key, String(item)));
    return params;
  }, new URLSearchParams());
}

function serializeBody(
  body: BodyInit | Record<string, unknown> | unknown[],
  headers: Headers,
): BodyInit {
  if (isBodyInit(body)) return body;

  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(body);
}

function mergeHeaders(...sources: (HeadersInit | undefined)[]): Headers {
  const headers = new Headers();
  sources.forEach((source) => mergeHeadersInto(headers, source));
  return headers;
}

function mergeHeadersInto(target: Headers, source: HeadersInit | undefined): void {
  if (!source) return;
  new Headers(source).forEach((value, key) => target.set(key, value));
}

function formatUrl(url: URL, keepLeadingSlash: boolean): string {
  if (url.origin !== URL_BASE) return url.toString();

  const relative = `${url.pathname}${url.search}${url.hash}`;
  return keepLeadingSlash ? relative : relative.replace(/^\//, "");
}

function isAbsoluteUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.includes("+json");
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    (typeof FormData !== "undefined" && value instanceof FormData) ||
    value instanceof URLSearchParams ||
    (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
  );
}

function getInputProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
