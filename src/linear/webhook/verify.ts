import { Schema } from "effect";
import * as Effect from "effect/Effect";

import { LinearWebhookUnauthorized } from "./api.ts";

export const verifyLinearWebhookSignature = (input: {
  readonly headerSignature: string;
  readonly rawBody: ArrayBuffer;
  readonly webhookSecret: string;
}) =>
  Effect.gen(function* () {
    const signatureBytes = yield* Schema.decodeEffect(Schema.Uint8ArrayFromHex)(
      input.headerSignature,
    ).pipe(
      Effect.mapError((cause) =>
        LinearWebhookUnauthorized.make({ cause, reason: "InvalidSignature" }),
      ),
    );
    const verificationSignature = new Uint8Array(signatureBytes);

    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(input.webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, verificationSignature, input.rawBody),
    );

    if (!valid) {
      return yield* LinearWebhookUnauthorized.make({ reason: "InvalidSignature" });
    }

    return undefined;
  });
