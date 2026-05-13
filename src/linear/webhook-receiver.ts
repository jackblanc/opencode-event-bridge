import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  LinearWebhookApi,
  LinearWebhookBadRequest,
  LinearWebhookUnauthorized,
} from "./webhook-api.ts";
import { LinearWebhookPayload } from "./webhook-payload.ts";
import { LinearWebhookQueue } from "./webhook-queue.ts";

const supportedEvents = new Set(["AgentSessionEvent", "Issue"]);

const decodeAndValidateLinearWebhookPayload = (
  rawBody: ArrayBuffer,
  linearEventHeader: string,
  now: number,
) =>
  Effect.gen(function* () {
    const linearWebhookPayload = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(LinearWebhookPayload),
    )(new TextDecoder().decode(rawBody)).pipe(
      Effect.mapError(() => new LinearWebhookBadRequest({ reason: "InvalidPayload" })),
    );

    if (linearWebhookPayload.type !== linearEventHeader) {
      return yield* Effect.fail(new LinearWebhookBadRequest({ reason: "EventMismatch" }));
    }
    if (Math.abs(now - linearWebhookPayload.webhookTimestamp) > 60_000) {
      return yield* Effect.fail(new LinearWebhookUnauthorized({ reason: "StaleTimestamp" }));
    }

    return linearWebhookPayload;
  });

const verifySignature = (
  linearWebhookSecret: string,
  headerSignatureString: string,
  rawBody: ArrayBuffer,
) =>
  Effect.gen(function* () {
    const signatureBytes = yield* Schema.decodeUnknownEffect(Schema.Uint8ArrayFromHex)(
      headerSignatureString,
    ).pipe(Effect.mapError(() => new LinearWebhookUnauthorized({ reason: "InvalidSignature" })));
    const verificationSignature = new Uint8Array(signatureBytes);

    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(linearWebhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, verificationSignature, rawBody),
    );

    if (!valid) {
      return yield* Effect.fail(new LinearWebhookUnauthorized({ reason: "InvalidSignature" }));
    }
  });

export default class LinearWebhookReceiver extends Cloudflare.Worker<LinearWebhookReceiver>()(
  "LinearWebhookReceiver",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const queueResource = yield* LinearWebhookQueue;
    const queue = yield* Cloudflare.QueueBinding.bind(queueResource);
    const webhookSecret = yield* Alchemy.Secret("LINEAR_WEBHOOK_SECRET");

    const group = HttpApiBuilder.group(LinearWebhookApi, "LinearWebhook", (handlers) =>
      handlers.handleRaw("receiveLinearWebhook", ({ request, headers }) =>
        Effect.gen(function* () {
          // Verify the signature before processing the request
          const linearWebhookSecret = yield* webhookSecret;
          const rawBody = yield* request.arrayBuffer.pipe(Effect.orDie);
          yield* verifySignature(
            Redacted.value(linearWebhookSecret),
            headers["linear-signature"],
            rawBody,
          );

          // Check that the event type is supported before decoding the payload, to avoid parsing unsupported events
          if (!supportedEvents.has(headers["linear-event"])) {
            return { queued: false };
          }

          const linearWebhookPayload = yield* decodeAndValidateLinearWebhookPayload(
            rawBody,
            headers["linear-event"],
            Date.now(),
          );
          yield* queue.send(linearWebhookPayload).pipe(Effect.orDie);

          return { queued: true };
        }),
      ),
    );

    return {
      fetch: HttpApiBuilder.layer(LinearWebhookApi).pipe(
        Layer.provide(group),
        Layer.provide([HttpPlatform.layer, Etag.layer]),
        HttpRouter.toHttpEffect,
        Effect.scoped,
      ),
    };
  }).pipe(Effect.provide(Cloudflare.QueueBindingLive)),
) {}
