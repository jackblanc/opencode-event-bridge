import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { LinearHttpClient } from "../linear/client/client.ts";
import {
  completeLinearOAuthInstall,
  makeLinearOAuthAuthorizeUrl,
} from "../linear/oauth/install.ts";
import { LinearOAuthStateStore, LinearOrgAuthStore } from "../linear/oauth/store.ts";
import { LinearWebhookApi } from "../linear/webhook/api.ts";
import { LinearWebhookQueue } from "../linear/webhook/queue.ts";
import { receiveLinearWebhook } from "../linear/webhook/receive.ts";
import { makeStageWorkerName } from "./name.ts";

// Workers do not have filesystem-backed file responses, and this API never serves files.
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export default class LinearWebhookReceiver extends Cloudflare.Worker<LinearWebhookReceiver>()(
  "LinearWebhookReceiver",
  Stack.useSync((stack) => ({
    main: import.meta.filename,
    name: makeStageWorkerName({ stage: stack.stage, suffix: "linear-webhook" }),
  })),
  Effect.gen(function* () {
    const queueResource = yield* LinearWebhookQueue;
    const queue = yield* Cloudflare.Queues.WriteQueue(queueResource);
    const oauthStateResource = yield* LinearOAuthStateStore;
    const oauthState = yield* Cloudflare.KV.ReadWriteNamespace(oauthStateResource);
    const orgAuthResource = yield* LinearOrgAuthStore;
    const orgAuth = yield* Cloudflare.KV.ReadWriteNamespace(orgAuthResource);
    const linear = yield* LinearHttpClient;
    const oauthClientId = yield* Config.redacted("LINEAR_OAUTH_CLIENT_ID");
    const oauthClientSecret = yield* Config.redacted("LINEAR_OAUTH_CLIENT_SECRET");
    const webhookSecret = yield* Config.redacted("LINEAR_WEBHOOK_SECRET");
    const allowedOrganizationId = yield* Config.nonEmptyString("LINEAR_ALLOWED_ORGANIZATION_ID");

    const group = HttpApiBuilder.group(LinearWebhookApi, "LinearWebhook", (handlers) =>
      handlers
        .handle("authorizeLinearOAuth", ({ request }) =>
          Effect.gen(function* () {
            const url = yield* makeLinearOAuthAuthorizeUrl({
              clientId: Redacted.value(oauthClientId),
              request,
              state: oauthState,
            });

            return HttpServerResponse.fromWeb(Response.redirect(url, 302));
          }),
        )
        .handle("completeLinearOAuth", ({ request, query }) =>
          Effect.gen(function* () {
            yield* completeLinearOAuthInstall({
              allowedOrganizationId,
              clientId: Redacted.value(oauthClientId),
              clientSecret: Redacted.value(oauthClientSecret),
              code: query.code,
              linear,
              orgAuth,
              request,
              state: oauthState,
              stateValue: query.state,
            });

            return HttpServerResponse.fromWeb(
              new Response("Linear app installed. You can close this tab."),
            );
          }),
        )
        .handleRaw("receiveLinearWebhook", ({ request, headers }) =>
          Effect.gen(function* () {
            const rawBody = yield* request.arrayBuffer.pipe(Effect.orDie);
            return yield* receiveLinearWebhook({
              allowedOrganizationId,
              event: headers["linear-event"],
              queue,
              rawBody,
              signature: headers["linear-signature"],
              webhookSecret: Redacted.value(webhookSecret),
            }).pipe(
              Effect.tapCause((cause) =>
                Effect.logError("linear webhook ingress failed", {
                  bodyBytes: rawBody.byteLength,
                  cause: Cause.pretty(cause),
                  linearDelivery: headers["linear-delivery"],
                  linearEvent: headers["linear-event"],
                  rawBody: new TextDecoder().decode(rawBody),
                }),
              ),
            );
          }),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(LinearWebhookApi).pipe(
        Layer.provide(group),
        Layer.provide([BrowserCrypto.layer, Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
        Effect.map((handler) =>
          handler.pipe(
            Effect.catchCause((cause) =>
              Effect.logError("linear webhook request failed", {
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.as(
                  HttpServerResponse.text("Internal Server Error", {
                    status: 500,
                    statusText: "Internal Server Error",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.KV.ReadWriteNamespaceBinding,
      Cloudflare.Queues.WriteQueueBinding,
      LinearHttpClient.layer,
    ]),
  ),
) {}
