import { ApiError, createApiClient, retry, type EndpointOutput } from "direttore";

type User = {
  id: string;
  name: string;
  email: string;
};

type UserResponse = {
  data: {
    id: string;
    full_name: string;
    email: string;
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
  onTransportError: {
    serviceUnreachable: ({ error }) => ({
      message: "The upstream API is unreachable.",
      code: "UPSTREAM_UNREACHABLE",
      raw: error,
    }),
  },
  middleware: [retry({ attempts: 1 })],
});

const getUser = client.endpoint<{ id: string }, UserResponse, User>({
  name: "users.get",
  method: "GET",
  path: "/users/:id",
  transformResponse: (response) => ({
    id: response.data.id,
    name: response.data.full_name,
    email: response.data.email,
  }),
  onStatus: {
    404: () => ({
      message: "User not found.",
      code: "USER_NOT_FOUND",
      status: 404,
    }),
  },
});

export type LoadedUser = EndpointOutput<typeof getUser>;

export async function loadUser(id: string): Promise<LoadedUser | undefined> {
  try {
    return await getUser.fetch({ id });
  } catch (error) {
    if (error instanceof ApiError && error.code === "USER_NOT_FOUND") {
      return undefined;
    }

    throw error;
  }
}
