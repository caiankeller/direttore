# direttore

Zero-dependency API orchestration primitives for TypeScript applications.

Direttore gives API calls one predictable home. It defines service contracts,
builds requests, applies shared auth and middleware, validates responses, normalizes
errors, and exposes stable cache keys.

It deliberately does not own application state, caching, retries, invalidation, or UI
lifecycle. Use TanStack Query, framework stores, or your application layer for those.

## Early stage

Direttore is below `1.0.0`. APIs may change between minor releases while the contract is
being tested against real projects.

## Install

```sh
npm install @direttore/core
```

Direttore targets Node `>=18.17` and runtimes with the standard Fetch API.

## Define a client

`createApiClient()` owns global request policy: shared headers, auth lookup,
middleware, status handlers, transport handlers, and parser defaults.

```ts
import { createApiClient } from "@direttore/core";

type ApiMeta = {
  feature?: string;
};

type AuthPolicy = {
  scope?: string;
};

const client = createApiClient<ApiMeta, AuthPolicy>({
  headers: {
    "x-app": "web",
  },
  getAuthHeaders: async (ctx) => {
    const token = await session.getToken(ctx.auth?.scope);
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  },
  onStatus: {
    403: ({ response, body }) => ({
      message: "You do not have access to this resource.",
      code: "FORBIDDEN",
      status: response.status,
      raw: body,
    }),
  },
});
```

Services and endpoints can override these global defaults.

## Define services

Services are named backend profiles with their own base URL, auth, headers,
middleware, status handling, transport handling, error parsing, and endpoint
contracts.

```ts
import { defineEndpoint, defineService } from "@direttore/core";

type UserResponse = {
  data: {
    id: string;
    full_name: string;
  };
};

type User = {
  id: string;
  name: string;
};

export const identity = defineService("identity", {
  baseUrl: "https://identity.example.com",
  onStatus: {
    404: ({ response, body }) => ({
      message: "Identity resource not found.",
      code: "IDENTITY_NOT_FOUND",
      status: response.status,
      raw: body,
    }),
  },
  endpoints: {
    getUser: defineEndpoint<{ id: string }, UserResponse, User>({
      method: "GET",
      path: "/users/:id",
      auth: {
        scope: "users:read",
      },
      transformResponse: (response) => ({
        id: response.data.id,
        name: response.data.full_name,
      }),
    }),
  },
});
```

Endpoint names are inferred from the service name and object key:

```ts
identity.getUser -> "identity.getUser"
```

You can still pass `name` inside an endpoint when you need a custom stable name.

## Mount services

`mount()` binds service contracts to the client runtime and returns the API tree.

```ts
import { createApiClient } from "@direttore/core";
import { billing } from "./billing";
import { identity } from "./identity";

export const api = createApiClient({
  headers: {
    "x-app": "web",
  },
}).mount({
  identity,
  billing,
});

const user = await api.identity.getUser.fetch({ id: "u1" });
```

This keeps services split across files while preserving a tRPC-like caller shape:

```ts
await api.identity.getUser.fetch({ id: "u1" });
await api.billing.getInvoice.fetch({ id: "invoice-1" });
```

## Endpoint generics

The endpoint generics are:

```ts
defineEndpoint<TInput, TResponse, TOutput, TError>();
```

- `TInput` is passed to `fetch()`.
- `TResponse` is the decoded server response.
- `TOutput` is the value returned by `fetch()` and defaults to `TResponse`.
- `TError` describes custom handler results. JavaScript promises still reject with
  `unknown`, so callers must narrow caught errors.

No-input endpoints can be called without passing `undefined`:

```ts
export const identity = defineService("identity", {
  baseUrl: "https://identity.example.com",
  endpoints: {
    getSession: defineEndpoint<undefined, Session>({
      method: "GET",
      path: "/session",
    }),
  },
});

await api.identity.getSession.fetch();
api.identity.getSession.cacheKey();
```

## Typed auth and metadata

Client-level generics type request metadata and endpoint auth policy across mounted
services.

```ts
type ApiMeta = {
  feature?: string;
};

type AuthPolicy = {
  scope: "read" | "write";
};

const client = createApiClient<ApiMeta, AuthPolicy>({
  getAuthHeaders: async (ctx) => {
    const token = await session.getToken(ctx.auth?.scope);
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  },
});

export const users = defineService("users", {
  baseUrl: "https://api.example.com",
  endpoints: {
    update: defineEndpoint({
      method: "PATCH",
      path: "/users/:id",
      auth: {
        scope: "write",
      },
    }),
  },
});
```

Auth is a policy hint. Credential lookup and refresh belong in `getAuthHeaders`.

## Request construction

Path parameters use `:id` or `{id}` and are read from the input object, then
`input.params`.

```ts
await api.identity.getUser.fetch({ id: "u1" });
```

Missing path parameters reject before a network request is made.

Query parameters come from `query(input)` or `input.query`:

```ts
const identity = defineService("identity", {
  baseUrl: "https://identity.example.com",
  endpoints: {
    searchUsers: defineEndpoint<SearchUsersInput, User[]>({
      method: "GET",
      path: "/users",
      query: (input) => ({
        q: input.search,
        page: input.page,
      }),
    }),
  },
});
```

Bodies come from `body(input)` or `input.body`:

```ts
const identity = defineService("identity", {
  baseUrl: "https://identity.example.com",
  endpoints: {
    createUser: defineEndpoint<{ body: CreateUserBody }, User>({
      method: "POST",
      path: "/users",
    }),
  },
});
```

Plain objects and arrays are serialized as JSON. Standard `BodyInit` values, including
typed arrays, `FormData`, `Blob`, streams, strings, and `URLSearchParams`, pass through
unchanged.

## Request defaults and per-call options

`requestInit` defaults can be set on the client, service, endpoint, and individual
call. They merge in that order.

```ts
const client = createApiClient({
  requestInit: {
    credentials: "include",
  },
});

const identity = defineService("identity", {
  baseUrl: "https://identity.example.com",
  requestInit: {
    cache: "reload",
  },
  endpoints: {
    getUser: defineEndpoint<{ id: string }, User>({
      method: "GET",
      path: "/users/:id",
      requestInit: {
        cache: "no-cache",
      },
    }),
  },
});

const api = client.mount({ identity });

await api.identity.getUser.fetch(
  { id: "u1" },
  {
    signal,
    headers: {
      "x-request-id": crypto.randomUUID(),
    },
    requestInit: {
      priority: "high",
    },
    meta: {
      feature: "user-profile",
    },
  },
);
```

Method, headers, body, and signal are controlled by the endpoint pipeline and cannot be
set through `requestInit`.

## Schemas and transforms

Endpoints accept schema-like objects with `parse`, `safeParse`, or `validate`:

```ts
const identity = defineService("identity", {
  baseUrl: "https://identity.example.com",
  endpoints: {
    createUser: defineEndpoint({
      method: "POST",
      path: "/users",
      input: createUserInputSchema,
      response: createUserResponseSchema,
      output: userSchema,
      transformResponse: (response) => response.data,
    }),
  },
});
```

The response pipeline is:

```txt
Response -> parseResponse/default parser -> response schema -> transformResponse -> output schema
```

Schema failures reject with `SchemaValidationError`, whose `phase` is `"input"`,
`"response"`, or `"output"`.

Use `parseResponse` when the endpoint needs the raw `Response`:

```ts
const reports = defineService("reports", {
  baseUrl: "https://reports.example.com",
  endpoints: {
    download: defineEndpoint<{ id: string }, Blob>({
      method: "GET",
      path: "/reports/:id",
      parseResponse: (response) => response.blob(),
    }),
  },
});
```

The successful fetch response is also available as `ctx.response` to transforms and
middleware. This is useful for pagination headers, ETags, request IDs, and metrics.

## Errors

Direttore separates raw HTTP failures from app-normalized errors:

- Non-2xx responses reject with `HttpResponseError`.
- `HttpResponseError` exposes `response`, `status`, parsed `body`, and optional
  `bodyParseError`.
- Status handlers can return normalized objects, which reject as `ApiError`.
- Fetch transport failures reject with `ApiError` by default.
- Aborts reject with the original abort error.
- Schema failures reject with `SchemaValidationError`.
- Custom request failures pass through unchanged.

By default, failed JSON responses are parsed into `body`; non-JSON failures are parsed
as text. Use `parseErrorResponse` at the client, service, or endpoint level for backend
formats such as form-encoded OAuth errors, XML envelopes, or framework-specific shapes.

`onStatus` receives the `response`, parsed `body`, and request `ctx`. It can run
side effects and return nothing, or return a normalized `ApiError`:

```ts
const client = createApiClient({
  onStatus: {
    401: async () => {
      await session.invalidate();
    },
    422: ({ body, response }) => ({
      message: "Validation failed.",
      code: "VALIDATION_ERROR",
      status: response.status,
      fields: mapBackendFields(body),
      raw: body,
    }),
  },
});
```

If no `onStatus` handler returns an error, the original `HttpResponseError` is
re-thrown so callers can still inspect `error.response` and `error.body`.

`onTransportError` customizes offline and unreachable-service failures:

```ts
const billing = defineService("billing", {
  baseUrl: "https://billing.example.com",
  onTransportError: {
    serviceUnreachable: ({ error }) => ({
      message: "Billing is temporarily unavailable.",
      code: "BILLING_UNAVAILABLE",
      raw: error,
    }),
  },
  endpoints: {
    getInvoice: defineEndpoint<{ id: string }, Invoice>({
      method: "GET",
      path: "/invoices/:id",
    }),
  },
});
```

Client, service, and endpoint handlers merge from least to most specific.

## Middleware

Middleware wraps endpoint execution. It can observe or update the mutable request
context, or short-circuit execution.

```ts
import { logger, withHeaders } from "@direttore/core";

const client = createApiClient({
  middleware: [
    logger(),
    withHeaders(() => ({
      "x-trace-id": crypto.randomUUID(),
    })),
  ],
});
```

Built-in middleware is intentionally small:

- `withHeaders(getHeaders)` merges request headers.
- `logger(options)` logs request, response, and error events, including status and
  duration when available.

Retries are outside Direttore's scope. Configure them in TanStack Query or the
application layer that owns request lifecycle policy.

## Custom requests

Use `request` for SDKs, browser APIs, or non-fetch transports:

```ts
const local = defineService("local", {
  endpoints: {
    createReserve: defineEndpoint<CreateReserveInput, Reserve>({
      request: ({ input }) => customApi.createReserve(input),
    }),
  },
});
```

Custom request results still pass through response validation, transformation, output
validation, and middleware.

For standalone one-off endpoints that do not belong to a mounted service, use
`endpoint()`:

```ts
import { endpoint } from "@direttore/core";

const clock = endpoint<undefined, { now: string }>({
  name: "local.clock",
  request: () => ({ now: new Date().toISOString() }),
});
```

## Cache keys

Default cache keys use stable endpoint names:

```ts
api.identity.getUser.cacheKey({ id: "u1" });
// ["identity", "identity.getUser", { id: "u1" }]
```

Use `key(input)` to select only the identity-bearing part of endpoint input:

```ts
const identity = defineService("identity", {
  baseUrl: "https://identity.example.com",
  endpoints: {
    getUser: defineEndpoint<{ id: string; traceId: string }, User>({
      method: "GET",
      path: "/users/:id",
      key: ({ id }) => ({ id }),
    }),
  },
});
```

Direttore creates cache keys but does not own caching or invalidation.

## TanStack Query

```tsx
const input = { id };

const user = useQuery({
  queryKey: api.identity.getUser.cacheKey(input),
  queryFn: ({ signal }) => api.identity.getUser.fetch(input, { signal }),
  retry: 2,
});
```

Mutations use endpoint input as mutation variables:

```tsx
const mutation = useMutation({
  mutationFn: api.identity.updateUser.fetch,
});
```

For React Query projects, `@direttore/react-query` mirrors the mounted API tree:

```ts
const rq = createReactQueryAdapter(api);

rq.query.identity.getUser.options({ id: "u1" });
rq.mutation.identity.updateUser.options();
```

The core package stays framework-neutral and dependency-free.

## Helper types

```ts
import type {
  EndpointError,
  EndpointInput,
  EndpointOutput,
  EndpointResponse,
} from "@direttore/core";

type Input = EndpointInput<typeof api.identity.getUser>;
type Response = EndpointResponse<typeof api.identity.getUser>;
type Output = EndpointOutput<typeof api.identity.getUser>;
type ErrorResult = EndpointError<typeof api.identity.getUser>;
```

## Resolution order

For fetch endpoints, configuration resolves in this order:

1. Client defaults.
2. Mounted service defaults.
3. Endpoint configuration.
4. Per-call options.

Middleware runs client middleware, then service middleware, then endpoint middleware.

## License

[MIT](LICENSE)
