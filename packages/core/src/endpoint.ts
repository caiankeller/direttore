import { ApiError, HttpResponseError } from "./errors";
import { createRequestContext, executeEndpoint } from "./fetch";
import { FetchTransportError, isClientOffline } from "./transport";
import type {
  ApiClient,
  ApiClientConfig,
  ApiServiceConfig,
  ApiServiceDefinition,
  ApiServiceDefinitionConfig,
  ApiServiceDefinitionMap,
  ApiStatusHandlers,
  ApiTransportErrorHandlers,
  ApiTransportErrorKind,
  Endpoint,
  EndpointCacheKey,
  EndpointConfig,
  EndpointDefinition,
  EndpointFetchOptions,
  EndpointMiddleware,
  EndpointRequestContext,
  MountedApiServices,
  ServiceEndpointConfig,
  ServiceEndpointDefinitions,
} from "./types";

type AnyContext = EndpointRequestContext<any, any, any, any, any, any, any>;
type AnyMiddleware = EndpointMiddleware<any, any, any, any, any, any, any>;
type AnyEndpointConfig = EndpointConfig<any, any, any, any, any, any, any>;
type AnyServiceEndpointConfig = ServiceEndpointConfig<any, any, any, any, any, any, any>;
type EndpointRuntime<TMeta, TAuth, TServiceName extends string> = {
  serviceName?: TServiceName | undefined;
  service?: ApiServiceConfig<TMeta, TAuth, TServiceName> | undefined;
};

export function endpoint<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
>(
  config: EndpointConfig<TInput, TResponse, TOutput, TError>,
): Endpoint<TInput, TResponse, TOutput, TError> {
  return createEndpoint({}, config);
}

export function defineEndpoint<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
>(
  config: ServiceEndpointConfig<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
): EndpointDefinition<TInput, TResponse, TOutput, TError, TMeta, TAuth, TServiceName> {
  return { config } as EndpointDefinition<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
}

export function defineService<
  const TName extends string,
  const TEndpoints extends ServiceEndpointDefinitions<
    any,
    any,
    TName
  > = ServiceEndpointDefinitions<any, any, TName>,
  TMeta = unknown,
  TAuth = unknown,
>(
  name: TName,
  definition: ApiServiceConfig<TMeta, TAuth, TName> & {
    endpoints: TEndpoints;
  },
): ApiServiceDefinition<TName, TMeta, TAuth, TEndpoints> {
  const { endpoints, ...config } = definition;
  return {
    name,
    config,
    endpoints,
  } as ApiServiceDefinition<TName, TMeta, TAuth, TEndpoints>;
}

export function createApiClient<TMeta = unknown, TAuth = unknown>(
  config: ApiClientConfig<TMeta, TAuth> = {},
): ApiClient<TMeta, TAuth> {
  return {
    config,
    endpoint(endpointConfig) {
      return createEndpoint(config, endpointConfig);
    },
    mount(services) {
      return mountServices(config, services);
    },
  };
}

export function createEndpoint<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
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
  runtime: EndpointRuntime<TMeta, TAuth, TServiceName> = {},
): Endpoint<TInput, TResponse, TOutput, TError, TMeta, TAuth, TServiceName> {
  validateEndpointConfig(config);

  const cacheKey = (input: TInput): EndpointCacheKey => {
    const serviceName = runtime.serviceName;
    const identity = config.key ? config.key(input) : input;

    return serviceName
      ? ([serviceName, config.name, identity] as const)
      : ([config.name, identity] as const);
  };

  const fetch = async (
    input: TInput,
    options?: EndpointFetchOptions<TMeta>,
  ): Promise<TOutput> => {
    let ctx: AnyContext | undefined;

    try {
      ctx = (await createRequestContext(
        client,
        config,
        input,
        options,
        runtime,
      )) as AnyContext;

      return await composeMiddleware(
        [
          ...(client.middleware ?? []),
          ...(ctx.service?.middleware ?? []),
          ...(config.middleware ?? []),
        ] as AnyMiddleware[],
        ctx,
        () => executeEndpoint(ctx as AnyContext),
      );
    } catch (error) {
      const errorCtx = ctx ?? createErrorContext(client, config, input, options, runtime);
      const statusResult = await runStatusHandler(error, errorCtx);
      if (statusResult !== undefined) {
        throw normalizeError(statusResult, error, getErrorRaw(error));
      }

      const transportResult = await runTransportErrorHandler(error, errorCtx);
      if (transportResult !== undefined) {
        throw normalizeError(transportResult, getErrorCause(error), getErrorRaw(error));
      }

      if (error instanceof FetchTransportError) {
        throw defaultTransportError(getTransportErrorKind(), error.error);
      }

      throw error;
    }
  };

  return { config, cacheKey, fetch } as unknown as Endpoint<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
}

function mountServices<
  TMeta,
  TAuth,
  const TServices extends ApiServiceDefinitionMap<any, any>,
>(
  client: ApiClientConfig<TMeta, TAuth>,
  services: TServices,
): MountedApiServices<TServices, TMeta, TAuth> {
  return Object.fromEntries(
    Object.entries(services).map(([serviceKey, service]) => [
      serviceKey,
      mountService(client, service as ApiServiceDefinition<string, TMeta, TAuth, any>),
    ]),
  ) as MountedApiServices<TServices, TMeta, TAuth>;
}

function mountService<TMeta, TAuth>(
  client: ApiClientConfig<TMeta, TAuth>,
  service: ApiServiceDefinition<string, TMeta, TAuth, any>,
): Record<string, Endpoint<any, any, any, any, TMeta, TAuth, string>> {
  return Object.fromEntries(
    Object.entries(service.endpoints).map(([endpointName, definition]) => {
      const endpointConfig = getEndpointConfig(definition);
      const config = {
        ...endpointConfig,
        name: endpointConfig.name ?? `${service.name}.${endpointName}`,
      } as AnyEndpointConfig;

      return [
        endpointName,
        createEndpoint(client, config, {
          serviceName: service.name,
          service: service.config,
        }),
      ];
    }),
  );
}

function getEndpointConfig(definition: unknown): AnyServiceEndpointConfig {
  if (isEndpointDefinition(definition)) {
    return definition.config;
  }

  return definition as AnyServiceEndpointConfig;
}

function isEndpointDefinition(value: unknown): value is EndpointDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "config" in value &&
    !("path" in value) &&
    !("request" in value)
  );
}

function validateEndpointConfig(config: {
  name?: unknown;
  path?: unknown;
  request?: unknown;
}): void {
  if (typeof config.name !== "string" || !config.name.trim()) {
    throw new Error("Endpoint requires a non-empty name.");
  }

  if (!config.path && !config.request) {
    throw new Error(`Endpoint "${config.name}" requires either a path or request handler.`);
  }
}

function createErrorContext<TInput, TMeta>(
  client: ApiClientConfig<TMeta, any>,
  config: EndpointConfig<TInput, any, any, any, TMeta, any, any>,
  input: TInput,
  options?: EndpointFetchOptions<TMeta>,
  runtime: EndpointRuntime<TMeta, any, any> = {},
): AnyContext {
  const serviceName = runtime.serviceName;
  const service = runtime.service;
  const headers = new Headers(client.headers);
  const init: RequestInit & { headers: Headers } = {
    ...client.requestInit,
    ...service?.requestInit,
    ...config.requestInit,
    ...options?.requestInit,
    headers,
  };

  if (config.method) init.method = config.method;
  if (options?.signal) init.signal = options.signal;

  return {
    input,
    method: config.method,
    path: undefined,
    serviceName,
    service,
    auth: config.auth,
    meta: options?.meta ?? config.meta ?? service?.meta ?? client.meta,
    endpointName: config.name,
    request: {
      url: undefined,
      init,
    },
    response: undefined,
    config,
    client,
  };
}

async function composeMiddleware<TOutput>(
  middleware: AnyMiddleware[],
  ctx: AnyContext,
  terminal: () => Promise<TOutput>,
): Promise<TOutput> {
  const dispatch = async (position: number): Promise<TOutput> => {
    const current = middleware[position];
    return current ? current(ctx, () => dispatch(position + 1)) : terminal();
  };

  return dispatch(0);
}

async function runStatusHandler(
  error: unknown,
  ctx: AnyContext,
): Promise<unknown | undefined> {
  const statusError = getStatusError(error);
  if (!statusError) return undefined;

  const handlers = {
    ...(ctx.client.onStatus ?? {}),
    ...(ctx.service?.onStatus ?? {}),
    ...(ctx.config.onStatus ?? {}),
  } as ApiStatusHandlers<any, any, any, any, any, any, any>;
  const handler = handlers[statusError.response.status] ?? handlers.default;

  return handler?.({
    response: statusError.response,
    body: statusError.body,
    ctx,
  } as never);
}

async function runTransportErrorHandler(
  error: unknown,
  ctx: AnyContext,
): Promise<unknown | undefined> {
  if (!(error instanceof FetchTransportError)) return undefined;

  const kind = getTransportErrorKind();
  const handlers = {
    ...(ctx.client.onTransportError ?? {}),
    ...(ctx.service?.onTransportError ?? {}),
    ...(ctx.config.onTransportError ?? {}),
  } as ApiTransportErrorHandlers<any, any, any, any, any, any, any>;
  const handler =
    kind === "clientOffline" ? handlers.clientOffline : handlers.serviceUnreachable;

  return handler?.({ error: error.error, kind, ctx } as never);
}

function getTransportErrorKind(): ApiTransportErrorKind {
  return isClientOffline() ? "clientOffline" : "serviceUnreachable";
}

function getErrorCause(error: unknown): unknown {
  return error instanceof FetchTransportError ? error.error : error;
}

function getErrorRaw(error: unknown): unknown {
  if (error instanceof HttpResponseError) {
    return error.body === undefined ? error.response : error.body;
  }

  if (error instanceof FetchTransportError) {
    return error.error;
  }

  return error;
}

function getStatusError(error: unknown):
  | {
      response: Response;
      body: unknown;
    }
  | undefined {
  if (error instanceof HttpResponseError) {
    return {
      response: error.response,
      body: error.body,
    };
  }

  if (error instanceof Response) {
    return {
      response: error,
      body: undefined,
    };
  }

  return undefined;
}

function defaultTransportError(kind: ApiTransportErrorKind, cause: unknown): ApiError {
  return new ApiError({
    message: kind === "clientOffline" ? "Client is offline." : "Service is unreachable.",
    code: kind === "clientOffline" ? "CLIENT_OFFLINE" : "SERVICE_UNREACHABLE",
    raw: cause,
    cause,
  });
}

function normalizeError(error: unknown, cause?: unknown, raw?: unknown): unknown {
  if (error instanceof Error) return error;
  if (!isRecord(error) || typeof error.message !== "string") return error;

  return new ApiError({
    message: error.message,
    code: getString(error, "code") ?? getString(error, "errorCode"),
    status: getNumber(error, "status"),
    fields: getFields(error),
    raw: "raw" in error ? error.raw : raw !== undefined ? raw : cause ?? error,
    cause: cause ?? error,
  });
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function getNumber(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}

function getFields(
  value: Record<string, unknown>,
): Record<string, string | string[]> | undefined {
  const fields = value.fields ?? value.errors;
  if (!isRecord(fields)) return undefined;

  return Object.fromEntries(
    Object.entries(fields).filter(([, entry]) => {
      return (
        typeof entry === "string" ||
        (Array.isArray(entry) && entry.every((item) => typeof item === "string"))
      );
    }),
  ) as Record<string, string | string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
