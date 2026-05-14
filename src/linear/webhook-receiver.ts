import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Random, Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  LinearOAuthTokenResponse,
  LinearOrgAuthRecord,
  LinearViewerGraphqlResponse,
} from "./oauth-schema.ts";
import { LinearOAuthStateStore, LinearOrgAuthStore } from "./oauth-store.ts";
import {
  LinearWebhookApi,
  LinearWebhookBadRequest,
  LinearOAuthBadRequest,
  LinearOAuthUpstreamError,
  LinearWebhookUnauthorized,
} from "./webhook-api.ts";
import { LinearWebhookPayload } from "./webhook-payload.ts";
import { LinearWebhookQueue } from "./webhook-queue.ts";

const supportedEvents = new Set(["AgentSessionEvent", "Issue"]);
const linearOAuthAuthorizeUrl = "https://linear.app/oauth/authorize";
const linearOAuthTokenUrl = "https://api.linear.app/oauth/token";
const linearGraphqlUrl = "https://api.linear.app/graphql";
const linearOAuthScope = "write,app:mentionable,app:assignable";

const makeCallbackUrl = (request: {
  readonly headers: Record<string, string>;
  readonly url: string;
}) =>
  Effect.gen(function* () {
    const host = request.headers["host"];
    if (host === undefined) {
      return yield* Effect.fail(new LinearOAuthUpstreamError({ reason: "InvalidCallbackUrl" }));
    }
    const protocol = request.headers["x-forwarded-proto"] ?? "https";
    return new URL("/api/oauth/callback", `${protocol}://${host}`).toString();
  });

const exchangeCode = (clientId: string, clientSecret: string, code: string, redirectUri: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.post(linearOAuthTokenUrl).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      HttpClient.execute,
      Effect.mapError(() => new LinearOAuthUpstreamError({ reason: "LinearRequestFailed" })),
    );
    const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.mapError(() => new LinearOAuthUpstreamError({ reason: "LinearRequestFailed" })),
    );

    return yield* HttpClientResponse.schemaBodyJson(LinearOAuthTokenResponse)(okResponse).pipe(
      Effect.mapError(() => new LinearOAuthUpstreamError({ reason: "InvalidTokenResponse" })),
    );
  });

const fetchViewer = (accessToken: string) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(linearGraphqlUrl).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`),
      HttpClientRequest.bodyJson({
        query: "query Viewer { viewer { id organization { id name } } }",
      }),
      Effect.mapError(() => new LinearOAuthUpstreamError({ reason: "LinearRequestFailed" })),
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(() => new LinearOAuthUpstreamError({ reason: "LinearRequestFailed" })),
    );
    const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.mapError(() => new LinearOAuthUpstreamError({ reason: "LinearRequestFailed" })),
    );

    return yield* HttpClientResponse.schemaBodyJson(LinearViewerGraphqlResponse)(okResponse).pipe(
      Effect.mapError(() => new LinearOAuthUpstreamError({ reason: "InvalidViewerResponse" })),
    );
  });

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
    const oauthStateResource = yield* LinearOAuthStateStore;
    const oauthState = yield* Cloudflare.KVNamespace.bind(oauthStateResource);
    const orgAuthResource = yield* LinearOrgAuthStore;
    const orgAuth = yield* Cloudflare.KVNamespace.bind(orgAuthResource);
    const oauthClientId = yield* Alchemy.Secret("LINEAR_OAUTH_CLIENT_ID");
    const oauthClientSecret = yield* Alchemy.Secret("LINEAR_OAUTH_CLIENT_SECRET");
    const webhookSecret = yield* Alchemy.Secret("LINEAR_WEBHOOK_SECRET");

    const group = HttpApiBuilder.group(LinearWebhookApi, "LinearWebhook", (handlers) =>
      handlers
        .handle("authorizeLinearOAuth", ({ request }) =>
          Effect.gen(function* () {
            const clientId = yield* oauthClientId;
            const state = yield* Random.nextUUIDv4;
            yield* oauthState.put(state, "pending", { expirationTtl: 300 }).pipe(Effect.orDie);

            const url = new URL(linearOAuthAuthorizeUrl);
            url.searchParams.set("client_id", Redacted.value(clientId));
            url.searchParams.set("redirect_uri", yield* makeCallbackUrl(request));
            url.searchParams.set("response_type", "code");
            url.searchParams.set("scope", linearOAuthScope);
            url.searchParams.set("actor", "app");
            url.searchParams.set("state", state);

            return HttpServerResponse.fromWeb(Response.redirect(url.toString(), 302));
          }),
        )
        .handle("completeLinearOAuth", ({ request, query }) =>
          Effect.gen(function* () {
            const storedState = yield* oauthState.get(query.state).pipe(Effect.orDie);
            yield* oauthState.delete(query.state).pipe(Effect.orDie);
            if (storedState === null) {
              return yield* Effect.fail(new LinearOAuthBadRequest({ reason: "InvalidState" }));
            }

            const clientId = yield* oauthClientId;
            const clientSecret = yield* oauthClientSecret;
            const token = yield* exchangeCode(
              Redacted.value(clientId),
              Redacted.value(clientSecret),
              query.code,
              yield* makeCallbackUrl(request),
            );
            const viewer = yield* fetchViewer(token.access_token);
            const now = Date.now();
            const record = {
              accessToken: token.access_token,
              accessTokenExpiresAt: now + token.expires_in * 1_000,
              appUserId: viewer.data.viewer.id,
              organizationId: viewer.data.viewer.organization.id,
              refreshToken: token.refresh_token,
              organizationName: viewer.data.viewer.organization.name,
            };
            const encoded = yield* Schema.decodeUnknownEffect(LinearOrgAuthRecord)(record).pipe(
              Effect.mapError(
                () => new LinearOAuthUpstreamError({ reason: "InvalidTokenResponse" }),
              ),
            );
            yield* orgAuth.put(encoded.organizationId, JSON.stringify(encoded)).pipe(Effect.orDie);

            return HttpServerResponse.fromWeb(
              new Response("Linear app installed. You can close this tab."),
            );
          }),
        )
        .handleRaw("receiveLinearWebhook", ({ request, headers }) =>
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
  }).pipe(
    Effect.provide([
      Cloudflare.KVNamespaceBindingLive,
      Cloudflare.QueueBindingLive,
      FetchHttpClient.layer,
    ]),
  ),
) {}
