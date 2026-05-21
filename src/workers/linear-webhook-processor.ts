import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { LinearHttpClient } from "../linear/client/client.ts";
import { LinearOrgAuthStore, makeLinearOrgAuthStore } from "../linear/oauth/auth.ts";
import { LinearOrgAuthStore as LinearOrgAuthStoreResource } from "../linear/oauth/store.ts";
import { LinearSessionStoreKv } from "../linear/session/cloudflare.ts";
import { processLinearWebhook } from "../linear/session/process.ts";
import { LinearSessionStore, makeLinearSessionStore } from "../linear/session/store.ts";
import { LinearWebhookPayload } from "../linear/webhook/payload.ts";
import { LinearWebhookQueue } from "../linear/webhook/queue.ts";
import { makeOpenCodeClient, OpenCodeClient } from "../opencode/client.ts";
import { openCodePrivateHost, openCodePrivatePort } from "../opencode/config.ts";
import OpenCodeRunObserver, {
  makeOpenCodeRunObserverService,
  OpenCodeRunObserverService,
} from "../opencode/run-observer.ts";
import { OpenCodeVpcService } from "../opencode/service.ts";
import { makeStageWorkerName } from "./name.ts";

export default class LinearWebhookProcessor extends Cloudflare.Worker<LinearWebhookProcessor>()(
  "LinearWebhookProcessor",
  Stack.useSync((stack) => ({
    main: import.meta.filename,
    name: makeStageWorkerName(stack.stage, "event-processor"),
  })),
  Effect.gen(function* () {
    const queueResource = yield* LinearWebhookQueue;
    const sessionStoreResource = yield* LinearSessionStoreKv;
    const sessionStore = yield* Cloudflare.KVNamespace.bind(sessionStoreResource);
    const orgAuthResource = yield* LinearOrgAuthStoreResource;
    const orgAuthStore = yield* Cloudflare.KVNamespace.bind(orgAuthResource);
    const opencodeService = yield* OpenCodeVpcService.pipe(Effect.orDie);
    const bindVpcService = yield* Cloudflare.VpcServiceBinding;
    const opencodeBinding = yield* bindVpcService(opencodeService);
    const observers = yield* OpenCodeRunObserver;
    const linear = yield* LinearHttpClient;

    yield* Cloudflare.messages(queueResource).subscribe((stream) =>
      Stream.runForEach(stream, (msg) => {
        const effect: Effect.Effect<void, unknown, Cloudflare.WorkerEnvironment> = Effect.gen(
          function* () {
            const env = yield* Cloudflare.WorkerEnvironment;
            const store = makeLinearSessionStore({
              get: (key) =>
                sessionStore
                  .get(key)
                  .pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env)),
              put: (key, value) =>
                sessionStore
                  .put(key, value)
                  .pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env)),
            });
            const orgAuth = makeLinearOrgAuthStore({
              get: (key) =>
                orgAuthStore
                  .get(key)
                  .pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env)),
            });
            const fetchOpenCode = async (input: string | URL | Request, init?: RequestInit) => {
              const request = input instanceof Request ? input : new Request(input, init);
              const url = new URL(request.url);
              url.protocol = "http:";
              url.hostname = openCodePrivateHost;
              url.port = openCodePrivatePort;
              const opencodeRequest = new Request(url, request);
              opencodeRequest.headers.set("host", url.host);
              const webResponse = await Effect.gen(function* () {
                const response = yield* opencodeBinding
                  .fetch(
                    HttpServerRequest.toClientRequest(HttpServerRequest.fromWeb(opencodeRequest)),
                  )
                  .pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env));

                const withoutBody =
                  response.status === 101 ||
                  response.status === 204 ||
                  response.status === 205 ||
                  response.status === 304;
                return HttpServerResponse.toWeb(HttpServerResponse.fromClientResponse(response), {
                  withoutBody,
                });
              }).pipe(Effect.runPromise);

              return webResponse;
            };
            const opencode = makeOpenCodeClient(fetchOpenCode);
            const observer = makeOpenCodeRunObserverService(observers);
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
              Effect.provideService(LinearHttpClient, linear),
              Effect.provideService(LinearOrgAuthStore, orgAuth),
              Effect.provideService(LinearSessionStore, store),
              Effect.provideService(OpenCodeClient, opencode),
              Effect.provideService(OpenCodeRunObserverService, observer),
            );

            yield* Effect.log("linear webhook processed", {
              webhookId: payload.webhookId,
              type: payload.type,
              action: payload.action,
              organizationId: payload.organizationId,
            });
          },
        );

        return effect;
      }),
    );
  }).pipe(
    Effect.provide([
      Cloudflare.KVNamespaceBindingLive,
      Cloudflare.QueueEventSourceLive,
      Cloudflare.VpcServiceBindingPolicyLive,
      Cloudflare.VpcServiceBindingLive,
      LinearHttpClient.layer,
    ]),
  ),
) {}
