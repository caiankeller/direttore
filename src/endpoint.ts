import { ApiError } from "./errors";
import { createRequestContext, executeFetchRequest } from "./fetch";
import { FetchTransportError, isClientOffline } from "./transport";
import type {
  ApiClient,
  ApiClientConfig,
  ApiTransportErrorHandlers,
  ApiTransportErrorKind,
  Endpoint,
  EndpointCacheKey,
  EndpointConfig,
  EndpointFetchOptions,
  EndpointMiddleware,
  EndpointRequestContext,
  ApiStatusHandlers,
} from "./types";

export const defaultClientConfig: ApiClientConfig = {};

export function endpoint<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
>(
  config: EndpointConfig<TInput, TResponse, TOutput, TError>,
): Endpoint<TInput, TResponse, TOutput, TError> {
  return createEndpoint(defaultClientConfig, config);
}

export function createApiClient<TMeta = unknown>(
  config: ApiClientConfig<TMeta> = {},
): ApiClient<TMeta> {
  return {
    config,
    endpoint<TInput = unknown, TResponse = unknown, TOutput = TResponse, TError = never>(
      endpointConfig: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>,
    ) {
      return createEndpoint(config, endpointConfig);
    },
  };
}

export function createEndpoint<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
>(
  client: ApiClientConfig<TMeta>,
  config: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>,
): Endpoint<TInput, TResponse, TOutput, TError, TMeta> {
  const getCacheKey = (input: TInput): EndpointCacheKey => {
    if (config.cacheKey) {
      return config.cacheKey(input);
    }

    const path = typeof config.path === "function" ? config.path(input) : config.path;
    const serviceName = config.service ?? client.defaultService;
    const keyName = config.name ?? path ?? "custom-request";

    if (serviceName) {
      return [serviceName, keyName, input] as const;
    }

    return [keyName, input] as const;
  };

  const fetchEndpoint = async (
    input: TInput,
    options?: EndpointFetchOptions<TMeta>,
  ): Promise<TOutput> => {
    let ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta> | undefined;

    try {
      ctx = await createRequestContext(client, config, input, options);
      const requestCtx = ctx;

      return await composeMiddleware(
        [
          ...(client.middleware ?? []),
          ...(ctx.service?.middleware ?? []),
          ...(config.middleware ?? []),
        ] as EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta>[],
        requestCtx,
        () => executeFetchRequest(requestCtx),
      );
    } catch (error) {
      const errorCtx = ctx ?? createErrorContext(client, config, input, options);
      const statusResult = await runStatusHandler(error, errorCtx);
      if (statusResult !== undefined) {
        throw normalizeError(statusResult, error);
      }

      const transportResult = await runTransportErrorHandler(error, errorCtx);
      if (transportResult !== undefined) {
        throw normalizeError(transportResult, getErrorCause(error));
      }

      if (error instanceof FetchTransportError) {
        throw defaultTransportError(getTransportErrorKind(), error.error);
      }

      throw error;
    }
  };

  return {
    config,
    cacheKey: getCacheKey,
    fetch: fetchEndpoint,
  };
}

function createErrorContext<TInput, TResponse, TOutput, TError, TMeta>(
  client: ApiClientConfig<TMeta>,
  config: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>,
  input: TInput,
  options?: EndpointFetchOptions<TMeta>,
): EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta> {
  const serviceName = config.service ?? client.defaultService;
  const service = serviceName ? client.services?.[serviceName] : undefined;
  const headers = new Headers(client.headers);
  const init: RequestInit & { headers: Headers } = {
    ...options?.requestInit,
    headers,
  };

  if (config.method) {
    init.method = config.method;
  }

  if (options?.signal) {
    init.signal = options.signal;
  }

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
    config,
    client,
  };
}

async function composeMiddleware<TInput, TResponse, TOutput, TError, TMeta>(
  middleware: EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta>[],
  ctx: Parameters<EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta>>[0],
  terminal: () => Promise<TOutput>,
): Promise<TOutput> {
  const dispatch = async (position: number): Promise<TOutput> => {
    const fn = middleware[position];

    if (!fn) {
      return terminal();
    }

    return fn(ctx, () => dispatch(position + 1));
  };

  return dispatch(0);
}

async function runStatusHandler<TInput, TResponse, TOutput, TError, TMeta>(
  error: unknown,
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>,
): Promise<unknown | undefined> {
  if (!(error instanceof Response)) {
    return undefined;
  }

  const clientHandlers = ctx.client.onStatus as
    | ApiStatusHandlers<TInput, TResponse, TOutput, TError, TMeta>
    | undefined;
  const serviceHandlers = ctx.service?.onStatus as
    | ApiStatusHandlers<TInput, TResponse, TOutput, TError, TMeta>
    | undefined;
  const handlers: ApiStatusHandlers<TInput, TResponse, TOutput, TError, TMeta> = {
    ...(clientHandlers ?? {}),
    ...(serviceHandlers ?? {}),
    ...(ctx.config.onStatus ?? {}),
  };
  const handler = handlers[error.status] ?? handlers.default;

  return handler?.({ response: error, ctx });
}

async function runTransportErrorHandler<TInput, TResponse, TOutput, TError, TMeta>(
  error: unknown,
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>,
): Promise<unknown | undefined> {
  if (!(error instanceof FetchTransportError)) {
    return undefined;
  }

  const kind = getTransportErrorKind();
  const clientHandlers = ctx.client.onTransportError as
    | ApiTransportErrorHandlers<TInput, TResponse, TOutput, TError, TMeta>
    | undefined;
  const serviceHandlers = ctx.service?.onTransportError as
    | ApiTransportErrorHandlers<TInput, TResponse, TOutput, TError, TMeta>
    | undefined;
  const handlers: ApiTransportErrorHandlers<TInput, TResponse, TOutput, TError, TMeta> = {
    ...(clientHandlers ?? {}),
    ...(serviceHandlers ?? {}),
    ...(ctx.config.onTransportError ?? {}),
  };

  if (kind === "clientOffline") {
    return handlers.clientOffline?.({ error: error.error, kind, ctx });
  }

  return handlers.serviceUnreachable?.({ error: error.error, kind, ctx });
}

function getTransportErrorKind(): ApiTransportErrorKind {
  return isClientOffline() ? "clientOffline" : "serviceUnreachable";
}

function getErrorCause(error: unknown): unknown {
  return error instanceof FetchTransportError ? error.error : error;
}

function defaultTransportError(kind: ApiTransportErrorKind, cause: unknown): ApiError {
  if (kind === "clientOffline") {
    return new ApiError({
      message: "Client is offline.",
      code: "CLIENT_OFFLINE",
      raw: cause,
      cause,
    });
  }

  return new ApiError({
    message: "Service is unreachable.",
    code: "SERVICE_UNREACHABLE",
    raw: cause,
    cause,
  });
}

function normalizeError(error: unknown, cause?: unknown): unknown {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Error) {
    return error;
  }

  if (isRecord(error) && typeof error.message === "string") {
    return new ApiError({
      message: error.message,
      code: getString(error, "code") ?? getString(error, "errorCode"),
      status: getNumber(error, "status"),
      fields: getFields(error),
      raw: "raw" in error ? error.raw : cause ?? error,
      cause: cause ?? error,
    });
  }

  return error;
}

function getString(
  body: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = body?.[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(
  body: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = body?.[key];
  return typeof value === "number" ? value : undefined;
}

function getFields(
  body: Record<string, unknown> | undefined,
): Record<string, string | string[]> | undefined {
  const fields = body?.fields ?? body?.errors;
  if (!isRecord(fields)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => {
      if (typeof value === "string") {
        return true;
      }

      return Array.isArray(value) && value.every((item) => typeof item === "string");
    }),
  ) as Record<string, string | string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
