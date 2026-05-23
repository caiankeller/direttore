# Vue Query Example

Use `direttore` for the endpoint contract and Vue Query for cache lifecycle, retries, invalidation, and rendering state.

```ts
// src/api/client.ts
import { ApiError, createApiClient, retry } from "direttore";

const session = {
  async getAccessToken() {
    return "fresh-token";
  },
};

export const client = createApiClient({
  baseUrl: "https://api.example.com",
  getAuthHeaders: async () => ({
    Authorization: `Bearer ${await session.getAccessToken()}`,
  }),
  onTransportError: {
    clientOffline: ({ error }) => ({
      message: "You appear to be offline.",
      code: "CLIENT_OFFLINE",
      raw: error,
    }),
    serviceUnreachable: ({ error }) => ({
      message: "The API is temporarily unavailable.",
      code: "API_UNAVAILABLE",
      raw: error,
    }),
  },
  middleware: [
    retry({
      attempts: 2,
      shouldRetry(error) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
        if (error instanceof Response) return error.status >= 500;
        return true;
      },
    }),
  ],
});
```

```ts
// src/api/users.ts
import type { EndpointOutput } from "direttore";
import { client } from "./client";

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
    displayName: string;
  };
};

const toUser = (response: UserResponse) => ({
  id: response.user.id,
  name: response.user.display_name,
  email: response.user.email,
});

export const usersApi = {
  get: client.endpoint<{ id: string }, UserResponse, ReturnType<typeof toUser>>({
    name: "users.get",
    method: "GET",
    path: "/users/:id",
    transformResponse: toUser,
    onStatus: {
      404: () => ({
        message: "User not found.",
        code: "USER_NOT_FOUND",
        status: 404,
      }),
    },
  }),
  update: client.endpoint<UpdateUserInput, UserResponse, ReturnType<typeof toUser>>({
    name: "users.update",
    method: "PATCH",
    path: "/users/:id",
    body: (input) => input.body,
    transformResponse: toUser,
  }),
};

export type User = EndpointOutput<typeof usersApi.get>;
```

```ts
// src/api/index.ts
import { usersApi } from "./users";

export const api = {
  users: usersApi,
} as const;
```

```vue
<!-- src/features/users/UserProfile.vue -->
<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { ApiError } from "direttore";
import { computed, ref } from "vue";
import { api } from "../../api";

const props = defineProps<{
  id: string;
}>();

const queryClient = useQueryClient();
const displayName = ref("");
const input = computed(() => ({ id: props.id }));

const user = useQuery({
  queryKey: computed(() => api.users.get.cacheKey(input.value)),
  queryFn: ({ signal }) =>
    api.users.get.fetch(input.value, {
      signal,
      meta: {
        feature: "user-profile",
      },
    }),
  retry(failureCount, error) {
    if (error instanceof ApiError && error.status && error.status < 500) {
      return false;
    }

    if (error instanceof ApiError && error.code === "CLIENT_OFFLINE") {
      return false;
    }

    return failureCount < 2;
  },
});

const updateUser = useMutation({
  mutationFn: () =>
    api.users.update.fetch({
      id: props.id,
      body: {
        displayName: displayName.value,
      },
    }),
  onSuccess(updatedUser) {
    queryClient.setQueryData(api.users.get.cacheKey({ id: updatedUser.id }), updatedUser);
  },
});
</script>

<template>
  <p v-if="user.isPending">Loading...</p>
  <p v-else-if="user.error instanceof ApiError">{{ user.error.message }}</p>
  <section v-else-if="user.data">
    <h1>{{ user.data.name }}</h1>
    <p>{{ user.data.email }}</p>

    <form @submit.prevent="updateUser.mutate()">
      <input v-model="displayName" />
      <button type="submit" :disabled="updateUser.isPending">
        Save
      </button>
    </form>
  </section>
</template>
```

The endpoint stays framework-neutral: Vue Query supplies cache and component state, while `direttore` supplies URL building, auth headers, abort support, response transformation, cache keys, and normalized API errors.
