import { afterEach, describe, expect, layer, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LinearHttpClient } from "../../src/linear/client/client.ts";

const forbiddenFetch: typeof fetch = () =>
  Promise.resolve(
    Response.json(
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
    ),
  );

describe("LinearHttpClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  layer(Layer.fresh(LinearHttpClient.layer))((it) => {
    it.effect("classifies typed Linear GraphQL auth errors as permission failures", () =>
      Effect.gen(function* () {
        vi.stubGlobal("fetch", forbiddenFetch);
        const linear = yield* LinearHttpClient;
        const error = yield* linear.fetchViewer("token").pipe(Effect.flip);

        expect(error.reason).toBe("PermissionFailure");
        expect(error.cause).toBe("No permission to update issue labels");
      }),
    );
  });
});
