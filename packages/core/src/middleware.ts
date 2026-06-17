import type { EndpointMiddleware, HeaderFactory } from "./types";

export function withHeaders<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
>(
  getHeaders: HeaderFactory<TInput, TMeta>,
): EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta> {
  return async (ctx, next) => {
    mergeHeaders(ctx.request.init.headers, await getHeaders(ctx));
    return next();
  };
}

export type Logger = {
  debug?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type LoggerOptions = {
  log?: Logger;
  prefix?: string;
};

type LoggerPrefixOptions = Omit<LoggerOptions, "log">;

export function logger<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
>(
  options?: LoggerOptions,
): EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta>;

export function logger<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
>(
  log: Logger,
  options?: LoggerPrefixOptions,
): EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta>;

export function logger<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
>(
  logOrOptions: Logger | LoggerOptions = {},
  options: LoggerPrefixOptions = {},
): EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta> {
  const isCustomLogger = isLogger(logOrOptions);
  const log = isCustomLogger
    ? logOrOptions
    : (logOrOptions.log ?? console);
  const prefix = isCustomLogger
    ? (options.prefix ?? "direttore")
    : (logOrOptions.prefix ?? "direttore");

  return async (ctx, next) => {
    const startedAt = Date.now();
    log.debug?.(logEvent(prefix, "request"), {
      endpoint: ctx.endpointName,
      method: ctx.method,
      url: ctx.request.url,
    });

    try {
      const result = await next();
      log.debug?.(logEvent(prefix, "response"), {
        endpoint: ctx.endpointName,
        method: ctx.method,
        url: ctx.request.url,
        status: ctx.response?.status,
        durationMs: Date.now() - startedAt,
      });

      return result;
    } catch (error) {
      log.error?.(logEvent(prefix, "error"), {
        endpoint: ctx.endpointName,
        method: ctx.method,
        url: ctx.request.url,
        status: ctx.response?.status,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  };
}

function logEvent(prefix: string, event: string): string {
  return prefix ? `${prefix} ${event}` : event;
}

function isLogger(value: Logger | LoggerOptions): value is Logger {
  return "debug" in value || "error" in value;
}

function mergeHeaders(target: Headers, source: HeadersInit | undefined): void {
  if (!source) {
    return;
  }

  new Headers(source).forEach((value, key) => target.set(key, value));
}
