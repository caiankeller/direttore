import { FetchTransportError, isAbortError, isClientOffline } from "./transport";
import type { EndpointMiddleware, HeaderFactory } from "./types";

const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

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

export type RetryOptions<TInput, TResponse, TOutput, TError, TMeta> = {
  attempts?: number;
  delay?: number | ((attempt: number) => number | Promise<number>);
  jitter?:
    | boolean
    | ((delayMs: number, attempt: number) => number | Promise<number>);
  shouldRetry?: (
    error: unknown,
    attempt: number,
    ctx: Parameters<EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta>>[0],
  ) => boolean | Promise<boolean>;
};

export function retry<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
>(
  options: RetryOptions<TInput, TResponse, TOutput, TError, TMeta> = {},
): EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta> {
  const attempts = options.attempts ?? 2;

  return async (ctx, next) => {
    let attempt = 0;

    for (;;) {
      try {
        return await next();
      } catch (error) {
        attempt += 1;
        const canRetry =
          attempt <= attempts &&
          (await (options.shouldRetry?.(error, attempt, ctx) ?? defaultShouldRetry(error)));

        if (!canRetry) {
          throw error;
        }

        const delayMs = await resolveRetryDelay(options, attempt);

        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }
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
      });

      return result;
    } catch (error) {
      log.error?.(logEvent(prefix, "error"), {
        endpoint: ctx.endpointName,
        method: ctx.method,
        url: ctx.request.url,
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

function defaultShouldRetry(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }

  if (error instanceof FetchTransportError && isClientOffline()) {
    return false;
  }

  return error instanceof Response ? error.status >= 500 : true;
}

async function resolveRetryDelay<TInput, TResponse, TOutput, TError, TMeta>(
  options: RetryOptions<TInput, TResponse, TOutput, TError, TMeta>,
  attempt: number,
): Promise<number> {
  const hasCustomDelay = options.delay !== undefined;
  const rawDelay = normalizeDelay(
    typeof options.delay === "function"
      ? await options.delay(attempt)
      : options.delay ?? defaultRetryDelay(attempt),
  );
  const jitter = options.jitter ?? !hasCustomDelay;

  if (typeof jitter === "function") {
    return normalizeDelay(await jitter(rawDelay, attempt));
  }

  if (jitter) {
    return Math.random() * rawDelay;
  }

  return rawDelay;
}

function defaultRetryDelay(attempt: number): number {
  return Math.min(
    DEFAULT_RETRY_MAX_DELAY_MS,
    DEFAULT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  );
}

function normalizeDelay(delayMs: number): number {
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
}

function mergeHeaders(target: Headers, source: HeadersInit | undefined): void {
  if (!source) {
    return;
  }

  new Headers(source).forEach((value, key) => target.set(key, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
