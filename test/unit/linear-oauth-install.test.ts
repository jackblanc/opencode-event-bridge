import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { completeLinearOAuthInstall } from "../../src/linear/oauth/install.ts";
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
  it("stores auth for the allowed organization", async () => {
    const state = makeState();
    const orgAuth = makeOrgAuth();

    const result = await Effect.runPromise(
      completeLinearOAuthInstall({
        allowedOrganizationId: "org-id",
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "oauth-code",
        linear: makeLinear("org-id"),
        orgAuth: orgAuth.orgAuth,
        request,
        state: state.state,
        stateValue: "state-id",
      }),
    );

    expect(result.organizationId).toBe("org-id");
    expect(state.deletes).toEqual(["state-id"]);
    expect(orgAuth.writes).toEqual([
      {
        key: "org-id",
        value: JSON.stringify({
          accessToken: "linear-access-token",
          accessTokenExpiresAt: result.accessTokenExpiresAt,
          appUserId: "app-user-id",
          organizationId: "org-id",
          organizationName: "Example",
          refreshToken: "linear-refresh-token",
        }),
      },
    ]);
  });

  it("rejects other organizations before storing auth", async () => {
    const state = makeState();
    const orgAuth = makeOrgAuth();

    const error = await Effect.runPromise(
      completeLinearOAuthInstall({
        allowedOrganizationId: "org-id",
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "oauth-code",
        linear: makeLinear("other-org-id"),
        orgAuth: orgAuth.orgAuth,
        request,
        state: state.state,
        stateValue: "state-id",
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LinearOAuthForbidden);
    expect(error.reason).toBe("OrganizationNotAllowed");
    expect(state.deletes).toEqual(["state-id"]);
    expect(orgAuth.writes).toEqual([]);
  });
});
