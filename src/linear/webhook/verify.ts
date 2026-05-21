import { Schema } from "effect";
import * as Effect from "effect/Effect";

import { LinearWebhookUnauthorized } from "./api.ts";

export const verifyLinearWebhookSignature = (
  linearWebhookSecret: string,
  headerSignatureString: string,
  rawBody: ArrayBuffer,
) =>
  Effect.gen(function* () {
    const signatureBytes = yield* Schema.decodeUnknownEffect(Schema.Uint8ArrayFromHex)(
      headerSignatureString,
    ).pipe(
      Effect.mapError(
        (cause) => new LinearWebhookUnauthorized({ cause, reason: "InvalidSignature" }),
      ),
    );
    const verificationSignature = new Uint8Array(signatureBytes);

    const key = yield* Effect.promise(async () =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(linearWebhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
    const valid = yield* Effect.promise(async () =>
      crypto.subtle.verify("HMAC", key, verificationSignature, rawBody),
    );

    if (!valid) {
      return yield* new LinearWebhookUnauthorized({ reason: "InvalidSignature" });
    }

    return undefined;
  });
