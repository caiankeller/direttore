import { parseWithSchema } from "./schema";
import { FetchTransportError, isAbortError } from "./transport";
import type {
  ApiClientConfig,
  ApiServiceConfig,
  EndpointConfig,
  EndpointFetchOptions,
  EndpointRequest,
  EndpointRequestContext,
} from "./types";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export async function createRequestContext<
  TInput,
  TResponse,
  TOutput,
  TError,
  TMeta,
>(
  client: ApiClientConfig<TMeta>,
  config: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>,
  rawInput: TInput,
  options?: EndpointFetchOptions<TMeta>,
): Promise<EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>> {
  const input = (await parseWithSchema(config.input, rawInput, "input")) as TInput;
  const method = config.method;
  const path = resolvePath(config.path, input);
  const serviceName = config.service ?? client.defaultService;
  const service = resolveService(client, serviceName);
  const url = buildUrl(config.baseUrl ?? service?.baseUrl ?? client.baseUrl, path);
  const headers = new Headers(client.headers);
  const init: RequestInit & { headers: Headers } = {
    ...options?.requestInit,
    headers,
  };

  if (method) {
    init.method = method;
  }

  if (options?.signal) {
    init.signal = options.signal;
  }

  const request: EndpointRequest = {
    url,
    init,
  };

  const ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta> = {
    input,
    method,
    path,
    serviceName,
    service,
    auth: config.auth,
    meta: options?.meta ?? config.meta ?? service?.meta ?? client.meta,
    endpointName: config.name,
    request,
    config,
    client,
  };

  mergeHeaders(headers, service?.headers);
  mergeHeaders(headers, await resolveHeaders(config.headers, ctx));

  const getAuthHeaders = service?.getAuthHeaders ?? client.getAuthHeaders;
  mergeHeaders(headers, await getAuthHeaders?.(ctx));
  mergeHeaders(headers, options?.headers);

  if (url && config.query) {
    request.url = appendQuery(url, await config.query(input));
  } else if (url) {
    request.url = appendQuery(url, getInputProperty(input, "query"));
  }

  if (!method || !BODYLESS_METHODS.has(method)) {
    const body = await resolveBody(config, input);
    if (body !== undefined) {
      request.init.body = serializeBody(body, headers);
    }
  }

  return ctx;
}

export async function executeFetchRequest<TInput, TResponse, TOutput, TError, TMeta>(
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>,
): Promise<TOutput> {
  let responseData: unknown;

  if (ctx.config.request) {
    responseData = await ctx.config.request(ctx);
  } else {
    if (!ctx.request.url) {
      throw new Error("Endpoint requires either a path or a custom request handler.");
    }

    const fetchImpl = ctx.service?.fetch ?? ctx.client.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("No fetch implementation is available.");
    }

    const response = await fetchImpl(ctx.request.url, ctx.request.init).catch(
      (error: unknown) => {
        if (isAbortError(error)) {
          throw error;
        }

        throw new FetchTransportError(error);
      },
    );
    if (!response.ok) {
      throw response;
    }

    const data = ctx.config.parseResponse
      ? await ctx.config.parseResponse(response, ctx)
      : await parseResponse(response);
    responseData = data;
  }

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

export async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (isJsonContentType(contentType)) {
    return response.json();
  }

  return response.text();
}

function resolvePath<TInput>(
  path: EndpointConfig<TInput>["path"],
  input: TInput,
): string | undefined {
  if (typeof path === "function") {
    return path(input);
  }

  if (!path) {
    return undefined;
  }

  return path.replace(/:([A-Za-z0-9_]+)|\{([A-Za-z0-9_]+)\}/g, (match, colon, brace) => {
    const key = colon || brace;
    const value = getInputProperty(input, key) ?? getInputProperty(getInputProperty(input, "params"), key);

    if (value === undefined || value === null) {
      return match;
    }

    return encodeURIComponent(String(value));
  });
}

function buildUrl(baseUrl: string | undefined, path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  if (/^https?:\/\//.test(path)) {
    return path;
  }

  if (!baseUrl) {
    return path;
  }

  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function resolveService<TMeta>(
  client: ApiClientConfig<TMeta>,
  serviceName: string | undefined,
): ApiServiceConfig<TMeta> | undefined {
  if (!serviceName) {
    return undefined;
  }

  const service = client.services?.[serviceName];
  if (!service) {
    throw new Error(`Unknown API service "${serviceName}".`);
  }

  return service;
}

async function resolveHeaders<TInput, TResponse, TOutput, TError, TMeta>(
  headers: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>["headers"],
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>,
): Promise<HeadersInit | undefined> {
  if (typeof headers === "function") {
    return headers(ctx);
  }

  return headers;
}

async function resolveBody<TInput, TResponse, TOutput, TError, TMeta>(
  config: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>,
  input: TInput,
): Promise<BodyInit | Record<string, unknown> | unknown[] | undefined> {
  if (config.body) {
    return config.body(input);
  }

  const body = getInputProperty(input, "body");
  if (body !== undefined) {
    return body as BodyInit | Record<string, unknown> | unknown[];
  }

  return undefined;
}

function appendQuery(
  url: string,
  query: Record<string, unknown> | URLSearchParams | unknown,
): string {
  if (!query) {
    return url;
  }

  const params = query instanceof URLSearchParams ? query : objectToSearchParams(query);
  const serialized = params.toString();

  if (!serialized) {
    return url;
  }

  return `${url}${url.includes("?") ? "&" : "?"}${serialized}`;
}

function objectToSearchParams(value: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (!isRecord(value)) {
    return params;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }

    if (Array.isArray(entry)) {
      for (const item of entry) {
        params.append(key, String(item));
      }
      continue;
    }

    params.set(key, String(entry));
  }

  return params;
}

function serializeBody(
  body: BodyInit | Record<string, unknown> | unknown[],
  headers: Headers,
): BodyInit {
  if (isBodyInit(body)) {
    return body;
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return JSON.stringify(body);
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.includes("+json");
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ReadableStream
  );
}

function mergeHeaders(target: Headers, source: HeadersInit | undefined): void {
  if (!source) {
    return;
  }

  new Headers(source).forEach((value, key) => target.set(key, value));
}

function getInputProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
