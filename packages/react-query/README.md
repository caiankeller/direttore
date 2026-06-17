# @direttore/react-query

TanStack React Query adapter for Direttore API endpoints.

## Install

```sh
npm install @direttore/core @direttore/react-query @tanstack/react-query react
```

## Create an adapter

```ts
import { createReactQueryAdapter } from "@direttore/react-query";
import { api } from "./api";

export const rq = createReactQueryAdapter(api);
```

The adapter mirrors the mounted Direttore API tree:

```ts
rq.query.identity.getUser.options({ id: "u1" });
rq.mutation.identity.updateUser.options();
```

## Queries

```tsx
import { useQuery } from "@tanstack/react-query";
import { rq } from "./api/query";

function UserProfile({ id }: { id: string }) {
  const user = useQuery(
    rq.query.identity.getUser.options(
      { id },
      {
        staleTime: 30_000,
        fetch: {
          meta: {
            feature: "user-profile",
          },
        },
      },
    ),
  );

  if (user.isPending) return <p>Loading...</p>;
  if (user.isError) return <p>{user.error.message}</p>;

  return <h1>{user.data.name}</h1>;
}
```

React Query owns cancellation, retries, stale state, and rendering state. Direttore
continues to own request construction, auth headers, response parsing, transforms,
cache keys, and normalized API errors.

Use `fetch` inside adapter options for Direttore per-call options. Query signals are
provided by React Query automatically:

```ts
rq.query.identity.getUser.options(
  { id: "u1" },
  {
    fetch: {
      headers: {
        "x-request-id": crypto.randomUUID(),
      },
      meta: {
        feature: "user-profile",
      },
    },
  },
);
```

No-input endpoints can omit the first argument:

```ts
rq.query.identity.getSession.options();
rq.query.identity.getSession.options(undefined, {
  enabled: isReady,
});
```

## Mutations

Mutation variables are the Direttore endpoint input:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { rq } from "./api/query";

function UserForm({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const updateUser = useMutation(
    rq.mutation.identity.updateUser.options({
      fetch: {
        meta: {
          feature: "user-form",
        },
      },
      onSuccess(updatedUser) {
        queryClient.setQueryData(
          rq.query.identity.getUser.key({ id: updatedUser.id }),
          updatedUser,
        );
      },
    }),
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        updateUser.mutate({
          id,
          body: {
            name: new FormData(event.currentTarget).get("name") as string,
          },
        });
      }}
    >
      <input name="name" />
      <button disabled={updateUser.isPending}>Save</button>
    </form>
  );
}
```

## Helper methods

Each query endpoint exposes:

- `key(input)` / `queryKey(input)`: the Direttore cache key.
- `options(input, options)`: React Query options with `queryKey` and `queryFn`.

Each mutation endpoint exposes:

- `key(input)`: the Direttore cache key for a concrete input.
- `mutationKey()`: a stable mutation key based on the endpoint name.
- `options(options)`: React Query options with `mutationFn`.
