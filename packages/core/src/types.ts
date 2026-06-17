type NoInferValue<T> = [T][T extends any ? 0 : never];
declare const endpointTypes: unique symbol;

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

export type HeaderFactory<TInput, TMeta, TAuth = unknown, TServiceName extends string = string> = (
  ctx: EndpointRequestContext<TInput, any, any, any, TMeta, TAuth, TServiceName>,
) => HeadersInit | undefined | Promise<HeadersInit | undefined>;

export type AuthHeaderFactory<
  TInput = unknown,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = (
  ctx: EndpointRequestContext<TInput, any, any, any, TMeta, TAuth, TServiceName>,
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
  TAuth = unknown,
  TServiceName extends string = string,
> = {
  response: Response;
  body: unknown;
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
};

export type ApiStatusHandler<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = (
  event: ApiStatusHandlerContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
) =>
  | ApiHandlerResult<NoInferValue<TError>>
  | Promise<ApiHandlerResult<NoInferValue<TError>>>;

export type ApiStatusHandlers<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = {
  [status: number]:
    | ApiStatusHandler<TInput, TResponse, TOutput, TError, TMeta, TAuth, TServiceName>
    | undefined;
  default?:
    | ApiStatusHandler<TInput, TResponse, TOutput, TError, TMeta, TAuth, TServiceName>
    | undefined;
};

export type ApiTransportErrorKind = "clientOffline" | "serviceUnreachable";

export type ApiTransportErrorHandlerContext<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
  TKind extends ApiTransportErrorKind = ApiTransportErrorKind,
> = {
  error: unknown;
  kind: TKind;
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
};

export type ApiTransportErrorHandler<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
  TKind extends ApiTransportErrorKind = ApiTransportErrorKind,
> = (
  event: ApiTransportErrorHandlerContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName,
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
  TAuth = unknown,
  TServiceName extends string = string,
> = {
  clientOffline?:
    | ApiTransportErrorHandler<
        TInput,
        TResponse,
        TOutput,
        TError,
        TMeta,
        TAuth,
        TServiceName,
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
        TAuth,
        TServiceName,
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

export type EndpointRequestInit = Omit<
  RequestInit,
  "headers" | "method" | "body" | "signal"
>;

export type EndpointFetchOptions<TMeta = unknown> = {
  signal?: AbortSignal;
  headers?: HeadersInit;
  requestInit?: EndpointRequestInit;
  meta?: TMeta;
};

export type EndpointRequestContext<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = {
  input: TInput;
  method: HttpMethod | undefined;
  path: string | undefined;
  serviceName: TServiceName | undefined;
  service: ApiServiceConfig<TMeta, TAuth, TServiceName> | undefined;
  auth: TAuth | undefined;
  meta: TMeta | undefined;
  endpointName: string;
  request: EndpointRequest;
  response: Response | undefined;
  config: EndpointConfig<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
  client: ApiClientConfig<TMeta, TAuth>;
};

export type EndpointRequestHandler<
  TInput = unknown,
  TResponse = unknown,
  TOutput = unknown,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = (
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
) => TResponse | Promise<TResponse>;

export type EndpointMiddleware<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = (
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
  next: () => Promise<TOutput>,
) => Promise<TOutput>;

export type EndpointCacheKey = readonly unknown[];

export type EndpointKeyFactory<TInput> = (input: TInput) => unknown;

export type EndpointConfig<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = {
  name: string;
  method?: HttpMethod;
  path?: string | ((input: TInput) => string);
  baseUrl?: string;
  auth?: TAuth;
  input?: SchemaLike<TInput>;
  response?: SchemaLike<TResponse>;
  output?: SchemaLike<TOutput>;
  headers?: HeadersInit | HeaderFactory<TInput, TMeta, TAuth, TServiceName>;
  requestInit?: EndpointRequestInit;
  query?: QueryFactory<TInput>;
  body?: BodyFactory<TInput>;
  request?: EndpointRequestHandler<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
  parseResponse?: EndpointResponseParser<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
  parseErrorResponse?: EndpointErrorResponseParser<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
  transformResponse?: EndpointResponseTransformer<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
  onStatus?: ApiStatusHandlers<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
  onTransportError?: ApiTransportErrorHandlers<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
  middleware?: EndpointMiddleware<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >[];
  key?: EndpointKeyFactory<TInput>;
  meta?: TMeta;
};

export type ServiceEndpointConfig<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = Omit<
  EndpointConfig<TInput, TResponse, TOutput, TError, TMeta, TAuth, TServiceName>,
  "name"
> & {
  name?: string;
};

export type EndpointDefinition<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = {
  readonly [endpointTypes]?: {
    input: TInput;
    response: TResponse;
    output: TOutput;
    error: TError;
  };
  readonly config: ServiceEndpointConfig<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
};

export type EndpointResponseParser<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = (
  response: Response,
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
) => TResponse | Promise<TResponse>;

export type EndpointErrorResponseParser<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = (
  response: Response,
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
) => unknown | Promise<unknown>;

export type EndpointResponseTransformer<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = (
  response: TResponse,
  ctx: EndpointRequestContext<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >,
) => TOutput | Promise<TOutput>;

export type ApiServiceConfig<
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  requestInit?: EndpointRequestInit;
  getAuthHeaders?: AuthHeaderFactory<any, TMeta, TAuth, TServiceName>;
  parseErrorResponse?: EndpointErrorResponseParser<
    unknown,
    unknown,
    unknown,
    never,
    TMeta,
    TAuth,
    TServiceName
  >;
  onStatus?: ApiStatusHandlers<
    unknown,
    unknown,
    unknown,
    never,
    TMeta,
    TAuth,
    TServiceName
  >;
  onTransportError?: ApiTransportErrorHandlers<
    unknown,
    unknown,
    unknown,
    never,
    TMeta,
    TAuth,
    TServiceName
  >;
  middleware?: EndpointMiddleware<
    unknown,
    unknown,
    unknown,
    never,
    TMeta,
    TAuth,
    TServiceName
  >[];
  meta?: TMeta;
};

export type ServiceEndpointDefinitionValue<
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> =
  | EndpointDefinition<any, any, any, any, TMeta, TAuth, TServiceName>
  | ServiceEndpointConfig<any, any, any, any, TMeta, TAuth, TServiceName>;

export type ServiceEndpointDefinitions<
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = Record<string, ServiceEndpointDefinitionValue<TMeta, TAuth, TServiceName>>;

export type ApiServiceDefinition<
  TName extends string = string,
  TMeta = unknown,
  TAuth = unknown,
  TEndpoints extends ServiceEndpointDefinitions<
    TMeta,
    TAuth,
    TName
  > = ServiceEndpointDefinitions<TMeta, TAuth, TName>,
> = {
  readonly name: TName;
  readonly config: ApiServiceConfig<TMeta, TAuth, TName>;
  readonly endpoints: TEndpoints;
};

export type ApiServiceDefinitionConfig<
  TMeta = unknown,
  TAuth = unknown,
  TName extends string = string,
  TEndpoints extends ServiceEndpointDefinitions<
    TMeta,
    TAuth,
    TName
  > = ServiceEndpointDefinitions<TMeta, TAuth, TName>,
> = ApiServiceConfig<TMeta, TAuth, TName> & {
  endpoints: TEndpoints;
};

export type ApiServiceDefinitionMap<TMeta = unknown, TAuth = unknown> = Record<
  string,
  ApiServiceDefinition<string, TMeta, TAuth, any>
>;

export type ApiClientConfig<TMeta = unknown, TAuth = unknown> = ApiServiceConfig<
  TMeta,
  TAuth,
  string
>;

type EndpointCalls<TInput, TOutput, TMeta> = [TInput] extends [undefined]
  ? {
      readonly cacheKey: (input?: undefined) => EndpointCacheKey;
      fetch(input?: undefined, options?: EndpointFetchOptions<TMeta>): Promise<TOutput>;
    }
  : {
      readonly cacheKey: (input: TInput) => EndpointCacheKey;
      fetch(input: TInput, options?: EndpointFetchOptions<TMeta>): Promise<TOutput>;
    };

export type Endpoint<
  TInput = unknown,
  TResponse = unknown,
  TOutput = TResponse,
  TError = never,
  TMeta = unknown,
  TAuth = unknown,
  TServiceName extends string = string,
> = {
  readonly [endpointTypes]?: {
    input: TInput;
    response: TResponse;
    output: TOutput;
    error: TError;
  };
  readonly config: EndpointConfig<
    TInput,
    TResponse,
    TOutput,
    TError,
    TMeta,
    TAuth,
    TServiceName
  >;
} & EndpointCalls<TInput, TOutput, TMeta>;

type EndpointFromServiceDefinition<
  TDefinition,
  TMeta,
  TAuth,
  TServiceName extends string,
> =
  TDefinition extends EndpointDefinition<
    infer TInput,
    infer TResponse,
    infer TOutput,
    infer TError,
    any,
    any,
    any
  >
    ? Endpoint<TInput, TResponse, TOutput, TError, TMeta, TAuth, TServiceName>
    : TDefinition extends ServiceEndpointConfig<
          infer TInput,
          infer TResponse,
          infer TOutput,
          infer TError,
          any,
          any,
          any
        >
      ? Endpoint<TInput, TResponse, TOutput, TError, TMeta, TAuth, TServiceName>
      : never;

export type MountedApiServices<
  TServices extends ApiServiceDefinitionMap<any, any>,
  TMeta,
  TAuth,
> = {
  readonly [TServiceKey in keyof TServices]: TServices[TServiceKey] extends ApiServiceDefinition<
    infer TServiceName,
    any,
    any,
    infer TEndpoints
  >
    ? {
        readonly [TEndpointKey in keyof TEndpoints]: EndpointFromServiceDefinition<
          TEndpoints[TEndpointKey],
          TMeta,
          TAuth,
          TServiceName
        >;
      }
    : never;
};

export type EndpointInput<TEndpoint> =
  TEndpoint extends { readonly [endpointTypes]?: { input: infer TInput } }
    ? TInput
    : never;

export type EndpointResponse<TEndpoint> =
  TEndpoint extends { readonly [endpointTypes]?: { response: infer TResponse } }
    ? TResponse
    : never;

export type EndpointOutput<TEndpoint> =
  TEndpoint extends { readonly [endpointTypes]?: { output: infer TOutput } }
    ? TOutput
    : never;

export type EndpointError<TEndpoint> =
  TEndpoint extends { readonly [endpointTypes]?: { error: infer TError } }
    ? TError
    : never;

export type ApiClient<
  TMeta = unknown,
  TAuth = unknown,
> = {
  readonly config: ApiClientConfig<TMeta, TAuth>;
  endpoint<TInput = unknown, TResponse = unknown, TOutput = TResponse, TError = never>(
    config: EndpointConfig<TInput, TResponse, TOutput, TError, TMeta, TAuth>,
  ): Endpoint<TInput, TResponse, TOutput, TError, TMeta, TAuth>;
  mount<const TServices extends ApiServiceDefinitionMap<any, any>>(
    services: TServices,
  ): MountedApiServices<TServices, TMeta, TAuth>;
};
