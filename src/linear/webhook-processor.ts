import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { LinearWebhookPayload } from "./webhook-payload.ts";

import { LinearOrgAuthStore } from "./oauth-store.ts";
import { LinearWebhookQueue } from "./webhook-queue.ts";

export default class LinearWebhookProcessor extends Cloudflare.Worker<LinearWebhookProcessor>()(
  "LinearWebhookProcessor",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const queueResource = yield* LinearWebhookQueue;
    const orgAuthResource = yield* LinearOrgAuthStore;
    yield* Cloudflare.KVNamespace.bind(orgAuthResource);

    yield* Cloudflare.messages<LinearWebhookPayload>(queueResource).subscribe((stream) =>
      Stream.runForEach(stream, (msg) =>
        Effect.log("linear webhook", {
          webhookId: msg.body.webhookId,
          type: msg.body.type,
          action: msg.body.action,
          organizationId: msg.body.organizationId,
        }),
      ),
    );
  }).pipe(Effect.provide([Cloudflare.KVNamespaceBindingLive, Cloudflare.QueueEventSourceLive])),
) {}
