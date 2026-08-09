import { Clock, Schema } from "effect";
import * as Effect from "effect/Effect";

import { LinearWebhookBadRequest, LinearWebhookUnauthorized } from "./api.ts";
import { LinearWebhookPayload } from "./payload.ts";
import { verifyLinearWebhookSignature } from "./verify.ts";

const supportedEvents = new Set(["AgentSessionEvent", "Issue"]);

const decodeAndValidateLinearWebhookPayload = (rawBody: ArrayBuffer, linearEventHeader: string) =>
  Effect.gen(function* () {
    const linearWebhookPayload = yield* Schema.decodeEffect(
      Schema.fromJsonString(LinearWebhookPayload),
    )(new TextDecoder().decode(rawBody)).pipe(
      Effect.mapError((cause) => LinearWebhookBadRequest.make({ cause, reason: "InvalidPayload" })),
    );

    if (linearWebhookPayload.type !== linearEventHeader) {
      return yield* LinearWebhookBadRequest.make({ reason: "EventMismatch" });
    }
    const now = yield* Clock.currentTimeMillis;
    if (Math.abs(now - linearWebhookPayload.webhookTimestamp) > 60_000) {
      return yield* LinearWebhookUnauthorized.make({ reason: "StaleTimestamp" });
    }

    return linearWebhookPayload;
  });

export const receiveLinearWebhook = <E, R>(input: {
  readonly allowedOrganizationId: string;
  readonly event: string;
  readonly queue: { send(payload: LinearWebhookPayload): Effect.Effect<void, E, R> };
  readonly rawBody: ArrayBuffer;
  readonly signature: string;
  readonly webhookSecret: string;
}) =>
  Effect.gen(function* () {
    yield* verifyLinearWebhookSignature({
      headerSignature: input.signature,
      rawBody: input.rawBody,
      webhookSecret: input.webhookSecret,
    });

    if (!supportedEvents.has(input.event)) {
      return { queued: false };
    }

    const payload = yield* decodeAndValidateLinearWebhookPayload(input.rawBody, input.event);
    if (payload.organizationId !== input.allowedOrganizationId) {
      return yield* LinearWebhookUnauthorized.make({ reason: "OrganizationNotAllowed" });
    }

    yield* Effect.log("linear webhook payload decoded", {
      action: payload.action,
      bodyBytes: input.rawBody.byteLength,
      organizationId: payload.organizationId,
      rawBody: new TextDecoder().decode(input.rawBody),
      type: payload.type,
      webhookId: payload.webhookId,
    });
    yield* input.queue.send(payload).pipe(Effect.orDie);

    return { queued: true };
  });
