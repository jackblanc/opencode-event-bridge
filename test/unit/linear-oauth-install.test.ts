import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { completeLinearOAuthInstall } from "../../src/linear/oauth/install.ts";
import { LinearOrgAuthRecord } from "../../src/linear/oauth/schema.ts";
import { LinearOAuthForbidden } from "../../src/linear/webhook/api.ts";

const tokenResponse = {
  access_token: "linear-access-token",
  expires_in: 3_600,
  refresh_token: "linear-refresh-token",
};

const makeState = () => {
  const values = new Map([["state-id", "pending"]]);
  const deletes: Array<string> = [];

  return {
    deletes,
    state: {
      delete: (key: string) =>
        Effect.sync(() => {
          deletes.push(key);
          values.delete(key);
        }).pipe(Effect.asVoid),
      get: (key: string) => Effect.sync(() => values.get(key) ?? null),
    },
  };
};

const makeOrgAuth = () => {
  const writes: Array<{ readonly key: string; readonly value: string }> = [];

  return {
    orgAuth: {
      put: (key: string, value: string) =>
        Effect.sync(() => {
          writes.push({ key, value });
        }).pipe(Effect.asVoid),
    },
    writes,
  };
};

const makeLinear = (organizationId: string) => ({
  exchangeOAuthCode: () => Effect.succeed(tokenResponse),
  fetchViewer: () =>
    Effect.succeed({
      data: {
        viewer: {
          id: "app-user-id",
          organization: { id: organizationId, name: "Example" },
        },
      },
    }),
});

const request = { headers: { host: "bridge.example.com" } };

describe("completeLinearOAuthInstall", () => {
  it.effect("stores auth for the allowed organization", () =>
    Effect.gen(function* () {
      const state = makeState();
      const orgAuth = makeOrgAuth();

      const result = yield* completeLinearOAuthInstall({
        allowedOrganizationId: "org-id",
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "oauth-code",
        linear: makeLinear("org-id"),
        orgAuth: orgAuth.orgAuth,
        request,
        state: state.state,
        stateValue: "state-id",
      });

      expect(result.organizationId).toBe("org-id");
      expect(state.deletes).toEqual(["state-id"]);
      expect(orgAuth.writes).toEqual([
        {
          key: "org-id",
          value: yield* Schema.encodeEffect(Schema.fromJsonString(LinearOrgAuthRecord))({
            accessToken: "linear-access-token",
            accessTokenExpiresAt: result.accessTokenExpiresAt,
            appUserId: "app-user-id",
            organizationId: "org-id",
            organizationName: "Example",
            refreshToken: "linear-refresh-token",
          }),
        },
      ]);
    }),
  );

  it.effect("rejects other organizations before storing auth", () =>
    Effect.gen(function* () {
      const state = makeState();
      const orgAuth = makeOrgAuth();

      const error = yield* completeLinearOAuthInstall({
        allowedOrganizationId: "org-id",
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "oauth-code",
        linear: makeLinear("other-org-id"),
        orgAuth: orgAuth.orgAuth,
        request,
        state: state.state,
        stateValue: "state-id",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LinearOAuthForbidden);
      expect(error.reason).toBe("OrganizationNotAllowed");
      expect(state.deletes).toEqual(["state-id"]);
      expect(orgAuth.writes).toEqual([]);
    }),
  );
});
