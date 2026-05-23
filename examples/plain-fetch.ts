import {
  ApiError,
  SchemaValidationError,
  createApiClient,
  type EndpointOutput,
} from "direttore";

type User = {
  id: string;
  name: string;
  email: string;
};

type UserResponse = {
  user: {
    id: string;
    display_name: string;
    email: string;
  };
};

type UpdateUserInput = {
  id: string;
  body: {
    displayName?: string;
    email?: string;
  };
};

const session = {
  async getAccessToken() {
    return "fresh-token";
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

const userResponseSchema = schema<UserResponse>((value) => {
  const root = record(value, "user response");
  const user = record(root.user, "user");

  return {
    user: {
      id: stringField(user, "id"),
      display_name: stringField(user, "display_name"),
      email: stringField(user, "email"),
    },
  };
});

const client = createApiClient({
  baseUrl: "https://api.example.com",
  getAuthHeaders: async () => ({
    Authorization: `Bearer ${await session.getAccessToken()}`,
  }),
  onTransportError: {
    clientOffline: ({ error }) => ({
      message: "You are offline.",
      code: "CLIENT_OFFLINE",
      raw: error,
    }),
    serviceUnreachable: ({ error }) => ({
      message: "The user API is unreachable.",
      code: "USER_API_UNREACHABLE",
      raw: error,
    }),
  },
});

function toUser(response: UserResponse): User {
  return {
    id: response.user.id,
    name: response.user.display_name,
    email: response.user.email,
  };
}

const getUser = client.endpoint<{ id: string }, UserResponse, User>({
  name: "users.get",
  method: "GET",
  path: "/users/:id",
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

const updateUser = client.endpoint<UpdateUserInput, UserResponse, User>({
  name: "users.update",
  method: "PATCH",
  path: "/users/:id",
  body: (input) => input.body,
  response: userResponseSchema,
  transformResponse: toUser,
});

export type LoadedUser = EndpointOutput<typeof getUser>;

export const api = {
  users: {
    get: getUser,
    update: updateUser,
  },
} as const;

export async function loadUser(
  id: string,
  signal?: AbortSignal,
): Promise<LoadedUser | undefined> {
  try {
    return await api.users.get.fetch(
      { id },
      {
        ...(signal ? { signal } : {}),
        headers: {
          "x-request-id": crypto.randomUUID(),
        },
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "USER_NOT_FOUND") {
      return undefined;
    }

    if (error instanceof ApiError && error.code === "CLIENT_OFFLINE") {
      console.warn(error.message);
      return undefined;
    }

    if (error instanceof SchemaValidationError) {
      console.error("Backend response did not match the endpoint contract.", error.raw);
    }

    throw error;
  }
}

export async function saveDisplayName(id: string, displayName: string): Promise<LoadedUser> {
  return api.users.update.fetch({
    id,
    body: {
      displayName,
    },
  });
}

export async function loadUserWithTimeout(id: string): Promise<LoadedUser | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    return await loadUser(id, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}
