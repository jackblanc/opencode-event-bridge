import { Crypto, Schema } from "effect";
import * as Effect from "effect/Effect";

import type { LinearHttpClientError } from "../client/client.ts";
import type { LinearOAuthTokenResponse, LinearViewerGraphqlResponse } from "./schema.ts";

import { LinearOAuthBadRequest, LinearOAuthUpstreamError } from "../webhook/api.ts";
import { LinearOrgAuthRecord } from "./schema.ts";

const linearOAuthAuthorizeUrl = "https://linear.app/oauth/authorize";
const linearOAuthScope = "write,app:mentionable,app:assignable";

const makeCallbackUrl = (request: { readonly headers: Record<string, string> }) =>
  Effect.gen(function* () {
    const host = request.headers["host"];
    if (host === undefined) {
      return yield* new LinearOAuthUpstreamError({ reason: "InvalidCallbackUrl" });
    }
    const protocol = request.headers["x-forwarded-proto"] ?? "https";
    return new URL("/api/oauth/callback", `${protocol}://${host}`).toString();
  });

export const makeLinearOAuthAuthorizeUrl = <R>(input: {
  readonly clientId: string;
  readonly request: { readonly headers: Record<string, string> };
  readonly state: {
    put(
      key: string,
      value: string,
      options: { readonly expirationTtl: number },
    ): Effect.Effect<void, unknown, R>;
  };
}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const state = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* input.state.put(state, "pending", { expirationTtl: 300 }).pipe(Effect.orDie);

    const url = new URL(linearOAuthAuthorizeUrl);
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", yield* makeCallbackUrl(input.request));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", linearOAuthScope);
    url.searchParams.set("actor", "app");
    url.searchParams.set("state", state);

    return url.toString();
  });

export const completeLinearOAuthInstall = <OAuthR, OrgAuthR>(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly linear: {
    exchangeOAuthCode(input: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly code: string;
      readonly redirectUri: string;
    }): Effect.Effect<typeof LinearOAuthTokenResponse.Type, LinearHttpClientError>;
    fetchViewer(
      accessToken: string,
    ): Effect.Effect<typeof LinearViewerGraphqlResponse.Type, LinearHttpClientError>;
  };
  readonly orgAuth: { put(key: string, value: string): Effect.Effect<void, unknown, OrgAuthR> };
  readonly request: { readonly headers: Record<string, string> };
  readonly state: {
    delete(key: string): Effect.Effect<void, unknown, OAuthR>;
    get(key: string): Effect.Effect<string | null, unknown, OAuthR>;
  };
  readonly stateValue: string;
}) =>
  Effect.gen(function* () {
    const storedState = yield* input.state.get(input.stateValue).pipe(Effect.orDie);
    yield* input.state.delete(input.stateValue).pipe(Effect.orDie);
    if (storedState === null) {
      return yield* new LinearOAuthBadRequest({ reason: "InvalidState" });
    }

    const token = yield* input.linear
      .exchangeOAuthCode({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        code: input.code,
        redirectUri: yield* makeCallbackUrl(input.request),
      })
      .pipe(
        Effect.mapError(
          (cause) => new LinearOAuthUpstreamError({ cause, reason: "InvalidTokenResponse" }),
        ),
      );
    const viewer = yield* input.linear
      .fetchViewer(token.access_token)
      .pipe(
        Effect.mapError(
          (cause) => new LinearOAuthUpstreamError({ cause, reason: "InvalidViewerResponse" }),
        ),
      );
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
        (cause) => new LinearOAuthUpstreamError({ cause, reason: "InvalidTokenResponse" }),
      ),
    );
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(LinearOrgAuthRecord))(
      encoded,
    ).pipe(
      Effect.mapError(
        (cause) => new LinearOAuthUpstreamError({ cause, reason: "InvalidTokenResponse" }),
      ),
    );
    yield* input.orgAuth.put(encoded.organizationId, serialized).pipe(Effect.orDie);

    return encoded;
  });
