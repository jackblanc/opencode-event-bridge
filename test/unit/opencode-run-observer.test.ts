import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type {
  LinearAgentActivityContent,
  LinearHttpClientService,
} from "../../src/linear/client/client.ts";
import type { LinearSessionStoreService } from "../../src/linear/session/store.ts";
import type { OpenCodeClientService } from "../../src/opencode/client.ts";
import type { OpenCodeRunObserverStorage } from "../../src/opencode/run-observer.ts";

import { LinearOrgAuthStoreError } from "../../src/linear/oauth/auth.ts";
import { OpenCodeClientError } from "../../src/opencode/client.ts";
import { makeOpenCodeRunObserverHandler } from "../../src/opencode/run-observer.ts";

const run = {
  linearAgentSessionId: "linear-session-id",
  opencodeSessionId: "opencode-session-id",
  organizationId: "org-id",
  projectDirectory: "/Users/jackblanc/projects/opencode-event-bridge",
  workspaceDirectory: "/tmp/opencode/oeb-1",
};

const makeState = (seed: unknown) => {
  let stored = seed;
  let alarms = 0;
  let clears = 0;

  return {
    clearCount: () => clears,
    stored: () => stored,
    alarmCount: () => alarms,
    state: {
      clear: () =>
        Effect.sync(() => {
          stored = undefined;
          clears = clears + 1;
        }).pipe(Effect.asVoid),
      get: () => Effect.succeed(stored),
      put: (next) =>
        Effect.sync(() => {
          stored = next;
        }).pipe(Effect.asVoid),
      schedule: () =>
        Effect.sync(() => {
          alarms = alarms + 1;
        }).pipe(Effect.asVoid),
    } satisfies OpenCodeRunObserverStorage,
  };
};

const makeLinear = (
  activities: Array<{ readonly content: LinearAgentActivityContent; readonly sessionId: string }>,
) =>
  ({
    addIssueLabel: () => Effect.die("unused"),
    createAgentActivity: (activity) =>
      Effect.sync(() => {
        activities.push({
          content: activity.content,
          sessionId: activity.agentSessionId,
        });
      }).pipe(Effect.as({ id: "activity-id" })),
    exchangeOAuthCode: () => Effect.die("unused"),
    fetchViewer: () => Effect.die("unused"),
    getIssueAgentSessionIds: () => Effect.die("unused"),
    getIssueLabels: () => Effect.die("unused"),
    refreshOAuthToken: () => Effect.die("unused"),
    updateAgentSessionExternalUrls: () => Effect.die("unused"),
    updateAgentSessionPlan: () => Effect.die("unused"),
  }) satisfies LinearHttpClientService;

const opencode = {
  abortSession: () => Effect.die("unused"),
  completedResponse: () => Effect.succeed({ body: "done" }),
  createSession: () => Effect.die("unused"),
  createWorktree: () => Effect.die("unused"),
  listPendingPermissions: () => Effect.die("unused"),
  listPendingQuestions: () => Effect.die("unused"),
  listProjects: () => Effect.die("unused"),
  listSessionTree: () => Effect.die("unused"),
  listWorktrees: () => Effect.die("unused"),
  promptAsync: () => Effect.die("unused"),
  removeWorktree: () => Effect.die("unused"),
  replyPermission: () => Effect.die("unused"),
  replyQuestion: () => Effect.die("unused"),
  waitUntilIdle: () => Effect.void,
} satisfies OpenCodeClientService;

const store = {
  deletePendingInput: () => Effect.die("unused"),
  deleteSessionLocator: () => Effect.die("unused"),
  getPendingInput: () => Effect.die("unused"),
  getSessionLocator: () => Effect.die("unused"),
  putPendingInput: () => Effect.die("unused"),
  putSessionLocator: () => Effect.die("unused"),
} satisfies LinearSessionStoreService;

describe("OpenCode run observer", () => {
  it("reschedules auth failures without clearing the active run", async () => {
    const state = makeState(run);
    const handler = makeOpenCodeRunObserverHandler({
      authStore: {
        getOrgAuth: () =>
          Effect.fail(new LinearOrgAuthStoreError({ reason: "MissingOrganizationAuth" })),
      },
      linear: makeLinear([]),
      opencode,
      state: state.state,
      store,
    });

    await Effect.runPromise(handler.alarm());

    expect(state.alarmCount()).toBe(1);
    expect(state.clearCount()).toBe(0);
    expect(state.stored()).toEqual(run);
  });

  it("posts the completed response and clears the active run", async () => {
    const state = makeState(run);
    const activities: Array<{
      readonly content: LinearAgentActivityContent;
      readonly sessionId: string;
    }> = [];
    const handler = makeOpenCodeRunObserverHandler({
      authStore: {
        getOrgAuth: () =>
          Effect.succeed({
            accessToken: "linear-access-token",
            accessTokenExpiresAt: Date.now() + 1_000,
            appUserId: "app-user-id",
            organizationId: "org-id",
            organizationName: "Example",
            refreshToken: "refresh-token",
          }),
      },
      linear: makeLinear(activities),
      opencode,
      state: state.state,
      store,
    });

    await Effect.runPromise(handler.alarm());

    expect(activities).toEqual([
      {
        content: { body: "done", type: "response" },
        sessionId: "linear-session-id",
      },
    ]);
    expect(state.clearCount()).toBe(1);
    expect(state.stored()).toBeUndefined();
  });

  it("reschedules pending input without clearing the active run", async () => {
    const state = makeState(run);
    const activities: Array<{
      readonly content: LinearAgentActivityContent;
      readonly sessionId: string;
    }> = [];
    const pendingOpencode = {
      ...opencode,
      waitUntilIdle: () => Effect.fail(new OpenCodeClientError({ reason: "InputPending" })),
    } satisfies OpenCodeClientService;
    const handler = makeOpenCodeRunObserverHandler({
      authStore: {
        getOrgAuth: () =>
          Effect.succeed({
            accessToken: "linear-access-token",
            accessTokenExpiresAt: Date.now() + 1_000,
            appUserId: "app-user-id",
            organizationId: "org-id",
            organizationName: "Example",
            refreshToken: "refresh-token",
          }),
      },
      linear: makeLinear(activities),
      opencode: pendingOpencode,
      state: state.state,
      store,
    });

    await Effect.runPromise(handler.alarm());

    expect(activities).toEqual([]);
    expect(state.alarmCount()).toBe(1);
    expect(state.clearCount()).toBe(0);
    expect(state.stored()).toEqual(run);
  });

  it("clears invalid stored run records", async () => {
    const state = makeState({});
    const handler = makeOpenCodeRunObserverHandler({
      authStore: {
        getOrgAuth: () => Effect.die("unused"),
      },
      linear: makeLinear([]),
      opencode,
      state: state.state,
      store,
    });

    await Effect.runPromise(handler.alarm());

    expect(state.clearCount()).toBe(1);
  });
});
