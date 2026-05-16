import * as Cloudflare from "alchemy/Cloudflare";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { LinearSessionStoreKv } from "../linear/session/cloudflare.ts";
import { processLinearWebhook } from "../linear/session/process.ts";
import { LinearSessionStore, makeLinearSessionStore } from "../linear/session/store.ts";
import { LinearWebhookPayload } from "../linear/webhook/payload.ts";
import { LinearWebhookQueue } from "../linear/webhook/queue.ts";
import { makeOpenCodeClient, OpenCodeClient } from "../opencode/client.ts";
import { OpenCodeVpcService } from "../opencode/service.ts";

export default class LinearWebhookProcessor extends Cloudflare.Worker<LinearWebhookProcessor>()(
  "LinearWebhookProcessor",
  { bindings: { OPENCODE: OpenCodeVpcService.pipe(Effect.orDie) }, main: import.meta.filename },
  Effect.gen(function* () {
    const queueResource = yield* LinearWebhookQueue;
    const sessionStoreResource = yield* LinearSessionStoreKv;
    const sessionStore = yield* Cloudflare.KVNamespace.bind(sessionStoreResource);
    const opencodeService = yield* OpenCodeVpcService.pipe(Effect.orDie);
    const bindVpcService = yield* Cloudflare.VpcServiceBinding;
    const opencodeBinding = yield* bindVpcService(opencodeService);

    yield* Cloudflare.messages(queueResource).subscribe((stream) =>
      Stream.runForEach(stream, (msg) =>
        Effect.gen(function* () {
          const env = yield* Cloudflare.WorkerEnvironment;
          const store = makeLinearSessionStore({
            get: (key) =>
              sessionStore.get(key).pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env)),
            put: (key, value) =>
              sessionStore
                .put(key, value)
                .pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env)),
          });
          const fetchOpenCode = async (input: string | URL | Request, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const webResponse = await Effect.gen(function* () {
              const clientResponse = yield* opencodeBinding
                .fetch(HttpServerRequest.toClientRequest(HttpServerRequest.fromWeb(request)))
                .pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env));

              return HttpServerResponse.toWeb(
                HttpServerResponse.fromClientResponse(clientResponse),
              );
            }).pipe(Effect.runPromise);
            return webResponse;
          };
          const opencode = makeOpenCodeClient(fetchOpenCode);
          const payloadOption = yield* Schema.decodeUnknownEffect(LinearWebhookPayload)(
            msg.body,
          ).pipe(
            Effect.tapError(() => Effect.log("invalid linear webhook queue message")),
            Effect.option,
          );

          if (Option.isNone(payloadOption)) {
            return;
          }

          const payload = payloadOption.value;

          yield* processLinearWebhook(payload).pipe(
            Effect.provideService(LinearSessionStore, store),
            Effect.provideService(OpenCodeClient, opencode),
          );

          yield* Effect.log("linear webhook processed", {
            webhookId: payload.webhookId,
            type: payload.type,
            action: payload.action,
            organizationId: payload.organizationId,
          });
        }),
      ),
    );
  }).pipe(
    Effect.provide([
      Cloudflare.KVNamespaceBindingLive,
      Cloudflare.QueueEventSourceLive,
      Cloudflare.VpcServiceBindingLive,
    ]),
  ),
) {}
