import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LinearHttpClient } from "../../src/linear/client/client.ts";

const forbiddenFetch: typeof fetch = async () => {
  await Promise.resolve();
  return Response.json(
    {
      errors: [
        {
          extensions: {
            type: "forbidden",
            userPresentableMessage: "No permission to update issue labels",
          },
          message: "Forbidden",
        },
      ],
    },
    { status: 401 },
  );
};

describe("LinearHttpClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies typed Linear GraphQL auth errors as permission failures", async () => {
    vi.stubGlobal("fetch", forbiddenFetch);

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const linear = yield* LinearHttpClient;
        return yield* linear.fetchViewer("token").pipe(Effect.flip);
      }).pipe(Effect.provide(Layer.fresh(LinearHttpClient.layer))),
    );

    expect(error.reason).toBe("PermissionFailure");
    expect(error.cause).toBe("No permission to update issue labels");
  });
});
