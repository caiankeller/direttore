import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  ApiError,
  HttpResponseError,
  SchemaValidationError,
  createApiClient,
  defineEndpoint,
  defineService,
  endpoint,
  logger,
  withHeaders,
} from "../src";
import type {
  EndpointError,
  EndpointInput,
  EndpointOutput,
  EndpointResponse,
} from "../src";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("endpoint", () => {
  it("executes a custom request handler", async () => {
    const getUser = endpoint<{ id: string }, { id: string; name: string }>({
      name: "test.endpoint",
      request: async ({ input }) => ({
        id: input.id,
        name: "Ada",
      }),
    });

    await expect(getUser.fetch({ id: "1" })).resolves.toEqual({
      id: "1",
      name: "Ada",
    });
  });

  it("uses fetch orchestration with auth, body serialization, and path params", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "reserve-1" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const client = createApiClient({
      baseUrl: "https://api.example.com",
      fetch: fetchMock as typeof fetch,
      getAuthHeaders: async () => ({
        Authorization: "Bearer test-token",
      }),
    });

    const createReserve = client.endpoint<
      { id: string; body: { slotId: string } },
      { id: string }
    >({
      name: "test.endpoint",
      method: "POST",
      path: "/users/:id/reserves",
      auth: "protected",
    });

    await expect(
      createReserve.fetch({ id: "u1", body: { slotId: "s1" } }),
    ).resolves.toEqual({ id: "reserve-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/users/u1/reserves",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ slotId: "s1" }),
      }),
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Headers).get("authorization")).toBe("Bearer test-token");
    expect((init?.headers as Headers).get("content-type")).toBe("application/json");
  });

  it("lets per-call headers override auth and endpoint headers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const client = createApiClient({
      baseUrl: "https://api.example.com",
      fetch: fetchMock as typeof fetch,
      getAuthHeaders: async () => ({
        Authorization: "Bearer auth-token",
      }),
    });

    const getUser = client.endpoint<undefined, { ok: boolean }>({
      name: "test.endpoint",
      method: "GET",
      path: "/users/123",
      headers: {
        "x-shared": "endpoint",
      },
    });

    await expect(
      getUser.fetch(undefined, {
        headers: {
          Authorization: "Bearer per-call-token",
          "x-shared": "per-call",
        },
      }),
    ).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Headers).get("authorization")).toBe(
      "Bearer per-call-token",
    );
    expect((init?.headers as Headers).get("x-shared")).toBe("per-call");
  });

  it("does not serialize the entire input when no body is configured", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const client = createApiClient({
      baseUrl: "https://api.example.com",
      fetch: fetchMock as typeof fetch,
    });

    const touchUser = client.endpoint<
      { params: { id: string }; query: { expand: string }; internalTraceId: string },
      { ok: boolean }
    >({
      name: "test.endpoint",
      method: "POST",
      path: "/users/:id/touch",
    });

    await expect(
      touchUser.fetch({
        params: { id: "u1" },
        query: { expand: "profile" },
        internalTraceId: "secret",
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/users/u1/touch?expand=profile",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Headers).get("content-type")).toBeNull();
  });

  it("passes abort signals to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const client = createApiClient({
      baseUrl: "https://api.example.com",
      fetch: fetchMock as typeof fetch,
    });

    const getUser = client.endpoint<undefined, { ok: boolean }>({
      name: "test.endpoint",
      method: "GET",
      path: "/users/123",
    });

    await expect(
      getUser.fetch(undefined, {
        signal: controller.signal,
      }),
    ).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBe(controller.signal);
  });

  it("routes named services through their own base URLs and auth flows", async () => {
    const identityFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "u1" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const billingFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "invoice-1" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const identity = defineService("identity", {
      baseUrl: "https://identity.example.com",
      fetch: identityFetch as typeof fetch,
      getAuthHeaders: async (ctx) =>
        ctx.auth === "session"
          ? {
              Authorization: "Bearer user-token",
            }
          : undefined,
      endpoints: {
        getUser: defineEndpoint<{ id: string }, { id: string }>({
          method: "GET",
          path: "/users/:id",
          auth: "session",
        }),
      },
    });

    const billing = defineService("billing", {
      baseUrl: "https://billing.example.com",
      fetch: billingFetch as typeof fetch,
      getAuthHeaders: async (ctx) =>
        ctx.auth === "api-key"
          ? {
              "x-api-key": "billing-key",
            }
          : undefined,
      endpoints: {
        getInvoice: defineEndpoint<{ id: string }, { id: string }>({
          method: "GET",
          path: "/invoices/:id",
          auth: "api-key",
        }),
      },
    });

    const api = createApiClient().mount({ identity, billing });

    await expect(api.identity.getUser.fetch({ id: "u1" })).resolves.toEqual({
      id: "u1",
    });
    await expect(api.billing.getInvoice.fetch({ id: "invoice-1" })).resolves.toEqual({
      id: "invoice-1",
    });

    expect(identityFetch).toHaveBeenCalledWith(
      "https://identity.example.com/users/u1",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(billingFetch).toHaveBeenCalledWith(
      "https://billing.example.com/invoices/invoice-1",
      expect.objectContaining({
        method: "GET",
      }),
    );

    const [, identityInit] = identityFetch.mock.calls[0]!;
    const [, billingInit] = billingFetch.mock.calls[0]!;
    expect((identityInit?.headers as Headers).get("authorization")).toBe(
      "Bearer user-token",
    );
    expect((billingInit?.headers as Headers).get("x-api-key")).toBe("billing-key");
  });

  it("applies service defaults between client and endpoint configuration", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const client = createApiClient({
      baseUrl: "https://fallback.example.com",
      headers: {
        "x-client": "client",
        "x-shared": "client",
      },
    });

    const reports = defineService("reports", {
      baseUrl: "https://reports.example.com",
      fetch: fetchMock as typeof fetch,
      headers: {
        "x-service": "reports",
        "x-shared": "service",
      },
      middleware: [
        async (_ctx, next) => {
          calls.push("service-before");
          const result = await next();
          calls.push("service-after");
          return result;
        },
      ],
      endpoints: {
        summary: defineEndpoint<undefined, { ok: boolean }>({
          method: "GET",
          path: "/summary",
          headers: {
            "x-endpoint": "summary",
            "x-shared": "endpoint",
          },
        }),
      },
    });
    const api = client.mount({ reports });

    await expect(api.reports.summary.fetch(undefined)).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://reports.example.com/summary",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(calls).toEqual(["service-before", "service-after"]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Headers).get("x-client")).toBe("client");
    expect((init?.headers as Headers).get("x-service")).toBe("reports");
    expect((init?.headers as Headers).get("x-endpoint")).toBe("summary");
    expect((init?.headers as Headers).get("x-shared")).toBe("endpoint");
  });

  it("mounts service endpoints with inferred endpoint names and cache keys", () => {
    const identity = defineService("identity", {
      baseUrl: "https://identity.example.com",
      endpoints: {
        getSession: defineEndpoint<undefined, unknown>({
          method: "GET",
          path: "/session",
        }),
        customName: defineEndpoint<undefined, unknown>({
          name: "identity.custom",
          method: "GET",
          path: "/custom",
        }),
      },
    });
    const api = createApiClient().mount({ identity });

    expect(api.identity.getSession.config.name).toBe("identity.getSession");
    expect(api.identity.getSession.cacheKey()).toEqual([
      "identity",
      "identity.getSession",
      undefined,
    ]);
    expect(api.identity.customName.config.name).toBe("identity.custom");
  });

  it("runs service status handlers before rethrowing HTTP response errors", async () => {
    const events: string[] = [];
    const response = new Response(JSON.stringify({ message: "Session expired" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    });
    const identity = defineService("identity", {
      baseUrl: "https://identity.example.com",
      fetch: (async () => response) as typeof fetch,
      onStatus: {
        401: async ({ response, body, ctx }) => {
          events.push(
            `${ctx.serviceName}:${response.status}:${(body as { message: string }).message}`,
          );
        },
      },
      endpoints: {
        getSession: defineEndpoint<undefined, unknown>({
          method: "GET",
          path: "/session",
        }),
      },
    });
    const api = createApiClient().mount({ identity });

    const result = api.identity.getSession.fetch(undefined);
    await expect(result).rejects.toBeInstanceOf(HttpResponseError);
    await expect(result).rejects.toMatchObject({
      status: 401,
      body: {
        message: "Session expired",
      },
    });
    expect(events).toEqual(["identity:401:Session expired"]);
  });

  it("uses the most specific status handler and can replace the thrown error", async () => {
    const events: string[] = [];
    const client = createApiClient({
      fetch: (async () =>
        new Response(JSON.stringify({ message: "Plan limit reached" }), {
          status: 402,
          headers: {
            "content-type": "application/json",
          },
        })) as typeof fetch,
      onStatus: {
        default: () => {
          events.push("client-default");
        },
        402: () => {
          events.push("client-402");
          return {
            message: "Upgrade required",
            code: "PAYMENT_REQUIRED",
            status: 402,
          };
        },
      },
    });

    const createReport = client.endpoint<undefined, unknown>({
      name: "test.endpoint",
      method: "POST",
      path: "/reports",
      onStatus: {
        402: () => {
          events.push("endpoint-402");
          return {
            message: "Reports require a paid plan",
            code: "REPORTS_REQUIRE_PAID_PLAN",
            status: 402,
          };
        },
      },
    });

    const result = createReport.fetch(undefined);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      message: "Reports require a paid plan",
      code: "REPORTS_REQUIRE_PAID_PLAN",
      status: 402,
      raw: {
        message: "Plan limit reached",
      },
    });
    expect(events).toEqual(["endpoint-402"]);
  });

  it("falls back to default status handlers when no status-specific handler exists", async () => {
    const events: string[] = [];
    const billing = defineService("billing", {
      baseUrl: "https://billing.example.com",
      fetch: (async () =>
        new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
          },
        })) as typeof fetch,
      onStatus: {
        default: ({ response }) => {
          events.push(`default:${response.status}`);
          return {
            message: "Billing request blocked",
            code: "BILLING_BLOCKED",
            status: response.status,
          };
        },
      },
      endpoints: {
        getInvoice: defineEndpoint<undefined, unknown>({
          method: "GET",
          path: "/invoices/1",
        }),
      },
    });
    const api = createApiClient().mount({ billing });

    await expect(api.billing.getInvoice.fetch(undefined)).rejects.toMatchObject({
      message: "Billing request blocked",
      code: "BILLING_BLOCKED",
      status: 403,
    });
    expect(events).toEqual(["default:403"]);
  });

  it("throws HTTP response errors with parsed bodies by default", async () => {
    const response = new Response(
      JSON.stringify({
        message: "Invalid reserve",
        code: "INVALID_RESERVE",
        fields: {
          slotId: "Unavailable",
        },
      }),
      {
        status: 422,
        headers: {
          "content-type": "application/json",
        },
      },
    );
    const client = createApiClient({
      fetch: (async () => response) as typeof fetch,
    });

    const createReserve = client.endpoint({
      name: "test.endpoint",
      method: "POST",
      path: "/reserves",
    });

    const result = createReserve.fetch({ body: { slotId: "s1" } });
    await expect(result).rejects.toBeInstanceOf(HttpResponseError);
    await expect(result).rejects.toMatchObject({
      status: 422,
      response,
      body: {
        message: "Invalid reserve",
        code: "INVALID_RESERVE",
        fields: {
          slotId: "Unavailable",
        },
      },
    });
  });

  it("lets apps map framework-specific error bodies", async () => {
    const fastApiError = {
      detail: [
        {
          loc: ["body", "email"],
          msg: "value is not a valid email",
        },
      ],
    };
    const client = createApiClient({
      fetch: (async () =>
        new Response(JSON.stringify(fastApiError), {
          status: 422,
          headers: {
            "content-type": "application/json",
          },
        })) as typeof fetch,
      onStatus: {
        422: ({ body, response }) => {
          const issues =
            (body as { detail?: { loc: unknown[]; msg: string }[] }).detail ?? [];

          return {
            message: "Validation failed.",
            code: "VALIDATION_ERROR",
            status: response.status,
            fields: Object.fromEntries(
              issues.map((issue) => [String(issue.loc.at(-1)), issue.msg]),
            ),
            raw: body,
          };
        },
      },
    });

    const createUser = client.endpoint({
      name: "users.create",
      method: "POST",
      path: "/users",
    });

    const result = createUser.fetch({ body: { email: "not-email" } });
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      message: "Validation failed.",
      code: "VALIDATION_ERROR",
      status: 422,
      fields: {
        email: "value is not a valid email",
      },
      raw: fastApiError,
    });
  });

  it("lets endpoints override error response parsing", async () => {
    const client = createApiClient({
      fetch: (async () =>
        new Response("error=invalid_token&error_description=Bad+token", {
          status: 401,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
        })) as typeof fetch,
    });

    const getSession = client.endpoint({
      name: "session.get",
      method: "GET",
      path: "/session",
      parseErrorResponse: async (response) => {
        return Object.fromEntries(new URLSearchParams(await response.text()));
      },
      onStatus: {
        401: ({ body, response }) => {
          const errorBody = body as {
            error?: string;
            error_description?: string;
          };

          return {
            message: errorBody.error_description ?? "Unauthorized.",
            code: errorBody.error,
            status: response.status,
          };
        },
      },
    });

    await expect(getSession.fetch(undefined)).rejects.toMatchObject({
      message: "Bad token",
      code: "invalid_token",
      status: 401,
      raw: {
        error: "invalid_token",
        error_description: "Bad token",
      },
    });
  });

  it("transforms typed decoded responses into app-facing output", async () => {
    type UserResponse = {
      data: {
        id: string;
        full_name: string;
      };
    };

    const client = createApiClient({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: {
              id: "u1",
              full_name: "Ada Lovelace",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        )) as typeof fetch,
    });

    const getUser = client.endpoint({
      name: "test.endpoint",
      method: "GET",
      path: (input: { id: string }) => `/users/${input.id}`,
      transformResponse(response: UserResponse) {
        expectTypeOf(response).toEqualTypeOf<UserResponse>();

        return {
          id: response.data.id,
          name: response.data.full_name,
        };
      },
    });

    await expect(getUser.fetch({ id: "u1" })).resolves.toEqual({
      id: "u1",
      name: "Ada Lovelace",
    });

    expectTypeOf<EndpointInput<typeof getUser>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<EndpointResponse<typeof getUser>>().toEqualTypeOf<UserResponse>();
    expectTypeOf<EndpointOutput<typeof getUser>>().toEqualTypeOf<{
      id: string;
      name: string;
    }>();
    expectTypeOf<EndpointError<typeof getUser>>().toEqualTypeOf<never>();
  });

  it("contextually types normalized handler results", () => {
    createApiClient({
      onStatus: {
        500: ({ response, body }) => {
          expectTypeOf(response).toEqualTypeOf<Response>();
          expectTypeOf(body).toEqualTypeOf<unknown>();

          return {
            message: "Server error",
            code: "SERVER_ERROR",
            status: response.status,
          };
        },
        // @ts-expect-error normalized status handler objects require a message
        502: () => ({ code: "BAD_GATEWAY", status: 502 }),
      },
      onTransportError: {
        clientOffline: ({ error, kind }) => {
          expectTypeOf(error).toEqualTypeOf<unknown>();
          expectTypeOf(kind).toEqualTypeOf<"clientOffline">();

          return {
            message: "You appear to be offline.",
            code: "CLIENT_OFFLINE",
            raw: error,
          };
        },
        // @ts-expect-error normalized transport handler objects require a message
        serviceUnreachable: () => ({ code: "SERVICE_UNREACHABLE" }),
      },
    });
  });

  it("lets explicit endpoint error types use custom handler results", () => {
    type DomainError = {
      reason: string;
      retriable: boolean;
    };

    const client = createApiClient();
    const endpointWithCustomError = client.endpoint<
      undefined,
      unknown,
      unknown,
      DomainError
    >({
      name: "test.endpoint",
      request: async () => undefined,
      onStatus: {
        500: () => ({
          reason: "quota",
          retriable: false,
        }),
      },
      onTransportError: {
        serviceUnreachable: () => ({
          reason: "service-unreachable",
          retriable: true,
        }),
      },
    });

    expectTypeOf<EndpointError<typeof endpointWithCustomError>>().toEqualTypeOf<
      DomainError
    >();
  });

  it("keeps parseResponse as a low-level response parser", async () => {
    const client = createApiClient({
      fetch: (async () =>
        new Response("report", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        })) as typeof fetch,
    });

    const downloadReport = client.endpoint<undefined, Blob>({
      name: "test.endpoint",
      method: "GET",
      path: "/reports/1",
      parseResponse: (response) => response.blob(),
    });

    const blob = await downloadReport.fetch(undefined);

    expect(blob).toBeInstanceOf(Blob);
    await expect(blob.text()).resolves.toBe("report");
    expectTypeOf<EndpointOutput<typeof downloadReport>>().toEqualTypeOf<Blob>();
  });

  it("throws input schema failures as schema validation errors", async () => {
    const rawSchemaError = {
      issues: [{ path: ["name"], message: "Required" }],
    };
    const request = vi.fn(async () => ({ ok: true }));

    const createUser = endpoint<{ name?: string }, { ok: boolean }>({
      name: "test.endpoint",
      input: {
        parse() {
          throw rawSchemaError;
        },
      },
      request,
    });

    await expect(createUser.fetch({})).rejects.toMatchObject({
      name: "SchemaValidationError",
      message: "Endpoint input validation failed",
      phase: "input",
      raw: rawSchemaError,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("throws response schema failures as schema validation errors", async () => {
    const rawSchemaError = {
      issues: [{ path: ["id"], message: "Expected string" }],
    };
    const client = createApiClient({
      fetch: (async () =>
        new Response(JSON.stringify({ id: 123 }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })) as typeof fetch,
    });

    const getUser = client.endpoint<undefined, { id: string }>({
      name: "test.endpoint",
      method: "GET",
      path: "/users/1",
      response: {
        safeParse() {
          return {
            success: false,
            error: rawSchemaError,
          };
        },
      },
    });

    await expect(getUser.fetch(undefined)).rejects.toMatchObject({
      name: "SchemaValidationError",
      message: "Endpoint response validation failed",
      phase: "response",
      raw: rawSchemaError,
    });
  });

  it("keeps schema validation errors available to callers", async () => {
    const rawSchemaError = {
      issues: [{ path: ["name"], message: "Required" }],
    };

    const createUser = endpoint<{ name?: string }, { ok: boolean }>({
      name: "test.endpoint",
      input: {
        validate() {
          throw rawSchemaError;
        },
      },
      request: async () => ({ ok: true }),
    });

    await expect(createUser.fetch({})).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("normalizes offline fetch failures by default", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const error = new TypeError("Failed to fetch");

    const client = createApiClient({
      fetch: vi.fn(async () => {
        throw error;
      }) as unknown as typeof fetch,
    });

    const getUser = client.endpoint({
      name: "test.endpoint",
      method: "GET",
      path: "/users/123",
    });

    const result = getUser.fetch(undefined);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      code: "CLIENT_OFFLINE",
      message: "Client is offline.",
      raw: error,
    });
  });

  it("normalizes unreachable service fetch failures by default", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const error = new TypeError("fetch failed");

    const client = createApiClient({
      fetch: vi.fn(async () => {
        throw error;
      }) as unknown as typeof fetch,
    });

    const getUser = client.endpoint({
      name: "test.endpoint",
      method: "GET",
      path: "/users/123",
    });

    const result = getUser.fetch(undefined);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      code: "SERVICE_UNREACHABLE",
      message: "Service is unreachable.",
      raw: error,
    });
  });

  it("lets transport error handlers customize normalized errors", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const error = new TypeError("fetch failed");

    const client = createApiClient({
      fetch: vi.fn(async () => {
        throw error;
      }) as unknown as typeof fetch,
      onTransportError: {
        serviceUnreachable: ({ error }) => ({
          message: "Search is temporarily unavailable.",
          code: "SEARCH_UNAVAILABLE",
          raw: error,
        }),
      },
    });

    const searchUsers = client.endpoint({
      name: "test.endpoint",
      method: "GET",
      path: "/users",
    });

    const result = searchUsers.fetch(undefined);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      code: "SEARCH_UNAVAILABLE",
      message: "Search is temporarily unavailable.",
      raw: error,
    });
  });

  it("lets transport error handlers throw custom error classes through endpoint fetch", async () => {
    class SearchUnavailableError extends Error {
      constructor() {
        super("Search is offline");
        this.name = "SearchUnavailableError";
      }
    }

    vi.stubGlobal("navigator", { onLine: true });
    const customError = new SearchUnavailableError();

    const client = createApiClient({
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      onTransportError: {
        serviceUnreachable: () => customError,
      },
    });

    const searchUsers = client.endpoint({
      name: "test.endpoint",
      method: "GET",
      path: "/users",
    });

    await expect(searchUsers.fetch(undefined)).rejects.toBe(customError);
  });

  it("lets services and endpoints override transport error handlers", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const error = new TypeError("fetch failed");

    const client = createApiClient({
      onTransportError: {
        serviceUnreachable: () => ({
          message: "Client fallback",
          code: "CLIENT_FALLBACK",
        }),
      },
    });

    const core = defineService("core", {
      baseUrl: "https://api.example.com",
      fetch: vi.fn(async () => {
        throw error;
      }) as unknown as typeof fetch,
      onTransportError: {
        serviceUnreachable: () => ({
          message: "Core API unavailable",
          code: "CORE_UNAVAILABLE",
        }),
      },
      endpoints: {
        serviceOnly: defineEndpoint({
          method: "GET",
          path: "/service-only",
        }),
        endpointOverride: defineEndpoint({
          method: "GET",
          path: "/endpoint-override",
          onTransportError: {
            serviceUnreachable: () => ({
              message: "Endpoint unavailable",
              code: "ENDPOINT_UNAVAILABLE",
            }),
          },
        }),
      },
    });
    const api = client.mount({ core });

    await expect(api.core.serviceOnly.fetch(undefined)).rejects.toMatchObject({
      code: "CORE_UNAVAILABLE",
      message: "Core API unavailable",
    });
    await expect(api.core.endpointOverride.fetch(undefined)).rejects.toMatchObject({
      code: "ENDPOINT_UNAVAILABLE",
      message: "Endpoint unavailable",
    });
  });

  it("throws abort failures unchanged", async () => {
    const error = new DOMException("Aborted", "AbortError");

    const client = createApiClient({
      fetch: vi.fn(async () => {
        throw error;
      }) as unknown as typeof fetch,
    });

    const getUser = client.endpoint({
      name: "test.endpoint",
      method: "GET",
      path: "/users/123",
    });

    await expect(getUser.fetch(undefined)).rejects.toBe(error);
  });

  it("throws custom request errors unchanged", async () => {
    const error = new Error("Backend-specific shape");
    const createReserve = endpoint({
      name: "test.endpoint",
      request: async () => {
        throw error;
      },
    });

    await expect(createReserve.fetch(undefined)).rejects.toBe(error);
  });

  it("runs middleware around the transport", async () => {
    const calls: string[] = [];

    const getUser = endpoint<undefined, string>({
      name: "test.endpoint",
      request: async () => {
        calls.push("request");
        return "ok";
      },
      middleware: [
        async (_ctx, next) => {
          calls.push("before");
          const result = await next();
          calls.push("after");
          return result;
        },
      ],
    });

    await expect(getUser.fetch(undefined)).resolves.toBe("ok");
    expect(calls).toEqual(["before", "request", "after"]);
  });

  it("can inject arbitrary headers from middleware", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const client = createApiClient({
      baseUrl: "https://api.example.com",
      fetch: fetchMock as typeof fetch,
    });

    const getStatus = client.endpoint<undefined, { ok: boolean }>({
      name: "test.endpoint",
      method: "GET",
      path: "/status",
      middleware: [
        withHeaders(() => ({
          "x-trace-id": "trace-1",
        })),
      ],
    });

    await expect(getStatus.fetch(undefined)).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Headers).get("x-trace-id")).toBe("trace-1");
  });

  it("lets logger middleware use a custom prefix", async () => {
    const events: string[] = [];
    const getStatus = endpoint<undefined, string>({
      name: "test.endpoint",
      request: async () => "ok",
      middleware: [
        logger({
          prefix: "api",
          log: {
            debug: (event) => events.push(String(event)),
            error: (event) => events.push(String(event)),
          },
        }),
      ],
    });

    await expect(getStatus.fetch(undefined)).resolves.toBe("ok");
    expect(events).toEqual(["api request", "api response"]);
  });

  it("rejects unresolved path parameters before calling fetch", async () => {
    const fetchMock = vi.fn();
    const client = createApiClient({
      baseUrl: "https://api.example.com",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const getUser = client.endpoint<{ params?: { id?: string } }, unknown>({
      name: "users.get",
      method: "GET",
      path: "/users/:id/reserves/{reserveId}",
    });

    await expect(getUser.fetch({})).rejects.toThrow(
      'Endpoint "users.get" is missing path parameters: id, reserveId.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds absolute URLs with ports, existing queries, and fragments", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(null, { status: 204 });
    });
    const client = createApiClient({
      fetch: fetchMock as typeof fetch,
    });
    const getUser = client.endpoint<
      { id: string; query: { tag: string[] } },
      undefined
    >({
      name: "users.get",
      method: "GET",
      path: "http://localhost:3000/users/:id?existing=1#profile",
    });

    await getUser.fetch({
      id: "u1",
      query: {
        tag: ["a", "b"],
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/users/u1?existing=1&tag=a&tag=b#profile",
      expect.any(Object),
    );
  });

  it("preserves relative base URL style", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(null, { status: 204 });
    });
    const rootedClient = createApiClient({
      baseUrl: "/api",
      fetch: fetchMock as typeof fetch,
    });
    const relativeClient = createApiClient({
      baseUrl: "api",
      fetch: fetchMock as typeof fetch,
    });

    await rootedClient
      .endpoint<undefined, undefined>({
        name: "rooted.status",
        method: "GET",
        path: "/status",
      })
      .fetch();
    await relativeClient
      .endpoint<undefined, undefined>({
        name: "relative.status",
        method: "GET",
        path: "/status",
      })
      .fetch();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/status", "api/status"]);
  });

  it("passes typed array bodies through without JSON serialization", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(null, { status: 204 });
    });
    const client = createApiClient({
      fetch: fetchMock as typeof fetch,
    });
    const upload = client.endpoint<{ body: Uint8Array }, undefined>({
      name: "files.upload",
      method: "POST",
      path: "https://api.example.com/files",
    });
    const body = new Uint8Array([1, 2, 3]);

    await expect(upload.fetch({ body })).resolves.toBeUndefined();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBe(body);
    expect((init?.headers as Headers).has("content-type")).toBe(false);
  });

  it("merges request init defaults from client through per-call options", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(null, { status: 204 });
    });
    const client = createApiClient({
      fetch: fetchMock as typeof fetch,
      requestInit: {
        credentials: "include",
        cache: "no-cache",
      },
    });
    const core = defineService("core", {
      requestInit: {
        cache: "reload",
        redirect: "error",
      },
      endpoints: {
        updateUser: defineEndpoint<undefined, undefined>({
          method: "PATCH",
          path: "https://api.example.com/users/1",
          requestInit: {
            redirect: "follow",
            mode: "cors",
          },
        }),
      },
    });
    const api = client.mount({ core });

    await api.core.updateUser.fetch(undefined, {
      requestInit: {
        mode: "same-origin",
      },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      credentials: "include",
      cache: "reload",
      redirect: "follow",
      mode: "same-origin",
      method: "PATCH",
    });
  });

  it("exposes the response to transforms and middleware", async () => {
    const statuses: number[] = [];
    const client = createApiClient({
      fetch: (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "request-1",
          },
        })) as typeof fetch,
      middleware: [
        async (ctx, next) => {
          const result = await next();
          statuses.push(ctx.response?.status ?? 0);
          return result;
        },
      ],
    });
    const getStatus = client.endpoint<undefined, { ok: boolean }, string>({
      name: "status.get",
      method: "GET",
      path: "https://api.example.com/status",
      transformResponse: (_response, ctx) =>
        ctx.response?.headers.get("x-request-id") ?? "missing",
    });

    await expect(getStatus.fetch()).resolves.toBe("request-1");
    expect(statuses).toEqual([200]);
  });

  it("requires a usable endpoint name and execution target", () => {
    expect(() =>
      endpoint({
        name: "",
        request: async () => undefined,
      }),
    ).toThrow("Endpoint requires a non-empty name.");

    expect(() =>
      endpoint({
        name: "invalid.endpoint",
      }),
    ).toThrow('Endpoint "invalid.endpoint" requires either a path or request handler.');
  });

  it("types mounted services and auth policies at the client boundary", () => {
    type AuthPolicy = {
      scope: "read" | "write";
    };

    const client = createApiClient<unknown, AuthPolicy>({
      middleware: [logger()],
      getAuthHeaders: (ctx) => {
        expectTypeOf(ctx.auth).toEqualTypeOf<AuthPolicy | undefined>();
        return undefined;
      },
    });

    const core = defineService("core", {
      endpoints: {
        getUsers: defineEndpoint({
          path: "/users",
          auth: {
            scope: "read",
          },
        }),
        invalidAuth: defineEndpoint<
          unknown,
          unknown,
          unknown,
          never,
          unknown,
          AuthPolicy
        >({
          path: "/users",
          // @ts-expect-error auth policies are typed by the client
          auth: { scope: "admin" },
        }),
      },
    });
    const api = client.mount({ core });

    expect(api.core.getUsers.config.name).toBe("core.getUsers");

    const known = defineService("known", {
      endpoints: {
        getKnown: {
          path: "/known",
        },
      },
    });
    const inferredServices = createApiClient().mount({ known });
    expectTypeOf(inferredServices.known.getKnown).toMatchTypeOf<
      { fetch(input: unknown): Promise<unknown> }
    >();
    // @ts-expect-error only mounted services are exposed
    inferredServices.missing;
  });

  it("uses endpoint names and selected identity in cache keys", () => {
    const getUser = endpoint<{ id: string; traceId: string }, string>({
      name: "users.get",
      key: ({ id }) => ({ id }),
      request: async () => "ok",
    });

    expect(getUser.cacheKey({ id: "u1", traceId: "trace-1" })).toEqual([
      "users.get",
      { id: "u1" },
    ]);
  });

  it("supports no-input fetch and cache key calls without undefined", async () => {
    const getStatus = endpoint<undefined, string>({
      name: "status.get",
      request: async () => "ok",
    });

    const core = defineService("core", {
      baseUrl: "https://api.example.com",
      endpoints: {
        getSession: defineEndpoint<undefined, unknown>({
          method: "GET",
          path: "/session",
        }),
      },
    });
    const api = createApiClient().mount({ core });

    await expect(getStatus.fetch()).resolves.toBe("ok");
    expect(getStatus.cacheKey()).toEqual(["status.get", undefined]);
    expect(api.core.getSession.cacheKey()).toEqual([
      "core",
      "core.getSession",
      undefined,
    ]);
  });
});
