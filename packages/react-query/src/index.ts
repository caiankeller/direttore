import {
  mutationOptions as defineMutationOptions,
  queryOptions as defineQueryOptions,
} from "@tanstack/react-query";
import type {
  DefaultError,
  QueryFunction,
  UseMutationOptions,
  UseQueryOptions,
} from "@tanstack/react-query";
import type {
  Endpoint,
  EndpointCacheKey,
  EndpointFetchOptions,
} from "@direttore/core";

type AnyEndpoint = {
  readonly config: {
    readonly name: string;
  };
  readonly cacheKey: (...args: any[]) => EndpointCacheKey;
  fetch(...args: any[]): Promise<any>;
};
type ApiTree = Record<string, unknown>;

type EndpointMeta<TEndpoint extends AnyEndpoint> =
  TEndpoint extends Endpoint<any, any, any, any, infer TMeta, any, any>
    ? TMeta
    : unknown;

type EndpointInputOf<TEndpoint extends AnyEndpoint> =
  TEndpoint extends Endpoint<infer TInput, any, any, any, any, any, any>
    ? TInput
    : Parameters<TEndpoint["fetch"]>[0];

type EndpointOutputOf<TEndpoint extends AnyEndpoint> =
  TEndpoint extends Endpoint<any, any, infer TOutput, any, any, any, any>
    ? TOutput
    : Awaited<ReturnType<TEndpoint["fetch"]>>;

type AdapterFetchOptions<TEndpoint extends AnyEndpoint> = Omit<
  EndpointFetchOptions<EndpointMeta<TEndpoint>>,
  "signal"
>;

type MutationVariables<TEndpoint extends AnyEndpoint> = [
  EndpointInputOf<TEndpoint>,
] extends [undefined]
  ? void
  : EndpointInputOf<TEndpoint>;

type ReactMutationFunction<TEndpoint extends AnyEndpoint> = [
  EndpointInputOf<TEndpoint>,
] extends [undefined]
  ? () => Promise<EndpointOutputOf<TEndpoint>>
  : (variables: EndpointInputOf<TEndpoint>) => Promise<EndpointOutputOf<TEndpoint>>;

export type ReactQueryAdapter<TApi> = {
  readonly query: ReactQueryTree<TApi>;
  readonly mutation: ReactMutationTree<TApi>;
};

export type ReactQueryTree<TApi> = {
  readonly [TKey in keyof TApi]: TApi[TKey] extends AnyEndpoint
    ? ReactQueryEndpoint<TApi[TKey]>
    : TApi[TKey] extends ApiTree
      ? ReactQueryTree<TApi[TKey]>
      : never;
};

export type ReactMutationTree<TApi> = {
  readonly [TKey in keyof TApi]: TApi[TKey] extends AnyEndpoint
    ? ReactMutationEndpoint<TApi[TKey]>
    : TApi[TKey] extends ApiTree
      ? ReactMutationTree<TApi[TKey]>
      : never;
};

export type ReactQueryEndpoint<TEndpoint extends AnyEndpoint> = [
  EndpointInputOf<TEndpoint>,
] extends [undefined]
  ? {
      readonly key: (input?: undefined) => EndpointCacheKey;
      readonly queryKey: (input?: undefined) => EndpointCacheKey;
      readonly options: <
        TData = EndpointOutputOf<TEndpoint>,
        TError = DefaultError,
      >(
        input?: undefined,
        options?: ReactQueryEndpointOptions<TEndpoint, TData, TError>,
      ) => ReactQueryEndpointOptionsResult<TEndpoint, TData, TError>;
    }
  : {
      readonly key: (input: EndpointInputOf<TEndpoint>) => EndpointCacheKey;
      readonly queryKey: (input: EndpointInputOf<TEndpoint>) => EndpointCacheKey;
      readonly options: <
        TData = EndpointOutputOf<TEndpoint>,
        TError = DefaultError,
      >(
        input: EndpointInputOf<TEndpoint>,
        options?: ReactQueryEndpointOptions<TEndpoint, TData, TError>,
      ) => ReactQueryEndpointOptionsResult<TEndpoint, TData, TError>;
    };

export type ReactMutationEndpoint<TEndpoint extends AnyEndpoint> = [
  EndpointInputOf<TEndpoint>,
] extends [undefined]
  ? {
      readonly key: (input?: undefined) => EndpointCacheKey;
      readonly mutationKey: () => readonly [string];
      readonly options: <TError = DefaultError, TContext = unknown>(
        options?: ReactMutationEndpointOptions<TEndpoint, TError, TContext>,
      ) => ReactMutationEndpointOptionsResult<TEndpoint, TError, TContext>;
    }
  : {
      readonly key: (input: EndpointInputOf<TEndpoint>) => EndpointCacheKey;
      readonly mutationKey: () => readonly [string];
      readonly options: <TError = DefaultError, TContext = unknown>(
        options?: ReactMutationEndpointOptions<TEndpoint, TError, TContext>,
      ) => ReactMutationEndpointOptionsResult<TEndpoint, TError, TContext>;
    };

export type ReactQueryEndpointOptions<
  TEndpoint extends AnyEndpoint,
  TData = EndpointOutputOf<TEndpoint>,
  TError = DefaultError,
> = Omit<
  UseQueryOptions<EndpointOutputOf<TEndpoint>, TError, TData, EndpointCacheKey>,
  "queryKey" | "queryFn"
> & {
  fetch?: AdapterFetchOptions<TEndpoint> | undefined;
};

export type ReactQueryEndpointOptionsResult<
  TEndpoint extends AnyEndpoint,
  TData = EndpointOutputOf<TEndpoint>,
  TError = DefaultError,
> = Omit<
  UseQueryOptions<EndpointOutputOf<TEndpoint>, TError, TData, EndpointCacheKey>,
  "queryKey" | "queryFn"
> & {
  readonly queryKey: EndpointCacheKey;
  readonly queryFn: QueryFunction<EndpointOutputOf<TEndpoint>, EndpointCacheKey>;
};

export type ReactMutationEndpointOptions<
  TEndpoint extends AnyEndpoint,
  TError = DefaultError,
  TContext = unknown,
> = Omit<
  UseMutationOptions<
    EndpointOutputOf<TEndpoint>,
    TError,
    MutationVariables<TEndpoint>,
    TContext
  >,
  "mutationFn"
> & {
  fetch?: AdapterFetchOptions<TEndpoint> | undefined;
};

export type ReactMutationEndpointOptionsResult<
  TEndpoint extends AnyEndpoint,
  TError = DefaultError,
  TContext = unknown,
> = UseMutationOptions<
  EndpointOutputOf<TEndpoint>,
  TError,
  MutationVariables<TEndpoint>,
  TContext
> & {
  readonly mutationFn: ReactMutationFunction<TEndpoint>;
};

export function createReactQueryAdapter<TApi extends ApiTree>(
  api: TApi,
): ReactQueryAdapter<TApi> {
  return {
    query: mapApiTree(api, createQueryEndpointAdapter) as ReactQueryTree<TApi>,
    mutation: mapApiTree(api, createMutationEndpointAdapter) as ReactMutationTree<TApi>,
  };
}

export const createReactQuery = createReactQueryAdapter;

function createQueryEndpointAdapter<TEndpoint extends AnyEndpoint>(
  endpoint: TEndpoint,
): ReactQueryEndpoint<TEndpoint> {
  return {
    key: (input?: EndpointInputOf<TEndpoint>) => endpointCacheKey(endpoint, input),
    queryKey: (input?: EndpointInputOf<TEndpoint>) => endpointCacheKey(endpoint, input),
    options: (
      input?: EndpointInputOf<TEndpoint>,
      options?: ReactQueryEndpointOptions<TEndpoint>,
    ) => {
      const { fetch: fetchOptions, ...queryConfig } = options ?? {};
      const queryKey = endpointCacheKey(endpoint, input);

      return defineQueryOptions({
        ...queryConfig,
        queryKey,
        queryFn: ({ signal }) =>
          fetchEndpoint(
            endpoint,
            input,
            withSignal(fetchOptions, signal),
          ),
      }) as ReactQueryEndpointOptionsResult<TEndpoint>;
    },
  } as ReactQueryEndpoint<TEndpoint>;
}

function createMutationEndpointAdapter<TEndpoint extends AnyEndpoint>(
  endpoint: TEndpoint,
): ReactMutationEndpoint<TEndpoint> {
  return {
    key: (input?: EndpointInputOf<TEndpoint>) => endpointCacheKey(endpoint, input),
    mutationKey: () => [endpoint.config.name] as const,
    options: (
      options?: ReactMutationEndpointOptions<TEndpoint>,
    ) => {
      const { fetch: fetchOptions, ...mutationConfig } = options ?? {};

      return defineMutationOptions({
        mutationKey: [endpoint.config.name],
        ...mutationConfig,
        mutationFn: (variables) =>
          fetchEndpoint(
            endpoint,
            variables as EndpointInputOf<TEndpoint>,
            fetchOptions,
          ),
      }) as ReactMutationEndpointOptionsResult<TEndpoint>;
    },
  } as ReactMutationEndpoint<TEndpoint>;
}

function mapApiTree(
  tree: ApiTree,
  endpointFactory: (endpoint: AnyEndpoint) => unknown,
): ApiTree {
  return Object.fromEntries(
    Object.entries(tree).map(([key, value]) => {
      if (isEndpoint(value)) return [key, endpointFactory(value)];
      if (isApiTree(value)) return [key, mapApiTree(value, endpointFactory)];

      throw new TypeError(
        `Expected Direttore endpoint or service tree at "${key}".`,
      );
    }),
  );
}

function isApiTree(value: unknown): value is ApiTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEndpoint(value: unknown): value is AnyEndpoint {
  if (!isApiTree(value)) return false;

  return (
    typeof value.fetch === "function" &&
    typeof value.cacheKey === "function" &&
    isApiTree(value.config) &&
    typeof value.config.name === "string"
  );
}

function endpointCacheKey<TEndpoint extends AnyEndpoint>(
  endpoint: TEndpoint,
  input: EndpointInputOf<TEndpoint> | undefined,
): EndpointCacheKey {
  return endpoint.cacheKey(input as never);
}

function fetchEndpoint<TEndpoint extends AnyEndpoint>(
  endpoint: TEndpoint,
  input: EndpointInputOf<TEndpoint> | undefined,
  options?: EndpointFetchOptions<EndpointMeta<TEndpoint>>,
): Promise<EndpointOutputOf<TEndpoint>> {
  return endpoint.fetch(input as never, options) as Promise<EndpointOutputOf<TEndpoint>>;
}

function withSignal<TMeta>(
  options: Omit<EndpointFetchOptions<TMeta>, "signal"> | undefined,
  signal: AbortSignal | undefined,
): EndpointFetchOptions<TMeta> | undefined {
  if (signal === undefined) return options;

  return {
    ...options,
    signal,
  };
}
