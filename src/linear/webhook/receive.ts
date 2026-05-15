import { Schema } from "effect";
import * as Effect from "effect/Effect";

import { LinearWebhookBadRequest, LinearWebhookUnauthorized } from "./api.ts";
import { LinearWebhookPayload } from "./payload.ts";
import { verifyLinearWebhookSignature } from "./verify.ts";

const supportedEvents = new Set(["AgentSessionEvent", "Issue"]);

const decodeAndValidateLinearWebhookPayload = (rawBody: ArrayBuffer, linearEventHeader: string) =>
  Effect.gen(function* () {
    const linearWebhookPayload = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(LinearWebhookPayload),
    )(new TextDecoder().decode(rawBody)).pipe(
      Effect.mapError(() => new LinearWebhookBadRequest({ reason: "InvalidPayload" })),
    );

    if (linearWebhookPayload.type !== linearEventHeader) {
      return yield* new LinearWebhookBadRequest({ reason: "EventMismatch" });
    }
    if (Math.abs(Date.now() - linearWebhookPayload.webhookTimestamp) > 60_000) {
      return yield* new LinearWebhookUnauthorized({ reason: "StaleTimestamp" });
    }

    return linearWebhookPayload;
  });

export const receiveLinearWebhook = <R>(input: {
  readonly event: string;
  readonly queue: { send(payload: LinearWebhookPayload): Effect.Effect<void, unknown, R> };
  readonly rawBody: ArrayBuffer;
  readonly signature: string;
  readonly webhookSecret: string;
}) =>
  Effect.gen(function* () {
    yield* verifyLinearWebhookSignature(input.webhookSecret, input.signature, input.rawBody);

    if (!supportedEvents.has(input.event)) {
      return { queued: false };
    }

    const payload = yield* decodeAndValidateLinearWebhookPayload(input.rawBody, input.event);
    yield* input.queue.send(payload).pipe(Effect.orDie);

    return { queued: true };
  });
