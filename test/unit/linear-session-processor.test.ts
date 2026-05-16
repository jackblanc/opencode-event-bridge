import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type {
  LinearAgentSessionKey,
  LinearIssueWorktreeKey,
} from "../../src/linear/session/store.ts";
import type { LinearWebhookPayload } from "../../src/linear/webhook/payload.ts";
import type { OpenCodeClientService } from "../../src/opencode/client.ts";

import { processLinearWebhook } from "../../src/linear/session/process.ts";
import {
  agentSessionKey,
  issueWorktreeKey,
  LinearSessionStore,
  makeLinearSessionStore,
} from "../../src/linear/session/store.ts";
import { OpenCodeClient } from "../../src/opencode/client.ts";

const makeKv = (seed?: ReadonlyMap<string, string>) => {
  const values = new Map(seed);

  return {
    kv: {
      get: (key: LinearIssueWorktreeKey | LinearAgentSessionKey) =>
        Effect.sync(() => values.get(key) ?? null),
      put: (key: LinearIssueWorktreeKey | LinearAgentSessionKey, value: string) =>
        Effect.sync(() => values.set(key, value)).pipe(Effect.asVoid),
    },
    values,
  };
};

const createdPayload = (): LinearWebhookPayload => ({
  action: "created",
  agentSession: {
    appUserId: "app-user-id",
    archivedAt: null,
    comment: {
      body: "start",
      id: "comment-id",
      issueId: "issue-id",
      userId: "user-id",
    },
    commentId: "comment-id",
    createdAt: "2026-05-14T00:00:00.000Z",
    creatorId: null,
    endedAt: null,
    id: "linear-session-id",
    issue: {
      description: "Issue body",
      id: "issue-id",
      identifier: "OEB-1",
      team: {
        id: "team-id",
        key: "OEB",
        name: "OpenCode Event Bridge",
      },
      teamId: "team-id",
      title: "Wire Linear to OpenCode",
      url: "https://linear.app/example/issue/OEB-1",
    },
    issueId: "issue-id",
    organizationId: "org-id",
    sourceCommentId: null,
    sourceMetadata: null,
    startedAt: null,
    status: "pending",
    summary: null,
    updatedAt: "2026-05-14T00:00:00.000Z",
    url: "https://linear.app/example/agent-session/linear-session-id",
  },
  appUserId: "app-user-id",
  createdAt: "2026-05-14T00:00:00.000Z",
  guidance: null,
  oauthClientId: "oauth-client-id",
  organizationId: "org-id",
  previousComments: null,
  promptContext: "start",
  type: "AgentSessionEvent",
  webhookId: "webhook-id",
  webhookTimestamp: 1,
});

const promptedPayload = (): LinearWebhookPayload => ({
  ...createdPayload(),
  action: "prompted",
  agentActivity: {
    agentSessionId: "linear-session-id",
    content: {
      body: "continue here",
      type: "text",
    },
    createdAt: "2026-05-14T00:01:00.000Z",
    id: "activity-id",
    signal: null,
    updatedAt: "2026-05-14T00:01:00.000Z",
    userId: "user-id",
  },
  guidance: null,
  promptContext: null,
  webhookId: "prompted-webhook-id",
});

describe("processLinearWebhook", () => {
  it("creates a workspace and new OpenCode session for created Linear agent sessions", async () => {
    const store = makeKv();
    const worktrees: Array<{ readonly branch: string }> = [];
    const sessions: Array<{ readonly title: string; readonly workspaceDirectory: string }> = [];
    const messages: Array<{
      readonly body: string;
      readonly sessionId: string;
      readonly workspaceDirectory: string;
    }> = [];
    const opencode: OpenCodeClientService = {
      createSession: (input) =>
        Effect.sync(() => {
          sessions.push(input);
          return { id: "opencode-session-id" };
        }),
      createWorktree: (input) =>
        Effect.sync(() => {
          worktrees.push(input);
          return { workspaceDirectory: "/tmp/opencode/oeb-1" };
        }),
      sendMessage: (input) => Effect.sync(() => messages.push(input)).pipe(Effect.asVoid),
    };

    await Effect.runPromise(
      processLinearWebhook(createdPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
        ]),
      ),
    );

    expect(worktrees).toEqual([{ branch: "oeb-1" }]);
    expect(sessions).toEqual([
      { title: "Wire Linear to OpenCode", workspaceDirectory: "/tmp/opencode/oeb-1" },
    ]);
    expect(messages).toEqual([
      {
        body: "start",
        sessionId: "opencode-session-id",
        workspaceDirectory: "/tmp/opencode/oeb-1",
      },
    ]);
    expect(
      store.values.get(issueWorktreeKey({ linearIssueId: "issue-id", organizationId: "org-id" })),
    ).toBe(
      JSON.stringify({
        linearIssueId: "issue-id",
        opencodeWorkspaceDirectory: "/tmp/opencode/oeb-1",
        organizationId: "org-id",
      }),
    );
    expect(
      store.values.get(
        agentSessionKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
      ),
    ).toBe(
      JSON.stringify({
        linearAgentSessionId: "linear-session-id",
        linearIssueId: "issue-id",
        opencodeWorkspaceDirectory: "/tmp/opencode/oeb-1",
        opencodeSessionId: "opencode-session-id",
        organizationId: "org-id",
      }),
    );
  });

  it("ignores duplicate created Linear agent sessions", async () => {
    const store = makeKv(
      new Map([
        [
          agentSessionKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
          JSON.stringify({
            linearAgentSessionId: "linear-session-id",
            linearIssueId: "issue-id",
            opencodeSessionId: "opencode-session-id",
            opencodeWorkspaceDirectory: "/tmp/opencode/oeb-1",
            organizationId: "org-id",
          }),
        ],
      ]),
    );
    const worktrees: Array<{ readonly branch: string }> = [];
    const sessions: Array<{ readonly title: string; readonly workspaceDirectory: string }> = [];
    const messages: Array<{
      readonly body: string;
      readonly sessionId: string;
      readonly workspaceDirectory: string;
    }> = [];
    const opencode: OpenCodeClientService = {
      createSession: (input) =>
        Effect.sync(() => {
          sessions.push(input);
          return { id: "unused" };
        }),
      createWorktree: (input) =>
        Effect.sync(() => {
          worktrees.push(input);
          return { workspaceDirectory: "unused" };
        }),
      sendMessage: (input) => Effect.sync(() => messages.push(input)).pipe(Effect.asVoid),
    };

    await Effect.runPromise(
      processLinearWebhook(createdPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
        ]),
      ),
    );

    expect(worktrees).toEqual([]);
    expect(sessions).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("sends prompted Linear agent activity to the existing OpenCode session", async () => {
    const store = makeKv(
      new Map([
        [
          agentSessionKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
          JSON.stringify({
            linearAgentSessionId: "linear-session-id",
            linearIssueId: "issue-id",
            opencodeSessionId: "opencode-session-id",
            opencodeWorkspaceDirectory: "/tmp/opencode/oeb-1",
            organizationId: "org-id",
          }),
        ],
      ]),
    );
    const messages: Array<{
      readonly body: string;
      readonly sessionId: string;
      readonly workspaceDirectory: string;
    }> = [];
    const opencode: OpenCodeClientService = {
      createSession: () => Effect.succeed({ id: "unused" }),
      createWorktree: () => Effect.succeed({ workspaceDirectory: "unused" }),
      sendMessage: (input) => Effect.sync(() => messages.push(input)).pipe(Effect.asVoid),
    };

    await Effect.runPromise(
      processLinearWebhook(promptedPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
        ]),
      ),
    );

    expect(messages).toEqual([
      {
        body: "continue here",
        sessionId: "opencode-session-id",
        workspaceDirectory: "/tmp/opencode/oeb-1",
      },
    ]);
  });
});
