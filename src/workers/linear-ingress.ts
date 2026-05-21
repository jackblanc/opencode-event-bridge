import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
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
    name: makeStageWorkerName(stack.stage, "linear-webhook"),
  })),
  Effect.gen(function* () {
    const queueResource = yield* LinearWebhookQueue;
    const queue = yield* Cloudflare.QueueBinding.bind(queueResource);
    const oauthStateResource = yield* LinearOAuthStateStore;
    const oauthState = yield* Cloudflare.KVNamespace.bind(oauthStateResource);
    const orgAuthResource = yield* LinearOrgAuthStore;
    const orgAuth = yield* Cloudflare.KVNamespace.bind(orgAuthResource);
    const linear = yield* LinearHttpClient;
    const oauthClientId = yield* Alchemy.Secret("LINEAR_OAUTH_CLIENT_ID");
    const oauthClientSecret = yield* Alchemy.Secret("LINEAR_OAUTH_CLIENT_SECRET");
    const webhookSecret = yield* Alchemy.Secret("LINEAR_WEBHOOK_SECRET");

    const group = HttpApiBuilder.group(LinearWebhookApi, "LinearWebhook", (handlers) =>
      handlers
        .handle("authorizeLinearOAuth", ({ request }) =>
          Effect.gen(function* () {
            const clientId = yield* oauthClientId;
            const url = yield* makeLinearOAuthAuthorizeUrl({
              clientId: Redacted.value(clientId),
              request,
              state: oauthState,
            });

            return HttpServerResponse.fromWeb(Response.redirect(url, 302));
          }),
        )
        .handle("completeLinearOAuth", ({ request, query }) =>
          Effect.gen(function* () {
            const clientId = yield* oauthClientId;
            const clientSecret = yield* oauthClientSecret;
            yield* completeLinearOAuthInstall({
              clientId: Redacted.value(clientId),
              clientSecret: Redacted.value(clientSecret),
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
            const linearWebhookSecret = yield* webhookSecret;
            const rawBody = yield* request.arrayBuffer.pipe(Effect.orDie);
            return yield* receiveLinearWebhook({
              event: headers["linear-event"],
              queue,
              rawBody,
              signature: headers["linear-signature"],
              webhookSecret: Redacted.value(linearWebhookSecret),
            });
          }),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(LinearWebhookApi).pipe(
        Layer.provide(group),
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
        Effect.map((handler) => handler.pipe(Effect.provide(BrowserCrypto.layer))),
      ),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.KVNamespaceBindingLive,
      Cloudflare.QueueBindingLive,
      LinearHttpClient.layer,
    ]),
  ),
) {}
