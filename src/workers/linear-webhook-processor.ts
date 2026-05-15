import * as Cloudflare from "alchemy/Cloudflare";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { LinearOrgAuthStore } from "../linear/oauth/store.ts";
import { LinearWebhookPayload } from "../linear/webhook/payload.ts";
import { LinearWebhookQueue } from "../linear/webhook/queue.ts";

export default class LinearWebhookProcessor extends Cloudflare.Worker<LinearWebhookProcessor>()(
  "LinearWebhookProcessor",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const queueResource = yield* LinearWebhookQueue;
    const orgAuthResource = yield* LinearOrgAuthStore;
    yield* Cloudflare.KVNamespace.bind(orgAuthResource);

    yield* Cloudflare.messages(queueResource).subscribe((stream) =>
      Stream.runForEach(stream, (msg) =>
        Effect.gen(function* () {
          const payload = yield* Schema.decodeUnknownEffect(LinearWebhookPayload)(msg.body);

          return yield* Effect.log("linear webhook", {
            webhookId: payload.webhookId,
            type: payload.type,
            action: payload.action,
            organizationId: payload.organizationId,
          });
        }).pipe(Effect.catch(() => Effect.log("invalid linear webhook queue message"))),
      ),
    );
  }).pipe(Effect.provide([Cloudflare.KVNamespaceBindingLive, Cloudflare.QueueEventSourceLive])),
) {}
