# direttore

Zero-dependency API orchestration primitives for TypeScript applications.

Direttore exists because organizing API calls across real projects is harder than it looks. Teams end up solving the same problems repeatedly, and inconsistently: scattered auth logic, error shapes that vary per endpoint, no clear home for middleware or status handling. Direttore gives those concerns a single, structured place to live, so the messy parts of talking to a backend stay out of your components and business logic.

## Very early stage

Direttore reflects patterns I've found useful, but it hasn't been tested against every edge case in the wild. APIs may change, rough edges exist, and feedback is genuinely welcome. Use it critically, for low-stakes projects, and if something feels wrong, _it probably is_.

Versions below `1.0.0` may include breaking changes between minor releases.

`Direttore` is a small TypeScript library for organizing API access around named endpoints. The core package gives each endpoint a consistent request builder, clear typing, dynamic auth hook, response parser/transform, status callback, middleware chain, cache key, and optional custom transport.

The library is deliberately framework-neutral. Use it with plain `fetch`, TanStack Query, framework stores, Node service layers, SDK clients, or custom transports.

## Core concepts

### Client

The client owns shared defaults:

```ts
const client = createApiClient({
  baseUrl: "https://api.example.com",
  headers: {
    "x-app": "web",
  },
});
```

You usually create one client per application or feature boundary.

### Service

A service is a named backend profile inside a client. Use services when an app calls multiple APIs, or when separate groups of endpoints need different base URLs, auth flows, middleware, or status handling.

```ts
const client = createApiClient({
  defaultService: "core",
  services: {
    core: {
      baseUrl: "https://api.example.com",
    },
    billing: {
      baseUrl: "https://billing.example.com",
    },
  },
});
```

Endpoints use `defaultService` unless they set `service`.

```ts
const getUser = client.endpoint({
  method: "GET",
  path: "/users/:id",
});

const getInvoice = client.endpoint({
  service: "billing",
  method: "GET",
  path: "/invoices/:id",
});
```

If an endpoint references an unknown service, `fetch()` rejects with a clear error.

### Endpoint

An endpoint describes one operation:

```ts
const createReserve = client.endpoint<CreateReserveInput, Reserve>({
  name: "reserves.create",
  method: "POST",
  path: "/reserves",
});
```

Each endpoint exposes:

- `fetch(input, options)` for direct execution.
- `cacheKey(input)` for TanStack Query and other cache libraries.

The endpoint generics are:

```ts
client.endpoint<TInput, TResponse, TOutput>();
```

`TResponse` is the decoded server response shape. `TOutput` is the app-facing value returned by `fetch()` and defaults to `TResponse`.

## Multi-Service configuration

Service configuration sits between client defaults and endpoint overrides.

```ts
const client = createApiClient({
  baseUrl: "https://fallback.example.com",
  headers: {
    "x-client": "web",
  },
  defaultService: "core",
  services: {
    core: {
      baseUrl: "https://api.example.com",
      headers: {
        "x-service": "core",
      },
    },
    billing: {
      baseUrl: "https://billing.example.com",
      headers: {
        "x-service": "billing",
      },
    },
  },
});
```

For fetch endpoints, request configuration is resolved in this order:

1. Client defaults.
2. Selected service defaults.
3. Endpoint config.
4. Per-call `fetch(input, options)` overrides.

Important details:

- `endpoint.baseUrl` overrides the service and client base URL.
- `service.fetch` overrides `client.fetch`.
- `service.getAuthHeaders` overrides `client.getAuthHeaders`.
- Middleware runs as client middleware, then service middleware, then endpoint middleware.
- Headers are merged in order, so later headers with the same name replace earlier values.

## Auth flows

Use `getAuthHeaders` as the primary auth integration point. It runs for every request and receives the request context, so tokens can be read, refreshed, omitted after logout, or varied by service at execution time.

```ts
const session = {
  getAccessToken: async () => "fresh-token",
};

const client = createApiClient({
  services: {
    identity: {
      baseUrl: "https://api.example.com",
      getAuthHeaders: async (ctx) => {
        const token = await session.getAccessToken();

        return token
          ? {
              Authorization: `Bearer ${token}`,
              "x-api-service": ctx.serviceName ?? "default",
            }
          : undefined;
      },
    },
  },
});
```

Endpoint `auth` is optional. Treat it as an app-defined policy hint that is exposed as `ctx.auth`, not as the token itself. Apps that use this hint can narrow it in their own auth helper without adding an auth generic to every endpoint type.

```ts
type AuthPolicy = {
  scope: string;
};

function getAuthScope(auth: unknown): string | undefined {
  return (
    typeof auth === "object" &&
    auth !== null &&
    "scope" in auth &&
    typeof auth.scope === "string"
  )
    ? auth.scope
    : undefined;
}

const client = createApiClient({
  getAuthHeaders: async (ctx) => {
    const token = await getTokenForScope(getAuthScope(ctx.auth));
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  },
});

const updateUser = client.endpoint<{ id: string; body: UpdateUser }, User>({
  method: "PATCH",
  path: "/users/:id",
  auth: {
    scope: "users:write",
  },
});
```

Use endpoint `headers`, per-call `headers`, or the `withHeaders()` middleware for non-auth headers such as trace IDs, tenant IDs, or feature flags. `withHeaders()` only injects headers into the current request; it does not know about sessions, token refresh, or auth policy. Keep credential lookup in `getAuthHeaders`.

## Request building

### Paths

Path params can use `:id` or `{id}` placeholders. Values are read from the input object first, then from `input.params`.

```ts
const getUser = client.endpoint<{ id: string }, User>({
  method: "GET",
  path: "/users/:id",
});

await getUser.fetch({ id: "123" });
```

### Query strings

Use `query` when query parameters need to be derived from input:

```ts
const searchUsers = client.endpoint<SearchUsersInput, User[]>({
  method: "GET",
  path: "/users",
  query: (input) => ({
    q: input.search,
    page: input.page,
  }),
});
```

If `query` is not provided, `direttore` uses `input.query` when it exists.

### Bodies

For methods that can carry a body, `direttore` uses `body(input)` when provided, then `input.body` when it exists. If neither is provided, no body is sent.

```ts
const createUser = client.endpoint<{ body: CreateUserBody }, User>({
  method: "POST",
  path: "/users",
});

await createUser.fetch({
  body: {
    name: "Ada",
  },
});
```

To intentionally serialize the full endpoint input, make that choice explicit:

```ts
const createEvent = client.endpoint<CreateEventInput, Event>({
  method: "POST",
  path: "/events",
  body: (input) => input,
});
```

Plain objects and arrays are serialized as JSON, and `content-type: application/json` is added when missing. Existing `BodyInit` values such as `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`, streams, and strings are passed through.

### Per-call options and aborting requests

`fetch(input, options)` accepts request-specific headers, `requestInit`, `meta`, and an `AbortSignal`.

```ts
const controller = new AbortController();

const promise = api.users.search.fetch(
  {
    query: {
      q: "ada",
    },
  },
  {
    signal: controller.signal,
    headers: {
      "x-request-id": crypto.randomUUID(),
    },
    requestInit: {
      credentials: "include",
    },
    meta: {
      source: "user-search",
    },
  },
);

controller.abort();

try {
  await promise;
} catch (error) {
  const aborted =
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError";

  if (!aborted) {
    throw error;
  }
}
```

Per-call `headers` are merged after client, service, endpoint, and auth headers, so they can intentionally override earlier values. `requestInit` is for fetch options such as `credentials`, `cache`, `mode`, `redirect`, `priority`, and similar fields; method, headers, body, and signal are controlled by the endpoint pipeline.

This fits naturally with TanStack Query, because query functions receive a signal:

```tsx
const user = useQuery({
  queryKey: api.users.get.cacheKey({ id }),
  queryFn: ({ signal }) => api.users.get.fetch({ id }, { signal }),
});
```

## Schemas

Endpoints can validate or transform input, decoded server responses, and final output with any schema-like object that exposes one of these methods:

- `parse(value)`
- `safeParse(value)`
- `validate(value)`

```ts
const endpoint = client.endpoint({
  input: createUserInputSchema,
  response: createUserResponseSchema,
  output: userSchema,
  method: "POST",
  path: "/users",
});
```

This works with libraries such as Zod, Valibot, Yup-style validators, or a custom object with the same method shape.

Schema failures reject with `SchemaValidationError`. The error includes `phase` set to `"input"`, `"response"`, or `"output"`, and `raw` contains the original schema-library error.

## Responses

By default:

- `204` and `205` responses resolve to `undefined`.
- JSON responses are parsed with `response.json()`.
- Other responses are parsed with `response.text()`.

Use `transformResponse` for the common case: mapping the decoded backend payload into the shape your frontend wants.

```ts
const getUser = client.endpoint<
  { id: string },
  { data: { id: string; full_name: string } },
  { id: string; name: string }
>({
  method: "GET",
  path: "/users/:id",
  transformResponse(response) {
    return {
      id: response.data.id,
      name: response.data.full_name,
    };
  },
});
```

If you want TypeScript to infer the final output from `transformResponse`, let the config carry the input and response types:

```ts
const getUser = client.endpoint({
  method: "GET",
  path: (input: { id: string }) => `/users/${input.id}`,
  transformResponse(response: { data: { id: string; full_name: string } }) {
    return {
      id: response.data.id,
      name: response.data.full_name,
    };
  },
});
```

Use `parseResponse` for low-level response handling when you need the raw `Response`, such as blobs, array buffers, streams, or custom content-type handling:

```ts
const downloadReport = client.endpoint<{ id: string }, Blob>({
  method: "GET",
  path: "/reports/:id",
  parseResponse: (response) => response.blob(),
});
```

`parseResponse` runs before response validation and transformation. The pipeline is:

```txt
Response -> parseResponse/default JSON parser -> response schema -> transformResponse -> output schema -> fetch result
```

Helper types are exported for sharing endpoint contracts:

```ts
import type {
  EndpointError,
  EndpointInput,
  EndpointOutput,
  EndpointResponse,
} from "direttore";

type UserInput = EndpointInput<typeof getUser>;
type UserResponse = EndpointResponse<typeof getUser>;
type UserOutput = EndpointOutput<typeof getUser>;
type UserError = EndpointError<typeof getUser>;
```

`EndpointResponse` is the decoded server response after `parseResponse` and response validation, before `transformResponse`. `EndpointOutput` is the final value returned by `fetch()`.

## Errors

`direttore` leaves HTTP and schema errors in the caller's hands, but normalizes fetch transport failures that do not produce a `Response`.

- Non-2xx fetch responses reject with the original `Response`, unless an `onStatus` handler returns a normalized error shape.
- Offline fetch failures reject with an `ApiError` using `code: "CLIENT_OFFLINE"`.
- Unreachable service fetch failures reject with an `ApiError` using `code: "SERVICE_UNREACHABLE"`.
- Aborted requests reject with the original abort error from `fetch`.
- Schema validation failures reject with `SchemaValidationError`.
- Custom `request` handler failures reject with the original thrown error.

```ts
import { SchemaValidationError } from "direttore";

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

try {
  await api.reserves.create.fetch(input);
} catch (error) {
  if (error instanceof Response) {
    const body = await error.clone().json().catch(() => undefined);
    console.log(error.status, body);
  } else if (error instanceof SchemaValidationError) {
    console.log(error.phase, error.raw);
  } else if (isAbortError(error)) {
    console.log("request cancelled");
  }
}
```

Backend-specific error parsing belongs in application code, where the backend contract and user-facing copy live.

Transport failures do not have a `Response`, so `onStatus` does not run for offline, DNS, connection refused, or CORS failures. Use `onTransportError` when your app wants custom `ApiError` messages or codes for fetch transport failures. Aborted requests pass through unchanged and do not run `onTransportError`.

```ts
const client = createApiClient({
  onTransportError: {
    clientOffline: ({ error }) => ({
      message: "You appear to be offline.",
      code: "CLIENT_OFFLINE",
      raw: error,
    }),
    serviceUnreachable: ({ error, ctx }) => ({
      message: `${ctx.serviceName ?? "API"} is unreachable.`,
      code: "SERVICE_UNREACHABLE",
      raw: error,
    }),
  },
});
```

`onTransportError` can be set on the client, service, or endpoint. More specific handlers override less specific handlers, following the same client -> service -> endpoint order as `onStatus`. Transport errors are handled by `endpoint.fetch()` after middleware has had a chance to observe or retry the failed request. Returning an `Error` throws that exact error; returning a plain normalized object throws an `ApiError`.

```ts
const client = createApiClient({
  onTransportError: {
    serviceUnreachable: () => ({
      message: "The API is temporarily unavailable.",
      code: "API_UNAVAILABLE",
    }),
  },
  services: {
    billing: {
      baseUrl: "https://billing.example.com",
      onTransportError: {
        serviceUnreachable: () => ({
          message: "Billing is temporarily unavailable.",
          code: "BILLING_UNAVAILABLE",
        }),
      },
    },
  },
});

const getInvoice = client.endpoint({
  service: "billing",
  method: "GET",
  path: "/invoices/:id",
  onTransportError: {
    serviceUnreachable: () => ({
      message: "Invoice lookup is temporarily unavailable.",
      code: "INVOICE_LOOKUP_UNAVAILABLE",
    }),
  },
});
```

## Status callbacks

Use `onStatus` for status-driven side effects that should live next to the API service configuration rather than every call site.

If a status handler reads the response body, read from `response.clone()` so the caller can still read the original response.

```ts
const client = createApiClient({
  services: {
    identity: {
      baseUrl: "https://api.example.com",
      getAuthHeaders: async () => ({
        Authorization: `Bearer ${await session.getAccessToken()}`,
      }),
      onStatus: {
        401: async ({ ctx }) => {
          await session.invalidate();
          authEvents.emit("expired", {
            service: ctx.serviceName,
          });
        },
        403: () => {
          accessDeniedStore.show();
        },
        402: () => ({
          message: "A paid plan is required",
          code: "PAYMENT_REQUIRED",
          status: 402,
        }),
        default: ({ response }) => {
          metrics.count("api.error", {
            status: response.status,
          });
        },
      },
    },
  },
});
```

Status handlers receive `{ response, ctx }`. Return `undefined` for side effects only, or return a normalized error shape to replace the thrown response with an `ApiError`.

Resolution order follows the rest of the config model:

1. Client `onStatus`.
2. Selected service `onStatus`.
3. Endpoint `onStatus`.

Handlers are merged by status code, so endpoint handlers override service handlers for the same status, and service handlers override client handlers. `default` is used only when no status-specific handler exists.

## Middleware

Middleware wraps the transport and can observe or change the request context before continuing.

```ts
const addTraceId = withHeaders(async () => ({
  "x-trace-id": crypto.randomUUID(),
}));

const endpoint = client.endpoint({
  method: "POST",
  path: "/events",
  middleware: [addTraceId, retry({ attempts: 2 })],
});
```

Built-in middleware helpers:

- `withHeaders(getHeaders)` merges arbitrary headers into the outgoing request.
- `retry(options)` retries failed requests with exponential backoff and full jitter by default.
- `logger(options)` logs request, response, and error events. For example, `logger({ prefix: "api" })` changes the default `direttore` log prefix.

`retry()` starts with a 100ms base delay and caps the exponential delay at 30s before jitter is applied. Supplying `delay` as a number or function overrides the default delay. Set `jitter: true` to randomize a custom delay, or `jitter: false` to keep the default exponential delay deterministic.

Middleware is transport-agnostic. It wraps fetch-based endpoints and endpoints with custom `request` handlers.

## Custom requests

Use `request` when an endpoint should call an SDK, browser API, existing client, or non-fetch transport.

```ts
const createReserve = client.endpoint<CreateReserveInput, Reserve>({
  name: "reserves.create",
  request: async ({ input }) => customApi.post("/reserves", input.body),
});
```

Custom request results still pass through response validation, `transformResponse`, and output validation. Errors thrown by the custom request are rethrown unchanged.

## Node service layer

Direttore works in Node runtimes with global `fetch` support. The package targets Node `>=18.17`.

```ts
import { ApiError, createApiClient, retry } from "direttore";

type User = {
  id: string;
  name: string;
};

type UserResponse = {
  data: {
    id: string;
    full_name: string;
  };
};

const client = createApiClient({
  baseUrl: process.env.API_URL ?? "https://api.example.com",
  getAuthHeaders: () =>
    process.env.API_TOKEN
      ? {
          Authorization: `Bearer ${process.env.API_TOKEN}`,
        }
      : undefined,
  middleware: [retry({ attempts: 1 })],
});

const getUser = client.endpoint<{ id: string }, UserResponse, User>({
  name: "users.get",
  method: "GET",
  path: "/users/:id",
  transformResponse: (response) => ({
    id: response.data.id,
    name: response.data.full_name,
  }),
  onStatus: {
    404: () => ({
      message: "User not found.",
      code: "USER_NOT_FOUND",
      status: 404,
    }),
  },
});

export async function loadUser(id: string): Promise<User | undefined> {
  try {
    return await getUser.fetch({ id });
  } catch (error) {
    if (error instanceof ApiError && error.code === "USER_NOT_FOUND") {
      return undefined;
    }

    throw error;
  }
}
```

## TanStack Query

`direttore` does not provide a TanStack Query adapter. Use TanStack Query alongside core endpoints:

```tsx
import { useQuery } from "@tanstack/react-query";

function UserProfile({ id }: { id: string }) {
  const input = { id };
  const user = useQuery({
    queryKey: api.users.get.cacheKey(input),
    queryFn: () => api.users.get.fetch(input),
    staleTime: 30_000,
  });

  return <pre>{JSON.stringify(user.data, null, 2)}</pre>;
}
```

Mutations use the endpoint input as mutation variables:

```tsx
import { useMutation } from "@tanstack/react-query";

function CreateUserButton() {
  const mutation = useMutation({
    mutationFn: api.users.create.fetch,
  });

  return (
    <button
      onClick={() =>
        mutation.mutate({
          body: {
            name: "Ada",
          },
        })
      }
    >
      Create
    </button>
  );
}
```

The generated cache key is:

- `[nameOrPath, input]` for endpoints without a selected service.
- `[serviceName, nameOrPath, input]` for endpoints with `service` or `defaultService`.

When `input` is `undefined`, it remains in the key. For example, a named endpoint without a service produces `["session.get", undefined]`, and a service endpoint produces `["core", "session.get", undefined]`. TanStack Query accepts `undefined` values in query keys; set a custom `cacheKey` if you prefer to omit it.

Set `cacheKey(input)` on the endpoint when you need a custom cache key.

## Request Context

Factories and middleware receive an `EndpointRequestContext`:

```ts
{
  input,
  method,
  path,
  serviceName,
  service,
  auth,
  meta,
  endpointName,
  request,
  config,
  client,
}
```

`request.url` and `request.init` are mutable. Middleware can update headers, URLs, request init options, or short-circuit by returning without calling `next()`.

## Recommended project shape

A practical frontend application usually ends up clearer when the API layer is a small module tree instead of one large file. This example uses Vite-style environment variables, but the same shape works with any app runtime:

```txt
src/api/client.ts
src/api/users.ts
src/api/index.ts
src/features/users/useUser.tsx
```

Define the client once. Put shared auth, status handling, retry, logging, and transport error defaults there:

```ts
// src/api/client.ts
import { createApiClient, logger, retry } from "direttore";

type ApiMeta = {
  source?: string;
};

type AuthPolicy = {
  scope?: string;
};

const session = {
  async getAccessToken(_scope: string | undefined) {
    return localStorage.getItem("access_token");
  },
  async invalidate() {
    localStorage.removeItem("access_token");
  },
};

function getAuthScope(auth: unknown): string | undefined {
  return isAuthPolicy(auth) ? auth.scope : undefined;
}

function isAuthPolicy(auth: unknown): auth is AuthPolicy {
  return (
    typeof auth === "object" &&
    auth !== null &&
    "scope" in auth &&
    typeof auth.scope === "string"
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export const client = createApiClient<ApiMeta>({
  defaultService: "core",
  onTransportError: {
    clientOffline: ({ error }) => ({
      message: "You appear to be offline.",
      code: "CLIENT_OFFLINE",
      raw: error,
    }),
    serviceUnreachable: ({ error, ctx }) => ({
      message: `${ctx.serviceName ?? "API"} is unreachable.`,
      code: "SERVICE_UNREACHABLE",
      raw: error,
    }),
  },
  services: {
    core: {
      baseUrl: import.meta.env.VITE_API_URL,
      getAuthHeaders: async (ctx) => {
        const token = await session.getAccessToken(getAuthScope(ctx.auth));
        return token ? { Authorization: `Bearer ${token}` } : undefined;
      },
      onStatus: {
        401: async () => {
          await session.invalidate();
          window.dispatchEvent(new CustomEvent("auth:expired"));
        },
        403: () => ({
          message: "You do not have access to this resource.",
          code: "FORBIDDEN",
          status: 403,
        }),
      },
    },
  },
  middleware: [
    logger(),
    retry({
      attempts: 2,
      shouldRetry(error) {
        if (isAbortError(error)) return false;
        if (error instanceof Response) return error.status >= 500;
        return true;
      },
    }),
  ],
});
```

Feature files own their endpoint shapes and response mapping:

```ts
// src/api/users.ts
import { client } from "./client";

export type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
};

type UserResponse = {
  data: {
    id: string;
    full_name: string;
    email: string;
    role: "admin" | "member";
  };
};

type SearchUsersResponse = {
  data: UserResponse["data"][];
};

type UpdateUserInput = {
  id: string;
  body: {
    fullName?: string;
    role?: "admin" | "member";
  };
};

function toUser(response: UserResponse): User {
  return {
    id: response.data.id,
    name: response.data.full_name,
    email: response.data.email,
    role: response.data.role,
  };
}

export const usersApi = {
  get: client.endpoint<{ id: string }, UserResponse, User>({
    name: "users.get",
    method: "GET",
    path: "/users/:id",
    auth: {
      scope: "users:read",
    },
    transformResponse: toUser,
    onStatus: {
      404: () => ({
        message: "User not found.",
        code: "USER_NOT_FOUND",
        status: 404,
      }),
    },
  }),
  search: client.endpoint<
    { query: { q?: string; page?: number } },
    SearchUsersResponse,
    User[]
  >({
    name: "users.search",
    method: "GET",
    path: "/users",
    auth: {
      scope: "users:read",
    },
    transformResponse: (response) =>
      response.data.map((user) =>
        toUser({
          data: user,
        }),
      ),
  }),
  update: client.endpoint<UpdateUserInput, UserResponse, User>({
    name: "users.update",
    method: "PATCH",
    path: "/users/:id",
    auth: {
      scope: "users:write",
    },
    body: (input) => input.body,
    transformResponse: toUser,
  }),
};
```

Export a stable API object for application code:

```ts
// src/api/index.ts
import { usersApi } from "./users";

export { client } from "./client";
export { usersApi } from "./users";
export type { User } from "./users";

export const api = {
  users: usersApi,
} as const;
```

Use endpoints from features without rebuilding URLs, headers, auth, or error parsing at the call site:

```tsx
// src/features/users/useUser.tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "direttore";
import { api } from "../../api";

export function useUser(id: string) {
  return useQuery({
    queryKey: api.users.get.cacheKey({ id }),
    queryFn: ({ signal }) =>
      api.users.get.fetch(
        { id },
        {
          signal,
          meta: {
            source: "user-profile",
          },
        },
      ),
    retry(failureCount, error) {
      if (error instanceof ApiError && error.status && error.status < 500) {
        return false;
      }

      return failureCount < 2;
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.users.update.fetch,
    onSuccess(user) {
      queryClient.setQueryData(api.users.get.cacheKey({ id: user.id }), user);
    },
  });
}
```

This keeps base URLs, auth flows, abort handling, status callbacks, transport error handling, and cross-cutting behavior centralized while leaving each feature file close to the endpoints it owns.
