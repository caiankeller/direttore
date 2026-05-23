type NoInferValue<T> = [T][T extends any ? 0 : never];

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type NormalizedApiError = {
  message: string;
  code?: string | undefined;
  status?: number | undefined;
  fields?: Record<string, string | string[]> | undefined;
  raw?: unknown | undefined;
};

export type ApiErrorInit = NormalizedApiError & {
  cause?: unknown | undefined;
};

export type SchemaLike<T> =
  | {
      parse(value: unknown): T;
    }
  | {
      safeParse(value: unknown):
        | { success: true; data: T }
        | { success: false; error: unknown };
    }
  | {
      validate(value: unknown): T | Promise<T>;
    };

export type HeaderFactory<TInput, TMeta> = (
  ctx: EndpointRequestContext<TInput, any, any, any, TMeta>,
) => HeadersInit | undefined | Promise<HeadersInit | undefined>;

export type AuthHeaderFactory<TInput = unknown, TMeta = unknown> = (
  ctx: EndpointRequestContext<TInput, any, any, any, TMeta>,
) => HeadersInit | undefined | Promise<HeadersInit | undefined>;

export type QueryFactory<TInput> = (
  input: TInput,
) =>
  | Record<string, unknown>
  | URLSearchParams
  | undefined
  | Promise<Record<string, unknown> | URLSearchParams | undefined>;

export type BodyFactory<TInput> = (
  input: TInput,
) =>
  | BodyInit
  | Record<string, unknown>
  | unknown[]
  | undefined
  | Promise<BodyInit | Record<string, unknown> | unknown[] | undefined>;

export type ApiHandlerResult<TError = never> =
  | void
  | undefined
  | NormalizedApiError
  | Error
  | TError;

export type ApiStatusHandlerResult<TError = never> = ApiHandlerResult<TError>;

export type ApiStatusHandlerContext<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
> = {
  response: Response;
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>;
};

export type ApiStatusHandler<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
> = (
  event: ApiStatusHandlerContext<TInput, TResponse, TOutput, TError, TMeta>,
) =>
  | ApiHandlerResult<NoInferValue<TError>>
  | Promise<ApiHandlerResult<NoInferValue<TError>>>;

export type ApiStatusHandlers<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
> = {
  [status: number]:
    | ApiStatusHandler<TInput, TResponse, TOutput, TError, TMeta>
    | undefined;
  default?: ApiStatusHandler<TInput, TResponse, TOutput, TError, TMeta> | undefined;
};

export type ApiTransportErrorKind = "clientOffline" | "serviceUnreachable";

export type ApiTransportErrorHandlerContext<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
  TKind extends ApiTransportErrorKind = ApiTransportErrorKind,
> = {
  error: unknown;
  kind: TKind;
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>;
};

export type ApiTransportErrorHandler<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
  TKind extends ApiTransportErrorKind = ApiTransportErrorKind,
> = (
  event: ApiTransportErrorHandlerContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TKind
  >,
) =>
  | ApiHandlerResult<NoInferValue<TError>>
  | Promise<ApiHandlerResult<NoInferValue<TError>>>;

export type ApiTransportErrorHandlers<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
> = {
  clientOffline?:
    | ApiTransportErrorHandler<
        TInput,
        TResponse,
        TOutput,
        TError,
        TMeta,
        "clientOffline"
      >
    | undefined;
  serviceUnreachable?:
    | ApiTransportErrorHandler<
        TInput,
        TResponse,
        TOutput,
        TError,
        TMeta,
        "serviceUnreachable"
      >
    | undefined;
};

export type EndpointRequest = {
  url: string | undefined;
  init: RequestInit & {
    headers: Headers;
  };
};

export type EndpointFetchOptions<TMeta = unknown> = {
  signal?: AbortSignal;
  headers?: HeadersInit;
  requestInit?: Omit<RequestInit, "headers" | "method" | "body" | "signal">;
  meta?: TMeta;
};

export type EndpointRequestContext<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
> = {
  input: TInput;
  method: HttpMethod | undefined;
  path: string | undefined;
  serviceName: string | undefined;
  service: ApiServiceConfig<TMeta> | undefined;
  auth: unknown | undefined;
  meta: TMeta | undefined;
  endpointName: string | undefined;
  request: EndpointRequest;
  config: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>;
  client: ApiClientConfig<TMeta>;
};

export type EndpointRequestHandler<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
> = (
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>,
) => TResponse | Promise<TResponse>;

export type EndpointMiddleware<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
> = (
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>,
  next: () => Promise<TOutput>,
) => Promise<TOutput>;

export type EndpointCacheKey = readonly unknown[];

export type EndpointCacheKeyFactory<TInput> = (input: TInput) => EndpointCacheKey;

export type EndpointConfig<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
> = {
  name?: string;
  service?: string;
  method?: HttpMethod;
  path?: string | ((input: TInput) => string);
  baseUrl?: string;
  auth?: unknown;
  input?: SchemaLike<TInput>;
  response?: SchemaLike<TResponse>;
  output?: SchemaLike<TOutput>;
  headers?: HeadersInit | HeaderFactory<TInput, TMeta>;
  query?: QueryFactory<TInput>;
  body?: BodyFactory<TInput>;
  request?: EndpointRequestHandler<TInput, TResponse, TOutput, TError, TMeta>;
  parseResponse?: EndpointResponseParser<TInput, TResponse, TOutput, TError, TMeta>;
  transformResponse?: EndpointResponseTransformer<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta
  >;
  onStatus?: ApiStatusHandlers<TInput, TResponse, TOutput, TError, TMeta>;
  onTransportError?: ApiTransportErrorHandlers<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta
  >;
  middleware?: EndpointMiddleware<TInput, TResponse, TOutput, TError, TMeta>[];
  cacheKey?: EndpointCacheKeyFactory<TInput>;
  meta?: TMeta;
};

export type EndpointResponseParser<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
> = (
  response: Response,
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>,
) => TResponse | Promise<TResponse>;

export type EndpointResponseTransformer<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
> = (
  response: TResponse,
  ctx: EndpointRequestContext<TInput, TResponse, TOutput, TError, TMeta>,
) => TOutput | Promise<TOutput>;

export type ApiServiceConfig<TMeta = unknown> = {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  getAuthHeaders?: AuthHeaderFactory<any, TMeta>;
  onStatus?: ApiStatusHandlers<unknown, unknown, unknown, never, TMeta>;
  onTransportError?: ApiTransportErrorHandlers<unknown, unknown, unknown, never, TMeta>;
  middleware?: EndpointMiddleware<unknown, unknown, unknown, never, TMeta>[];
  meta?: TMeta;
};

export type ApiServicesConfig<TMeta = unknown> = Record<
  string,
  ApiServiceConfig<TMeta>
>;

export type ApiClientConfig<TMeta = unknown> =
  ApiServiceConfig<TMeta> & {
    services?: ApiServicesConfig<TMeta>;
    defaultService?: string;
  };

export type Endpoint<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
> = {
  readonly config: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>;
  readonly cacheKey: (input: TInput) => EndpointCacheKey;
  fetch(input: TInput, options?: EndpointFetchOptions<TMeta>): Promise<TOutput>;
};

export type EndpointInput<TEndpoint> =
  TEndpoint extends Endpoint<infer TInput, any, any, any, any> ? TInput : never;

export type EndpointResponse<TEndpoint> =
  TEndpoint extends Endpoint<any, infer TResponse, any, any, any> ? TResponse : never;

export type EndpointOutput<TEndpoint> =
  TEndpoint extends Endpoint<any, any, infer TOutput, any, any> ? TOutput : never;

export type EndpointError<TEndpoint> =
  TEndpoint extends Endpoint<any, any, any, infer TError, any> ? TError : never;

export type ApiClient<TMeta = unknown> = {
  readonly config: ApiClientConfig<TMeta>;
  endpoint<TInput = unknown, TResponse = unknown, TOutput = TResponse, TError = never>(
    config: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta>,
  ): Endpoint<TInput, TResponse, TOutput, TError, TMeta>;
};
