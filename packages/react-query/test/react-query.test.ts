import { useMutation } from "@tanstack/react-query";
import type { DefaultError } from "@tanstack/react-query";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createApiClient,
  defineEndpoint,
  defineService,
  endpoint,
} from "@direttore/core";
import type { EndpointCacheKey } from "@direttore/core";
import { createReactQueryAdapter } from "../src";

type ApiMeta = {
  feature: string;
};

type User = {
  id: string;
  name: string;
};

describe("createReactQueryAdapter", () => {
  it("creates query options with endpoint cache keys and fetch options", async () => {
    const controller = new AbortController();
    const client = createApiClient<ApiMeta>();
    const identity = defineService("identity", {
      endpoints: {
        getUser: defineEndpoint<{ id: string }, User>({
          request: async (ctx) => {
            expect(ctx.input).toEqual({ id: "u1" });
            expect(ctx.meta).toEqual({ feature: "profile" });
            expect(ctx.request.init.signal).toBe(controller.signal);

            return {
              id: ctx.input.id,
              name: "Ada",
            };
          },
        }),
      },
    });
    const api = client.mount({ identity });
    const reactQuery = createReactQueryAdapter(api);

    const options = reactQuery.query.identity.getUser.options(
      { id: "u1" },
      {
        staleTime: 1_000,
        fetch: {
          meta: {
            feature: "profile",
          },
        },
        select: (user) => user.name,
      },
    );

    expect(options.queryKey).toEqual(["identity", "identity.getUser", { id: "u1" }]);
    expect(options.staleTime).toBe(1_000);
    await expect(
      options.queryFn({
        signal: controller.signal,
      } as never),
    ).resolves.toEqual({
      id: "u1",
      name: "Ada",
    });

    expectTypeOf(options.queryKey).toEqualTypeOf<EndpointCacheKey>();
    expectTypeOf(options.select).toMatchTypeOf<
      ((data: User) => string) | undefined
    >();

    // @ts-expect-error query inputs are required for endpoints that need input
    reactQuery.query.identity.getUser.options();
    reactQuery.query.identity.getUser.options(
      { id: "u1" },
      {
        fetch: {
          // @ts-expect-error React Query owns query cancellation signals
          signal: controller.signal,
        },
      },
    );
  });

  it("creates mutation options that use endpoint input as variables", async () => {
    const client = createApiClient<ApiMeta>();
    const identity = defineService("identity", {
      endpoints: {
        updateUser: defineEndpoint<
          { id: string; body: { name: string } },
          User
        >({
          request: async (ctx) => {
            expect(ctx.meta).toEqual({ feature: "settings" });

            return {
              id: ctx.input.id,
              name: ctx.input.body.name,
            };
          },
        }),
      },
    });
    const api = client.mount({ identity });
    const reactQuery = createReactQueryAdapter(api);

    const options = reactQuery.mutation.identity.updateUser.options({
      fetch: {
        meta: {
          feature: "settings",
        },
      },
      onSuccess: (data, variables) => {
        expectTypeOf(data).toEqualTypeOf<User>();
        expectTypeOf(variables).toEqualTypeOf<{
          id: string;
          body: {
            name: string;
          };
        }>();
      },
    });

    expect(options.mutationKey).toEqual(["identity.updateUser"]);
    await expect(
      options.mutationFn({
        id: "u1",
        body: {
          name: "Grace",
        },
      }),
    ).resolves.toEqual({
      id: "u1",
      name: "Grace",
    });

    if (false) {
      const mutation = useMutation(
        reactQuery.mutation.identity.updateUser.options({
          fetch: {
            meta: {
              feature: "settings",
            },
          },
        }),
      );

      expectTypeOf(mutation.error).toEqualTypeOf<DefaultError | null>();
    }
  });

  it("supports standalone and no-input endpoints", async () => {
    const health = endpoint<undefined, string>({
      name: "health.get",
      request: async () => "ok",
    });
    const reactQuery = createReactQueryAdapter({ health });

    const queryOptions = reactQuery.query.health.options();
    const queryOptionsWithConfig = reactQuery.query.health.options(undefined, {
      enabled: false,
    });
    const mutationOptions = reactQuery.mutation.health.options();

    expect(queryOptions.queryKey).toEqual(["health.get", undefined]);
    expect(queryOptionsWithConfig.enabled).toBe(false);
    await expect(queryOptions.queryFn({} as never)).resolves.toBe("ok");
    await expect(mutationOptions.mutationFn()).resolves.toBe("ok");
  });

  it("mirrors nested API trees", () => {
    const api = {
      nested: {
        ping: endpoint<undefined, string>({
          name: "nested.ping",
          request: async () => "pong",
        }),
      },
    };
    const reactQuery = createReactQueryAdapter(api);

    expect(reactQuery.query.nested.ping.key()).toEqual(["nested.ping", undefined]);
    expect(reactQuery.mutation.nested.ping.mutationKey()).toEqual(["nested.ping"]);
  });
});
