import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  ApiError,
  SchemaValidationError,
  createApiClient,
  endpoint,
  logger,
  retry,
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

    const client = createApiClient({
      services: {
        identity: {
          baseUrl: "https://identity.example.com",
          fetch: identityFetch as typeof fetch,
          getAuthHeaders: async (ctx) =>
            ctx.auth === "session"
              ? {
                  Authorization: "Bearer user-token",
                }
              : undefined,
        },
        billing: {
          baseUrl: "https://billing.example.com",
          fetch: billingFetch as typeof fetch,
          getAuthHeaders: async (ctx) =>
            ctx.auth === "api-key"
              ? {
                  "x-api-key": "billing-key",
                }
              : undefined,
        },
      },
    });

    const getUser = client.endpoint<{ id: string }, { id: string }>({
      service: "identity",
      method: "GET",
      path: "/users/:id",
      auth: "session",
    });
    const getInvoice = client.endpoint<{ id: string }, { id: string }>({
      service: "billing",
      method: "GET",
      path: "/invoices/:id",
      auth: "api-key",
    });

    await expect(getUser.fetch({ id: "u1" })).resolves.toEqual({ id: "u1" });
    await expect(getInvoice.fetch({ id: "invoice-1" })).resolves.toEqual({
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
      services: {
        reports: {
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
        },
      },
    });

    const summary = client.endpoint<undefined, { ok: boolean }>({
      service: "reports",
      method: "GET",
      path: "/summary",
      headers: {
        "x-endpoint": "summary",
        "x-shared": "endpoint",
      },
    });

    await expect(summary.fetch(undefined)).resolves.toEqual({ ok: true });

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

  it("fails clearly when an endpoint references an unknown service", async () => {
    const client = createApiClient({
      services: {
        known: {
          baseUrl: "https://api.example.com",
        },
      },
    });

    const missing = client.endpoint<undefined, unknown>({
      service: "missing",
      method: "GET",
      path: "/status",
    });

    await expect(missing.fetch(undefined)).rejects.toThrow(
      'Unknown API service "missing".',
    );
  });

  it("runs service status handlers before rethrowing response errors", async () => {
    const events: string[] = [];
    const response = new Response(JSON.stringify({ message: "Session expired" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    });
    const client = createApiClient({
      services: {
        identity: {
          baseUrl: "https://identity.example.com",
          fetch: (async () => response) as typeof fetch,
          onStatus: {
            401: async ({ response, ctx }) => {
              events.push(`${ctx.serviceName}:${response.status}`);
            },
          },
        },
      },
    });

    const getSession = client.endpoint<undefined, unknown>({
      service: "identity",
      method: "GET",
      path: "/session",
    });

    await expect(getSession.fetch(undefined)).rejects.toBe(response);
    expect(events).toEqual(["identity:401"]);
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
    });
    expect(events).toEqual(["endpoint-402"]);
  });

  it("falls back to default status handlers when no status-specific handler exists", async () => {
    const events: string[] = [];
    const client = createApiClient({
      services: {
        billing: {
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
        },
      },
    });

    const getInvoice = client.endpoint<undefined, unknown>({
      service: "billing",
      method: "GET",
      path: "/invoices/1",
    });

    await expect(getInvoice.fetch(undefined)).rejects.toMatchObject({
      message: "Billing request blocked",
      code: "BILLING_BLOCKED",
      status: 403,
    });
    expect(events).toEqual(["default:403"]);
  });

  it("throws backend error responses unchanged", async () => {
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
      method: "POST",
      path: "/reserves",
    });

    await expect(createReserve.fetch({ body: { slotId: "s1" } })).rejects.toBe(
      response,
    );
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
        500: ({ response }) => {
          expectTypeOf(response).toEqualTypeOf<Response>();

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
      method: "GET",
      path: "/users",
    });

    await expect(searchUsers.fetch(undefined)).rejects.toBe(customError);
  });

  it("lets services and endpoints override transport error handlers", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const error = new TypeError("fetch failed");

    const client = createApiClient({
      defaultService: "core",
      onTransportError: {
        serviceUnreachable: () => ({
          message: "Client fallback",
          code: "CLIENT_FALLBACK",
        }),
      },
      services: {
        core: {
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
        },
      },
    });

    const serviceOnly = client.endpoint({
      method: "GET",
      path: "/service-only",
    });
    const endpointOverride = client.endpoint({
      method: "GET",
      path: "/endpoint-override",
      onTransportError: {
        serviceUnreachable: () => ({
          message: "Endpoint unavailable",
          code: "ENDPOINT_UNAVAILABLE",
        }),
      },
    });

    await expect(serviceOnly.fetch(undefined)).rejects.toMatchObject({
      code: "CORE_UNAVAILABLE",
      message: "Core API unavailable",
    });
    await expect(endpointOverride.fetch(undefined)).rejects.toMatchObject({
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
      method: "GET",
      path: "/users/123",
    });

    await expect(getUser.fetch(undefined)).rejects.toBe(error);
  });

  it("throws custom request errors unchanged", async () => {
    const error = new Error("Backend-specific shape");
    const createReserve = endpoint({
      request: async () => {
        throw error;
      },
    });

    await expect(createReserve.fetch(undefined)).rejects.toBe(error);
  });

  it("runs middleware around the transport", async () => {
    const calls: string[] = [];

    const getUser = endpoint<undefined, string>({
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

  it("can retry transport failures", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Response("Server error", { status: 500 }))
      .mockResolvedValueOnce("ok");

    const unstable = endpoint<undefined, string>({
      request,
      middleware: [retry({ attempts: 1, delay: 0 })],
    });

    await expect(unstable.fetch(undefined)).resolves.toBe("ok");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry abort failures by default", async () => {
    const error = new DOMException("Aborted", "AbortError");
    const request = vi.fn().mockRejectedValue(error);

    const unstable = endpoint<undefined, string>({
      request,
      middleware: [retry({ attempts: 2, delay: 0 })],
    });

    await expect(unstable.fetch(undefined)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry offline fetch failures by default", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const client = createApiClient({
      baseUrl: "https://api.example.com",
      fetch: fetchMock as unknown as typeof fetch,
      middleware: [retry({ attempts: 2, delay: 0 })],
    });

    const getUser = client.endpoint({
      method: "GET",
      path: "/users/123",
    });

    await expect(getUser.fetch(undefined)).rejects.toMatchObject({
      code: "CLIENT_OFFLINE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("jitters the default retry delay", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Response("Server error", { status: 500 }))
      .mockResolvedValueOnce("ok");

    try {
      const unstable = endpoint<undefined, string>({
        request,
        middleware: [retry({ attempts: 1 })],
      });

      await expect(unstable.fetch(undefined)).resolves.toBe("ok");
      expect(request).toHaveBeenCalledTimes(2);
      expect(randomSpy).toHaveBeenCalledTimes(1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("keeps undefined input in default cache keys", () => {
    const getStatus = endpoint<undefined, string>({
      name: "status.get",
      request: async () => "ok",
    });

    const client = createApiClient({
      defaultService: "core",
      services: {
        core: {
          baseUrl: "https://api.example.com",
        },
      },
    });
    const getSession = client.endpoint<undefined, unknown>({
      name: "session.get",
      method: "GET",
      path: "/session",
    });

    expect(getStatus.cacheKey(undefined)).toEqual(["status.get", undefined]);
    expect(getSession.cacheKey(undefined)).toEqual([
      "core",
      "session.get",
      undefined,
    ]);
  });
});
