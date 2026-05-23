import {
  ApiError,
  createApiClient,
  logger,
  retry,
  type EndpointOutput,
} from "direttore";

type ApiMeta = {
  feature?: string;
  requestId?: string;
};

type AuthPolicy = {
  scope?: string;
};

type UserRole = "admin" | "member";

type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
};

type UserResponse = {
  data: {
    id: string;
    full_name: string;
    email: string;
    role: UserRole;
  };
};

type SearchUsersInput = {
  query: {
    q?: string;
    page?: number;
  };
};

type Reserve = {
  id: string;
  userId: string;
  slotId: string;
  status: "created" | "pending";
};

type CreateReserveInput = {
  body: {
    userId: string;
    slotId: string;
  };
};

type Invoice = {
  id: string;
  total: number;
  currency: string;
};

type InvoiceResponse = {
  invoice: {
    id: string;
    total_cents: number;
    currency: string;
  };
};

const API_URL = "https://api.example.com";
const BILLING_URL = "https://billing.example.com";

const tokenStore = {
  async getAccessToken(_scope: string | undefined) {
    return "access-token";
  },
  async invalidate() {
    undefined;
  },
};

function schema<T>(validate: (value: unknown) => T) {
  return { validate };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }

  return value;
}

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number") {
    throw new Error(`${key} must be a number`);
  }

  return value;
}

function userRoleField(source: Record<string, unknown>, key: string): UserRole {
  const value = stringField(source, key);
  if (value === "admin" || value === "member") {
    return value;
  }

  throw new Error(`${key} must be admin or member`);
}

function reserveStatusField(
  source: Record<string, unknown>,
  key: string,
): Reserve["status"] {
  const value = stringField(source, key);
  if (value === "created" || value === "pending") {
    return value;
  }

  throw new Error(`${key} must be created or pending`);
}

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

const userResponseSchema = schema<UserResponse>((value) => {
  const root = record(value, "user response");
  const data = record(root.data, "user response data");

  return {
    data: {
      id: stringField(data, "id"),
      full_name: stringField(data, "full_name"),
      email: stringField(data, "email"),
      role: userRoleField(data, "role"),
    },
  };
});

const searchUsersResponseSchema = schema<{ data: UserResponse["data"][] }>((value) => {
  const root = record(value, "search users response");
  const data = root.data;

  if (!Array.isArray(data)) {
    throw new Error("data must be an array");
  }

  return {
    data: data.map((entry) => userResponseSchema.validate({ data: entry }).data),
  };
});

const reserveSchema = schema<Reserve>((value) => {
  const root = record(value, "reserve response");

  return {
    id: stringField(root, "id"),
    userId: stringField(root, "userId"),
    slotId: stringField(root, "slotId"),
    status: reserveStatusField(root, "status"),
  };
});

const invoiceResponseSchema = schema<InvoiceResponse>((value) => {
  const root = record(value, "invoice response");
  const invoice = record(root.invoice, "invoice");

  return {
    invoice: {
      id: stringField(invoice, "id"),
      total_cents: numberField(invoice, "total_cents"),
      currency: stringField(invoice, "currency"),
    },
  };
});

function toUser(response: UserResponse): User {
  return {
    id: response.data.id,
    name: response.data.full_name,
    email: response.data.email,
    role: response.data.role,
  };
}

export const client = createApiClient<ApiMeta>({
  defaultService: "core",
  headers: {
    "x-app": "web",
  },
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
      baseUrl: API_URL,
      getAuthHeaders: async (ctx) => {
        const token = await tokenStore.getAccessToken(getAuthScope(ctx.auth));
        return token ? { Authorization: `Bearer ${token}` } : undefined;
      },
      onStatus: {
        401: async () => {
          await tokenStore.invalidate();
        },
        403: () => ({
          message: "You do not have access to this resource.",
          code: "FORBIDDEN",
          status: 403,
        }),
      },
    },
    billing: {
      baseUrl: BILLING_URL,
      getAuthHeaders: async (ctx) => {
        const token = await tokenStore.getAccessToken(getAuthScope(ctx.auth));
        return token ? { Authorization: `Bearer ${token}` } : undefined;
      },
      onStatus: {
        402: () => ({
          message: "Billing requires an active plan.",
          code: "PLAN_REQUIRED",
          status: 402,
        }),
      },
      onTransportError: {
        serviceUnreachable: ({ error }) => ({
          message: "Billing is temporarily unavailable.",
          code: "BILLING_UNAVAILABLE",
          raw: error,
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
        if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
        if (error instanceof Response) return error.status >= 500;
        return true;
      },
    }),
  ],
});

const getUser = client.endpoint<{ id: string }, UserResponse, User>({
  name: "users.get",
  method: "GET",
  path: "/users/:id",
  auth: {
    scope: "users:read",
  },
  response: userResponseSchema,
  transformResponse: toUser,
  onStatus: {
    404: () => ({
      message: "User not found.",
      code: "USER_NOT_FOUND",
      status: 404,
    }),
  },
});

const searchUsers = client.endpoint<SearchUsersInput, { data: UserResponse["data"][] }, User[]>({
  name: "users.search",
  method: "GET",
  path: "/users",
  auth: {
    scope: "users:read",
  },
  response: searchUsersResponseSchema,
  transformResponse: (response) =>
    response.data.map((data) =>
      toUser({
        data,
      }),
    ),
});

const createReserve = client.endpoint<CreateReserveInput, Reserve>({
  name: "reserves.create",
  method: "POST",
  path: "/reserves",
  auth: {
    scope: "reserves:write",
  },
  response: reserveSchema,
});

const getInvoice = client.endpoint<{ id: string }, InvoiceResponse, Invoice>({
  service: "billing",
  name: "invoices.get",
  method: "GET",
  path: "/invoices/:id",
  auth: {
    scope: "invoices:read",
  },
  response: invoiceResponseSchema,
  transformResponse: (response) => ({
    id: response.invoice.id,
    total: response.invoice.total_cents / 100,
    currency: response.invoice.currency,
  }),
});

export const api = {
  users: {
    get: getUser,
    search: searchUsers,
  },
  reserves: {
    create: createReserve,
  },
  invoices: {
    get: getInvoice,
  },
} as const;

export type Api = typeof api;
export type UserOutput = EndpointOutput<typeof api.users.get>;
export type ReserveOutput = EndpointOutput<typeof api.reserves.create>;
export type InvoiceOutput = EndpointOutput<typeof api.invoices.get>;

export async function loadUserProfile(id: string, signal?: AbortSignal): Promise<UserOutput> {
  return api.users.get.fetch(
    { id },
    {
      ...(signal ? { signal } : {}),
      meta: {
        feature: "user-profile",
        requestId: crypto.randomUUID(),
      },
      headers: {
        "x-request-source": "profile-page",
      },
    },
  );
}

export async function reserveSlot(userId: string, slotId: string): Promise<ReserveOutput> {
  return api.reserves.create.fetch({
    body: {
      userId,
      slotId,
    },
  });
}

export function userProfileCacheKey(id: string) {
  return api.users.get.cacheKey({ id });
}
