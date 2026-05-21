import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type {
  LinearAgentActivityContent,
  LinearHttpClientService,
} from "../../src/linear/client/client.ts";
import type {
  LinearAgentSessionKey,
  LinearIssueWorktreeKey,
} from "../../src/linear/session/store.ts";
import type { LinearWebhookPayload } from "../../src/linear/webhook/payload.ts";
import type { OpenCodeClientService } from "../../src/opencode/client.ts";
import type { OpenCodeRunRecord } from "../../src/opencode/run-observer.ts";

import { LinearHttpClient } from "../../src/linear/client/client.ts";
import { LinearOrgAuthStore } from "../../src/linear/oauth/auth.ts";
import { processLinearWebhook } from "../../src/linear/session/process.ts";
import {
  agentSessionKey,
  issueWorktreeKey,
  LinearSessionStore,
  makeLinearSessionStore,
} from "../../src/linear/session/store.ts";
import { OpenCodeClient } from "../../src/opencode/client.ts";
import { OpenCodeRunObserverService } from "../../src/opencode/run-observer.ts";

const makeObserver = (runs: Array<OpenCodeRunRecord>) =>
  OpenCodeRunObserverService.of({
    start: (run) =>
      Effect.sync(() => {
        runs.push(run);
      }).pipe(Effect.asVoid),
  });

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

const orgAuth = {
  accessToken: "linear-access-token",
  accessTokenExpiresAt: Date.now() + 1_000,
  appUserId: "app-user-id",
  organizationId: "org-id",
  organizationName: "Example",
  refreshToken: "refresh-token",
};

const makeOrgAuthStore = () => ({
  getOrgAuth: () => Effect.succeed(orgAuth),
});

const makeLinear = (
  activities: Array<{
    readonly agentSessionId: string;
    readonly content: LinearAgentActivityContent;
  }>,
  links: Array<{
    readonly agentSessionId: string;
    readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  }>,
  labels: ReadonlyArray<{
    readonly name: string;
    readonly parent: { readonly name: string } | null;
  }> = [{ name: "repo:opencode-event-bridge", parent: null }],
): LinearHttpClientService => ({
  createAgentActivity: (input: {
    readonly accessToken: string;
    readonly agentSessionId: string;
    readonly content: LinearAgentActivityContent;
  }) =>
    Effect.sync(() => {
      expect(input.accessToken).toBe("linear-access-token");
      activities.push({ agentSessionId: input.agentSessionId, content: input.content });
    }).pipe(Effect.asVoid),
  exchangeOAuthCode: () => Effect.die("exchangeOAuthCode is not used by session processor tests"),
  fetchViewer: () => Effect.die("fetchViewer is not used by session processor tests"),
  getIssueLabels: (input) =>
    Effect.sync(() => {
      expect(input.accessToken).toBe("linear-access-token");
      expect(input.issueId).toBe("issue-id");
      return labels;
    }),
  updateAgentSessionExternalUrls: (input) =>
    Effect.sync(() => {
      expect(input.accessToken).toBe("linear-access-token");
      links.push({ agentSessionId: input.agentSessionId, externalUrls: input.externalUrls });
    }).pipe(Effect.asVoid),
});

const createdPayload = (
  labels: ReadonlyArray<{ readonly name: string }> = [{ name: "repo:opencode-event-bridge" }],
): LinearWebhookPayload => ({
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
      labels,
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
    const worktrees: Array<{ readonly branch: string; readonly projectDirectory: string }> = [];
    const sessions: Array<{ readonly title: string; readonly workspaceDirectory: string }> = [];
    const messages: Array<{
      readonly body: string;
      readonly sessionId: string;
      readonly workspaceDirectory: string;
    }> = [];
    const runs: Array<OpenCodeRunRecord> = [];
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];
    const links: Array<{
      readonly agentSessionId: string;
      readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
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
      resolveProject: (input) =>
        Effect.sync(() => {
          expect(input).toEqual({ project: "opencode-event-bridge" });
          return {
            directory: "/Users/jackblanc/projects/opencode-event-bridge",
            id: "project-id",
          };
        }),
      completedResponse: () => Effect.succeed({ body: "OpenCode finished" }),
      waitUntilIdle: () => Effect.void,
      promptAsync: (input) =>
        Effect.sync(() => {
          messages.push(input);
        }).pipe(Effect.asVoid),
    };

    await Effect.runPromise(
      processLinearWebhook(createdPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear(activities, links)),
          Layer.succeed(LinearOrgAuthStore)(makeOrgAuthStore()),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
          Layer.succeed(OpenCodeRunObserverService)(makeObserver(runs)),
        ]),
      ),
    );

    expect(worktrees).toEqual([
      { branch: "oeb-1", projectDirectory: "/Users/jackblanc/projects/opencode-event-bridge" },
    ]);
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
    expect(activities).toEqual([
      {
        agentSessionId: "linear-session-id",
        content: { body: "Accepted. Starting OpenCode.", type: "thought" },
      },
    ]);
    expect(runs).toEqual([
      {
        accessToken: "linear-access-token",
        linearAgentSessionId: "linear-session-id",
        linearIssueIdentifier: "OEB-1",
        opencodeSessionId: "opencode-session-id",
        opencodeWorkspaceDirectory: "/tmp/opencode/oeb-1",
      },
    ]);
    expect(links).toEqual([
      {
        agentSessionId: "linear-session-id",
        externalUrls: [
          {
            label: "OpenCode",
            url: "http://localhost:4096/L1VzZXJzL2phY2tibGFuYy9wcm9qZWN0cy9vcGVuY29kZS1ldmVudC1icmlkZ2U/session/opencode-session-id",
          },
        ],
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
    const worktrees: Array<{ readonly branch: string; readonly projectDirectory: string }> = [];
    const sessions: Array<{ readonly title: string; readonly workspaceDirectory: string }> = [];
    const messages: Array<{
      readonly body: string;
      readonly sessionId: string;
      readonly workspaceDirectory: string;
    }> = [];
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];
    const links: Array<{
      readonly agentSessionId: string;
      readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
    }> = [];
    const runs: Array<OpenCodeRunRecord> = [];
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
      resolveProject: () => Effect.succeed({ directory: "unused", id: "unused" }),
      completedResponse: () => Effect.succeed({ body: "unused" }),
      waitUntilIdle: () => Effect.void,
      promptAsync: (input) =>
        Effect.sync(() => {
          messages.push(input);
        }).pipe(Effect.asVoid),
    };

    await Effect.runPromise(
      processLinearWebhook(createdPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear(activities, links)),
          Layer.succeed(LinearOrgAuthStore)(makeOrgAuthStore()),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
          Layer.succeed(OpenCodeRunObserverService)(makeObserver(runs)),
        ]),
      ),
    );

    expect(worktrees).toEqual([]);
    expect(sessions).toEqual([]);
    expect(messages).toEqual([]);
    expect(activities).toEqual([]);
    expect(links).toEqual([]);
  });

  it("posts a Linear error activity when repository routing is missing", async () => {
    const store = makeKv();
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];
    const links: Array<{
      readonly agentSessionId: string;
      readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
    }> = [];
    const opencode: OpenCodeClientService = {
      createSession: () => Effect.succeed({ id: "unused" }),
      createWorktree: () => Effect.succeed({ workspaceDirectory: "unused" }),
      resolveProject: () => Effect.succeed({ directory: "unused", id: "unused" }),
      completedResponse: () => Effect.succeed({ body: "unused" }),
      waitUntilIdle: () => Effect.void,
      promptAsync: () => Effect.void,
    };

    await Effect.runPromise(
      processLinearWebhook(createdPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear(activities, links, [])),
          Layer.succeed(LinearOrgAuthStore)(makeOrgAuthStore()),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
          Layer.succeed(OpenCodeRunObserverService)(makeObserver([])),
        ]),
      ),
    );

    expect(activities).toEqual([
      {
        agentSessionId: "linear-session-id",
        content: { body: "Accepted. Starting OpenCode.", type: "thought" },
      },
      {
        agentSessionId: "linear-session-id",
        content: {
          body: "I cannot start because this issue is missing a `repo:*` label.",
          type: "error",
        },
      },
    ]);
    expect(links).toEqual([]);
  });

  it("posts a Linear error activity when repository routing is ambiguous", async () => {
    const store = makeKv();
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];
    const links: Array<{
      readonly agentSessionId: string;
      readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
    }> = [];
    const opencode: OpenCodeClientService = {
      createSession: () => Effect.succeed({ id: "unused" }),
      createWorktree: () => Effect.succeed({ workspaceDirectory: "unused" }),
      resolveProject: () => Effect.succeed({ directory: "unused", id: "unused" }),
      completedResponse: () => Effect.succeed({ body: "unused" }),
      waitUntilIdle: () => Effect.void,
      promptAsync: () => Effect.void,
    };

    await Effect.runPromise(
      processLinearWebhook(createdPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(
            makeLinear(activities, links, [
              { name: "repo:project-a", parent: null },
              { name: "repo:project-b", parent: null },
            ]),
          ),
          Layer.succeed(LinearOrgAuthStore)(makeOrgAuthStore()),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
          Layer.succeed(OpenCodeRunObserverService)(makeObserver([])),
        ]),
      ),
    );

    expect(activities).toEqual([
      {
        agentSessionId: "linear-session-id",
        content: { body: "Accepted. Starting OpenCode.", type: "thought" },
      },
      {
        agentSessionId: "linear-session-id",
        content: {
          body: "I cannot start because this issue has multiple `repo:*` labels.",
          type: "error",
        },
      },
    ]);
    expect(links).toEqual([]);
  });

  it("uses child labels in the repo label group for repository routing", async () => {
    const store = makeKv();
    const worktrees: Array<{ readonly branch: string; readonly projectDirectory: string }> = [];
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];
    const links: Array<{
      readonly agentSessionId: string;
      readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
    }> = [];
    const runs: Array<OpenCodeRunRecord> = [];
    const opencode: OpenCodeClientService = {
      createSession: () => Effect.succeed({ id: "opencode-session-id" }),
      createWorktree: (input) =>
        Effect.sync(() => {
          worktrees.push(input);
          return { workspaceDirectory: "/tmp/opencode/oeb-1" };
        }),
      resolveProject: (input) =>
        Effect.sync(() => {
          expect(input).toEqual({ project: "opencode-event-bridge" });
          return {
            directory: "/Users/jackblanc/projects/opencode-event-bridge",
            id: "project-id",
          };
        }),
      completedResponse: () => Effect.succeed({ body: "done" }),
      waitUntilIdle: () => Effect.void,
      promptAsync: () => Effect.void,
    };

    await Effect.runPromise(
      processLinearWebhook(createdPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(
            makeLinear(activities, links, [
              { name: "opencode-event-bridge", parent: { name: "repo" } },
            ]),
          ),
          Layer.succeed(LinearOrgAuthStore)(makeOrgAuthStore()),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
          Layer.succeed(OpenCodeRunObserverService)(makeObserver(runs)),
        ]),
      ),
    );

    expect(worktrees).toEqual([
      { branch: "oeb-1", projectDirectory: "/Users/jackblanc/projects/opencode-event-bridge" },
    ]);
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
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];
    const links: Array<{
      readonly agentSessionId: string;
      readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
    }> = [];
    const runs: Array<OpenCodeRunRecord> = [];
    const opencode: OpenCodeClientService = {
      createSession: () => Effect.succeed({ id: "unused" }),
      createWorktree: () => Effect.succeed({ workspaceDirectory: "unused" }),
      resolveProject: () => Effect.succeed({ directory: "unused", id: "unused" }),
      completedResponse: () => Effect.succeed({ body: "continued" }),
      waitUntilIdle: () => Effect.void,
      promptAsync: (input) =>
        Effect.sync(() => {
          messages.push(input);
        }).pipe(Effect.asVoid),
    };

    await Effect.runPromise(
      processLinearWebhook(promptedPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear(activities, links)),
          Layer.succeed(LinearOrgAuthStore)(makeOrgAuthStore()),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
          Layer.succeed(OpenCodeRunObserverService)(makeObserver(runs)),
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
    expect(activities).toEqual([
      {
        agentSessionId: "linear-session-id",
        content: { body: "Accepted. Continuing OpenCode.", type: "thought" },
      },
    ]);
    expect(runs).toEqual([
      {
        accessToken: "linear-access-token",
        linearAgentSessionId: "linear-session-id",
        linearIssueIdentifier: "OEB-1",
        opencodeSessionId: "opencode-session-id",
        opencodeWorkspaceDirectory: "/tmp/opencode/oeb-1",
      },
    ]);
    expect(links).toEqual([]);
  });

  it("posts a Linear error activity when a follow-up has no stored OpenCode session", async () => {
    const store = makeKv();
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];
    const links: Array<{
      readonly agentSessionId: string;
      readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
    }> = [];
    const opencode: OpenCodeClientService = {
      createSession: () => Effect.succeed({ id: "unused" }),
      createWorktree: () => Effect.succeed({ workspaceDirectory: "unused" }),
      resolveProject: () => Effect.succeed({ directory: "unused", id: "unused" }),
      completedResponse: () => Effect.succeed({ body: "unused" }),
      waitUntilIdle: () => Effect.void,
      promptAsync: () => Effect.void,
    };

    await Effect.runPromise(
      processLinearWebhook(promptedPayload()).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear(activities, links)),
          Layer.succeed(LinearOrgAuthStore)(makeOrgAuthStore()),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(opencode),
          Layer.succeed(OpenCodeRunObserverService)(makeObserver([])),
        ]),
      ),
    );

    expect(activities).toEqual([
      {
        agentSessionId: "linear-session-id",
        content: { body: "Accepted. Continuing OpenCode.", type: "thought" },
      },
      {
        agentSessionId: "linear-session-id",
        content: {
          body: "I cannot continue because I do not have an OpenCode session for this Linear agent session.",
          type: "error",
        },
      },
    ]);
    expect(links).toEqual([]);
  });
});
