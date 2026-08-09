import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Schema } from "effect";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
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

export const decodeLinearWebhookQueueMessage = (input: {
  readonly body: unknown;
  readonly messageId: string;
}) =>
  Schema.decodeUnknownEffect(LinearWebhookPayload)(input.body).pipe(
    Effect.tapError((cause) =>
      Effect.logError("invalid linear webhook queue message", {
        cause,
        messageId: input.messageId,
      }),
    ),
    Effect.option,
  );

export default class LinearWebhookProcessor extends Cloudflare.Worker<LinearWebhookProcessor>()(
  "LinearWebhookProcessor",
  Stack.useSync((stack) => ({
    main: import.meta.filename,
    name: makeStageWorkerName({ stage: stack.stage, suffix: "event-processor" }),
    url: false,
  })),
  Effect.gen(function* () {
    const queueResource = yield* LinearWebhookQueue;
    const sessionStoreResource = yield* LinearSessionStoreKv;
    const sessionStore = yield* Cloudflare.KV.ReadWriteNamespace(sessionStoreResource);
    const orgAuthResource = yield* LinearOrgAuthStoreResource;
    const orgAuthStore = yield* Cloudflare.KV.ReadWriteNamespace(orgAuthResource);
    const oauthClientId = yield* Config.redacted("LINEAR_OAUTH_CLIENT_ID");
    const oauthClientSecret = yield* Config.redacted("LINEAR_OAUTH_CLIENT_SECRET");
    const allowedOrganizationId = yield* Config.nonEmptyString("LINEAR_ALLOWED_ORGANIZATION_ID");
    const opencodeService = yield* OpenCodeVpcService.pipe(Effect.orDie);
    const bindVpcService = yield* Cloudflare.VpcService.VpcServiceBinding;
    const opencodeBinding = yield* bindVpcService(opencodeService);
    const observers = yield* OpenCodeRunObserver;
    const linear = yield* LinearHttpClient;

    yield* Cloudflare.Queues.consumeQueueMessages(queueResource, (stream) =>
      Stream.runForEach(stream, (msg) => {
        const effect = Effect.gen(function* () {
          const messageId = "unknown";
          const env = yield* Cloudflare.WorkerEnvironment;
          const ctx = yield* Alchemy.RuntimeContext;
          const store = makeLinearSessionStore({
            get: (key) =>
              sessionStore
                .get(key)
                .pipe(
                  Effect.provideService(Alchemy.RuntimeContext, ctx),
                  Effect.provideService(Cloudflare.WorkerEnvironment, env),
                ),
            put: (key, value) =>
              sessionStore
                .put(key, value)
                .pipe(
                  Effect.provideService(Alchemy.RuntimeContext, ctx),
                  Effect.provideService(Cloudflare.WorkerEnvironment, env),
                ),
            delete: (key) =>
              sessionStore
                .delete(key)
                .pipe(
                  Effect.provideService(Alchemy.RuntimeContext, ctx),
                  Effect.provideService(Cloudflare.WorkerEnvironment, env),
                ),
          });
          const orgAuth = makeLinearOrgAuthStore({
            kv: {
              get: (key) =>
                orgAuthStore
                  .get(key)
                  .pipe(
                    Effect.provideService(Alchemy.RuntimeContext, ctx),
                    Effect.provideService(Cloudflare.WorkerEnvironment, env),
                  ),
              put: (key, value) =>
                orgAuthStore
                  .put(key, value)
                  .pipe(
                    Effect.provideService(Alchemy.RuntimeContext, ctx),
                    Effect.provideService(Cloudflare.WorkerEnvironment, env),
                  ),
            },
            refresh: (record) =>
              Effect.gen(function* () {
                const token = yield* linear.refreshOAuthToken({
                  clientId: Redacted.value(oauthClientId),
                  clientSecret: Redacted.value(oauthClientSecret),
                  refreshToken: record.refreshToken,
                });
                const now = yield* Clock.currentTimeMillis;

                return {
                  ...record,
                  accessToken: token.access_token,
                  accessTokenExpiresAt: now + token.expires_in * 1_000,
                  refreshToken: token.refresh_token,
                };
              }),
          });
          const fetchOpenCode = (input: string | URL | Request, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            url.protocol = "http:";
            url.hostname = openCodePrivateHost;
            url.port = openCodePrivatePort;
            const opencodeRequest = new Request(url, request);
            opencodeRequest.headers.set("host", url.host);
            return Effect.gen(function* () {
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
          };
          const opencode = makeOpenCodeClient({ fetch: fetchOpenCode });
          const observer = makeOpenCodeRunObserverService(observers);
          const payloadOption = yield* decodeLinearWebhookQueueMessage({
            body: msg.body,
            messageId,
          });

          if (Option.isNone(payloadOption)) {
            return;
          }

          const payload = payloadOption.value;

          yield* processLinearWebhook({ allowedOrganizationId, payload }).pipe(
            Effect.tapCause((cause) =>
              Effect.logError("linear webhook queue message failed", {
                action: payload.action,
                agentSessionId:
                  payload.type === "AgentSessionEvent" ? payload.agentSession.id : undefined,
                cause: Cause.pretty(cause),
                issueId:
                  payload.type === "AgentSessionEvent"
                    ? payload.agentSession.issue.id
                    : payload.data.id,
                issueIdentifier:
                  payload.type === "AgentSessionEvent"
                    ? payload.agentSession.issue.identifier
                    : payload.data.identifier,
                messageId,
                organizationId: payload.organizationId,
                type: payload.type,
                webhookId: payload.webhookId,
              }),
            ),
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
        });

        return effect;
      }),
    );

    return {};
  }).pipe(
    Effect.provide([
      Cloudflare.KV.ReadWriteNamespaceBinding,
      Cloudflare.Queues.EventSourceLive,
      Cloudflare.VpcService.VpcServiceBindingLive,
      LinearHttpClient.layer,
    ]),
  ),
) {}
