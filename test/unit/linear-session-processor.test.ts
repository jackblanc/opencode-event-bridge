import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type {
  LinearAgentActivityContent,
  LinearAgentActivityInput,
  LinearHttpClientService,
} from "../../src/linear/client/client.ts";
import type {
  LinearAgentSessionKey,
  LinearPendingInputKey,
} from "../../src/linear/session/store.ts";
import type {
  CreatedAgentSessionEventWebhookPayload,
  LinearWebhookPayload,
} from "../../src/linear/webhook/payload.ts";
import type { OpenCodeClientService } from "../../src/opencode/client.ts";
import type { OpenCodeRunRecord } from "../../src/opencode/run-observer.ts";

import { LinearHttpClient, LinearHttpClientError } from "../../src/linear/client/client.ts";
import { LinearOrgAuthStore } from "../../src/linear/oauth/auth.ts";
import { processLinearWebhook } from "../../src/linear/session/process.ts";
import {
  agentSessionKey,
  LinearSessionStore,
  LinearSessionStoreError,
  makeLinearSessionStore,
  pendingInputKey,
} from "../../src/linear/session/store.ts";
import { OpenCodeClient, OpenCodeClientError } from "../../src/opencode/client.ts";
import { OpenCodeRunObserverService } from "../../src/opencode/run-observer.ts";

const orgAuth = {
  accessToken: "linear-access-token",
  accessTokenExpiresAt: Date.now() + 1_000,
  appUserId: "app-user-id",
  organizationId: "org-id",
  organizationName: "Example",
  refreshToken: "refresh-token",
};

const processAllowedWebhook = (payload: LinearWebhookPayload) =>
  processLinearWebhook({ allowedOrganizationId: "org-id", payload });

const locator = {
  linearAgentSessionId: "linear-session-id",
  opencodeSessionId: "opencode-session-id",
  projectDirectory: "/workspace/opencode-event-bridge",
  workspaceDirectory: "/tmp/opencode/oeb-1",
};

type ActivityRecord = {
  readonly agentSessionId: string;
  readonly content: LinearAgentActivityContent;
  readonly signal?: LinearAgentActivityInput["signal"];
  readonly signalMetadata?: LinearAgentActivityInput["signalMetadata"];
};

const makeObserver = (runs: Array<OpenCodeRunRecord>, cancels: Array<string>) =>
  OpenCodeRunObserverService.of({
    cancel: (input) =>
      Effect.sync(() => {
        cancels.push(input.linearAgentSessionId);
      }).pipe(Effect.asVoid),
    start: (run) =>
      Effect.sync(() => {
        runs.push(run);
      }).pipe(Effect.asVoid),
  });

const makeKv = (seed?: ReadonlyMap<string, string>) => {
  const values = new Map(seed);

  return {
    kv: {
      delete: (key: LinearAgentSessionKey | LinearPendingInputKey) =>
        Effect.sync(() => values.delete(key)).pipe(Effect.asVoid),
      get: (key: LinearAgentSessionKey | LinearPendingInputKey) =>
        Effect.sync(() => values.get(key) ?? null),
      put: (key: LinearAgentSessionKey | LinearPendingInputKey, value: string) =>
        Effect.sync(() => values.set(key, value)).pipe(Effect.asVoid),
    },
    values,
  };
};

const makeLinear = (input: {
  readonly activities: Array<ActivityRecord>;
  readonly labelWriteError?: LinearHttpClientError;
  readonly labelWriteFailure?: boolean;
  readonly labelWrites?: Array<string>;
  readonly labels?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly parent: { readonly name: string } | null;
  }>;
  readonly issueSessionIds?: ReadonlyArray<string>;
}) => {
  const labels = input.labels ?? [
    { id: "label-id", name: "repo:opencode-event-bridge", parent: null },
  ];
  const issueSessionIds = input.issueSessionIds ?? ["linear-session-id"];

  return {
    addIssueLabel: (label) => {
      if (input.labelWriteError !== undefined) {
        return Effect.fail(input.labelWriteError);
      }

      if (input.labelWriteFailure === true) {
        return Effect.fail(
          new LinearHttpClientError({ cause: "forbidden", reason: "PermissionFailure" }),
        );
      }

      return Effect.sync(() => {
        input.labelWrites?.push(label.labelName);
      }).pipe(Effect.asVoid);
    },
    createAgentActivity: (activity) =>
      Effect.sync(() => {
        input.activities.push({
          agentSessionId: activity.agentSessionId,
          content: activity.content,
          signal: activity.signal,
          signalMetadata: activity.signalMetadata,
        });
      }).pipe(Effect.as({ id: `activity-${input.activities.length}` })),
    exchangeOAuthCode: () => Effect.die("unused"),
    fetchViewer: () => Effect.die("unused"),
    getIssueAgentSessionIds: () => Effect.succeed(issueSessionIds),
    getIssueLabels: () => Effect.succeed(labels),
    refreshOAuthToken: () => Effect.die("unused"),
    updateAgentSessionExternalUrls: () => Effect.void,
    updateAgentSessionPlan: () => Effect.void,
  } satisfies LinearHttpClientService;
};

const makeOpencode = (input?: {
  readonly prompts?: Array<{ readonly body: string; readonly sessionId: string }>;
  readonly aborts?: Array<string>;
  readonly permissions?: ReadonlyArray<PermissionRequest>;
  readonly projects?: ReadonlyArray<{
    readonly directory: string;
    readonly id: string;
    readonly name: string;
  }>;
  readonly questionReplies?: Array<{
    readonly answers: ReadonlyArray<ReadonlyArray<string>>;
    readonly requestId: string;
  }>;
  readonly questions?: ReadonlyArray<QuestionRequest>;
  readonly removals?: Array<string>;
  readonly removeWorktreeFailure?: boolean;
  readonly permissionReplies?: Array<string>;
  readonly permissionReplyRequests?: Array<{
    readonly reply: "once" | "always" | "reject";
    readonly requestId: string;
  }>;
  readonly sessionIds?: ReadonlyArray<string>;
  readonly worktrees?: ReadonlyArray<{ readonly workspaceDirectory: string }>;
}) =>
  ({
    abortSession: (session) =>
      Effect.sync(() => {
        input?.aborts?.push(session.sessionId);
      }).pipe(Effect.asVoid),
    completedResponse: () => Effect.succeed({ body: "done" }),
    createSession: () => Effect.succeed({ id: "opencode-session-id" }),
    createWorktree: () => Effect.succeed({ workspaceDirectory: "/tmp/opencode/oeb-1" }),
    listPendingPermissions: (request) =>
      Effect.succeed(
        (input?.permissions ?? []).filter((permission) =>
          (request.sessionIds ?? [request.sessionId]).includes(permission.sessionID),
        ),
      ),
    listPendingQuestions: (request) =>
      Effect.succeed(
        (input?.questions ?? []).filter((question) =>
          (request.sessionIds ?? [request.sessionId]).includes(question.sessionID),
        ),
      ),
    listProjects: Effect.succeed(
      input?.projects ?? [
        {
          directory: "/workspace/opencode-event-bridge",
          id: "project-id",
          name: "opencode-event-bridge",
        },
      ],
    ),
    listSessionTree: () => Effect.succeed(input?.sessionIds ?? ["opencode-session-id"]),
    listWorktrees: () => Effect.succeed(input?.worktrees ?? []),
    promptAsync: (prompt) =>
      Effect.sync(() => {
        input?.prompts?.push({ body: prompt.body, sessionId: prompt.sessionId });
      }).pipe(Effect.asVoid),
    removeWorktree: (worktree) =>
      input?.removeWorktreeFailure === true
        ? Effect.fail(new OpenCodeClientError({ detail: "remove failed", reason: "RequestFailed" }))
        : Effect.sync(() => {
            input?.removals?.push(worktree.workspaceDirectory);
          }).pipe(Effect.asVoid),
    replyPermission: (reply) =>
      Effect.sync(() => {
        input?.permissionReplies?.push(reply.reply);
        input?.permissionReplyRequests?.push({
          reply: reply.reply,
          requestId: reply.requestId,
        });
      }).pipe(Effect.asVoid),
    replyQuestion: (reply) =>
      Effect.sync(() => {
        input?.questionReplies?.push({
          answers: reply.answers,
          requestId: reply.requestId,
        });
      }).pipe(Effect.asVoid),
    waitUntilIdle: () => Effect.void,
  }) satisfies OpenCodeClientService;

const createdPayload = (): CreatedAgentSessionEventWebhookPayload => ({
  action: "created",
  agentSession: {
    appUserId: "app-user-id",
    archivedAt: null,
    comment: { body: "start", id: "comment-id", issueId: "issue-id", userId: "user-id" },
    commentId: "comment-id",
    createdAt: "2026-05-14T00:00:00.000Z",
    creatorId: null,
    endedAt: null,
    id: "linear-session-id",
    issue: {
      description: "Issue body",
      id: "issue-id",
      identifier: "OEB-1",
      labels: [{ name: "repo:opencode-event-bridge" }],
      team: { id: "team-id", key: "OEB", name: "OpenCode Event Bridge" },
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

const promptedPayload = (body: string, signal: "select" | null = null): LinearWebhookPayload => ({
  ...createdPayload(),
  action: "prompted",
  agentActivity: {
    agentSessionId: "linear-session-id",
    content: { body, type: "prompt" },
    createdAt: "2026-05-14T00:01:00.000Z",
    id: "activity-id",
    signal,
    updatedAt: "2026-05-14T00:01:00.000Z",
    userId: "user-id",
  },
  promptContext: null,
  webhookId: "prompted-webhook-id",
});

const stopPayload = (): LinearWebhookPayload => ({
  ...createdPayload(),
  action: "prompted",
  agentActivity: {
    agentSessionId: "linear-session-id",
    content: { body: "", type: "prompt" },
    createdAt: "2026-05-14T00:01:00.000Z",
    id: "activity-id",
    signal: "stop",
    updatedAt: "2026-05-14T00:01:00.000Z",
    userId: "user-id",
  },
  promptContext: null,
  webhookId: "prompted-webhook-id",
});

const issuePayload = (): LinearWebhookPayload => ({
  action: "update",
  createdAt: "2026-05-14T00:00:00.000Z",
  data: {
    id: "issue-id",
    identifier: "OEB-1",
    state: { color: "#fff", id: "state-id", name: "Done", type: "completed" },
  },
  organizationId: "org-id",
  type: "Issue",
  updatedFrom: null,
  url: "https://linear.app/example/issue/OEB-1",
  webhookId: "issue-webhook-id",
  webhookTimestamp: 1,
});

const provide = (input: {
  readonly store: ReturnType<typeof makeKv>;
  readonly linear: LinearHttpClientService;
  readonly opencode: OpenCodeClientService;
  readonly cancels?: Array<string>;
  readonly runs?: Array<OpenCodeRunRecord>;
}) =>
  [
    Layer.succeed(LinearHttpClient)(input.linear),
    Layer.succeed(LinearOrgAuthStore)({ getOrgAuth: () => Effect.succeed(orgAuth) }),
    Layer.succeed(LinearSessionStore)(makeLinearSessionStore(input.store.kv)),
    Layer.succeed(OpenCodeClient)(input.opencode),
    Layer.succeed(OpenCodeRunObserverService)(makeObserver(input.runs ?? [], input.cancels ?? [])),
  ] satisfies [
    Layer.Layer<LinearHttpClient>,
    Layer.Layer<LinearOrgAuthStore>,
    Layer.Layer<LinearSessionStore>,
    Layer.Layer<OpenCodeClient>,
    Layer.Layer<OpenCodeRunObserverService>,
  ];

describe("LinearSessionStore", () => {
  it("preserves invalid record cause and key", async () => {
    const key = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeLinearSessionStore(makeKv(new Map([[key, JSON.stringify({})]])).kv);

    const error = await Effect.runPromise(
      store
        .getSessionLocator({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" })
        .pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LinearSessionStoreError);
    expect(error.reason).toBe("InvalidRecord");
    expect(error.key).toBe(key);
  });
});

describe("processLinearWebhook", () => {
  it("rejects unauthorized organizations before reading auth", async () => {
    const store = makeKv();
    const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
    const activities: Array<ActivityRecord> = [];
    const base = createdPayload();
    const payload: LinearWebhookPayload = {
      ...base,
      agentSession: { ...base.agentSession, organizationId: "other-org-id" },
      organizationId: "other-org-id",
    };

    const result = await Effect.runPromise(
      processAllowedWebhook(payload).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      ),
    );

    expect(result).toBe("organization-not-allowed");
    expect(prompts).toEqual([]);
    expect(activities).toEqual([]);
  });

  it("starts a labelled issue and stores a session locator", async () => {
    const store = makeKv();
    const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];

    await Effect.runPromise(
      processAllowedWebhook(createdPayload()).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      ),
    );

    expect(prompts).toEqual([{ body: "start", sessionId: "opencode-session-id" }]);
    expect(
      store.values.get(
        agentSessionKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
      ),
    ).toBe(JSON.stringify(locator));
  });

  it("elicits project selection when no label matches", async () => {
    const store = makeKv();
    const activities: Array<ActivityRecord> = [];
    const pendingKey = pendingInputKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });

    await Effect.runPromise(
      processAllowedWebhook(createdPayload()).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities, labels: [] }),
            opencode: makeOpencode(),
            store,
          }),
        ),
      ),
    );

    expect(activities.at(-1)?.content.type).toBe("elicitation");
    expect(activities.at(-1)?.signal).toBe("select");
    expect(store.values.get(pendingKey)).toBe(
      JSON.stringify({
        linearAgentSessionId: "linear-session-id",
        promptContext: "start",
        type: "projectSelection",
      }),
    );
  });

  it("matches plain and grouped project labels", async () => {
    const labels = [
      [{ id: "plain", name: "opencode-event-bridge", parent: null }],
      [{ id: "grouped", name: "opencode-event-bridge", parent: { name: "repo" } }],
    ];

    await Promise.all(
      labels.map(async (group) => {
        const store = makeKv();
        const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
        const activities: Array<ActivityRecord> = [];

        await Effect.runPromise(
          processAllowedWebhook(createdPayload()).pipe(
            Effect.provide(
              provide({
                linear: makeLinear({ activities, labels: group }),
                opencode: makeOpencode({ prompts }),
                store,
              }),
            ),
          ),
        );

        expect(prompts).toEqual([{ body: "start", sessionId: "opencode-session-id" }]);
      }),
    );
  });

  it("elicits project selection when labels are ambiguous", async () => {
    const store = makeKv();
    const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
    const activities: Array<ActivityRecord> = [];

    await Effect.runPromise(
      processAllowedWebhook(createdPayload()).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({
              projects: [
                {
                  directory: "/workspace/opencode-event-bridge",
                  id: "project-id",
                  name: "opencode-event-bridge",
                },
                {
                  directory: "/tmp/opencode-event-bridge",
                  id: "project-id-2",
                  name: "other",
                },
              ],
              prompts,
            }),
            store,
          }),
        ),
      ),
    );

    expect(prompts).toEqual([]);
    expect(activities.at(-1)?.content.type).toBe("elicitation");
    expect(activities.at(-1)?.signalMetadata?.options).toEqual([
      { label: "opencode-event-bridge", value: "opencode-event-bridge" },
      { label: "other", value: "other" },
    ]);
  });

  it("continues an existing OpenCode session before reading labels", async () => {
    const key = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeKv(new Map([[key, JSON.stringify(locator)]]));
    const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];

    await Effect.runPromise(
      processAllowedWebhook(promptedPayload("continue")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities, labels: [] }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      ),
    );

    expect(prompts).toEqual([{ body: "continue", sessionId: "opencode-session-id" }]);
  });

  it("starts after project selection and writes the project label", async () => {
    const pendingKey = pendingInputKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeKv(
      new Map([
        [
          pendingKey,
          JSON.stringify({
            linearAgentSessionId: "linear-session-id",
            promptContext: "original prompt context",
            type: "projectSelection",
          }),
        ],
      ]),
    );
    const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
    const labelWrites: Array<string> = [];
    const activities: Array<ActivityRecord> = [];

    await Effect.runPromise(
      processAllowedWebhook(promptedPayload("opencode-event-bridge")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities, labelWrites, labels: [] }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      ),
    );

    expect(labelWrites).toEqual(["repo:opencode-event-bridge"]);
    expect(prompts).toEqual([
      { body: "original prompt context", sessionId: "opencode-session-id" },
    ]);
    expect(store.values.has(pendingKey)).toBe(false);
  });

  it("continues startup and warns when project label write is rejected", async () => {
    const store = makeKv();
    const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
    const activities: Array<ActivityRecord> = [];

    await Effect.runPromise(
      processAllowedWebhook(promptedPayload("opencode-event-bridge")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities, labelWriteFailure: true, labels: [] }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      ),
    );

    expect(prompts).toEqual([{ body: "start", sessionId: "opencode-session-id" }]);
    expect(activities.map((activity) => activity.content)).toContainEqual({
      body: "Warning: could not write Linear repo label.",
      type: "response",
    });
  });

  it("does not start when project label write fails for a non-permission reason", async () => {
    const store = makeKv();
    const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
    const activities: Array<ActivityRecord> = [];

    const result = await Effect.runPromise(
      processAllowedWebhook(promptedPayload("opencode-event-bridge")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({
              activities,
              labelWriteError: new LinearHttpClientError({
                cause: "schema changed",
                reason: "InvalidGraphqlResponse",
              }),
              labels: [],
            }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      ),
    );

    expect(result).toBe("error");
    expect(prompts).toEqual([]);
    expect(
      store.values.has(
        agentSessionKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
      ),
    ).toBe(false);
    expect(activities.map((activity) => activity.content)).toContainEqual({
      body: "OpenCode run failed. Check bridge logs.",
      type: "error",
    });
  });

  it("replies to pending permission and clears pending input", async () => {
    const sessionKey = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const pendingKey = pendingInputKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeKv(
      new Map([
        [sessionKey, JSON.stringify(locator)],
        [
          pendingKey,
          JSON.stringify({
            linearAgentSessionId: "linear-session-id",
            opencodeRequestId: "permission-id",
            opencodeSessionId: "opencode-session-id",
            type: "permission",
          }),
        ],
      ]),
    );
    const permissionReplies: Array<string> = [];
    const runs: Array<OpenCodeRunRecord> = [];
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];

    await Effect.runPromise(
      processAllowedWebhook(promptedPayload("Approve Always")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ permissionReplies }),
            runs,
            store,
          }),
        ),
      ),
    );

    expect(permissionReplies).toEqual(["always"]);
    expect(store.values.has(pendingKey)).toBe(false);
    expect(runs).toEqual([
      {
        linearAgentSessionId: "linear-session-id",
        opencodeSessionId: "opencode-session-id",
        organizationId: "org-id",
        projectDirectory: "/workspace/opencode-event-bridge",
        workspaceDirectory: "/tmp/opencode/oeb-1",
      },
    ]);
  });

  it("recovers pending permission from OpenCode before continuing", async () => {
    const sessionKey = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const pendingKey = pendingInputKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeKv(new Map([[sessionKey, JSON.stringify(locator)]]));
    const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
    const activities: Array<ActivityRecord> = [];

    await Effect.runPromise(
      processAllowedWebhook(promptedPayload("continue")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({
              permissions: [
                {
                  always: [],
                  id: "permission-id",
                  metadata: {},
                  patterns: ["*"],
                  permission: "Run command?",
                  sessionID: "child-session-id",
                },
              ],
              prompts,
              sessionIds: ["opencode-session-id", "child-session-id"],
            }),
            store,
          }),
        ),
      ),
    );

    expect(prompts).toEqual([]);
    expect(activities.at(-1)?.signal).toBe("select");
    expect(store.values.get(pendingKey)).toBe(
      JSON.stringify({
        linearAgentSessionId: "linear-session-id",
        opencodeRequestId: "permission-id",
        opencodeSessionId: "child-session-id",
        type: "permission",
      }),
    );
  });

  it("collects multi-question replies before replying to OpenCode", async () => {
    const sessionKey = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const pendingKey = pendingInputKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const questions = [
      {
        header: "Color",
        options: [{ description: "Red choice", label: "Red" }],
        question: "Pick color",
      },
      {
        header: "Animal",
        options: [{ description: "Dog choice", label: "Dog" }],
        question: "Pick animal",
      },
    ];
    const store = makeKv(
      new Map([
        [sessionKey, JSON.stringify(locator)],
        [
          pendingKey,
          JSON.stringify({
            answers: [null, null],
            linearAgentSessionId: "linear-session-id",
            opencodeRequestId: "question-id",
            opencodeSessionId: "opencode-session-id",
            questions,
            type: "question",
          }),
        ],
      ]),
    );
    const questionReplies: Array<{
      readonly answers: ReadonlyArray<ReadonlyArray<string>>;
      readonly requestId: string;
    }> = [];
    const runs: Array<OpenCodeRunRecord> = [];
    const activities: Array<ActivityRecord> = [];

    await Effect.runPromise(
      processAllowedWebhook(promptedPayload("Red")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ questionReplies }),
            runs,
            store,
          }),
        ),
      ),
    );

    expect(questionReplies).toEqual([]);
    expect(activities.at(-1)?.content).toEqual({
      body: "Pick animal\n\n- Dog: Dog choice",
      type: "elicitation",
    });

    await Effect.runPromise(
      processAllowedWebhook(promptedPayload("Dog")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ questionReplies }),
            runs,
            store,
          }),
        ),
      ),
    );

    expect(questionReplies).toEqual([{ answers: [["Red"], ["Dog"]], requestId: "question-id" }]);
    expect(store.values.has(pendingKey)).toBe(false);
    expect(runs).toEqual([
      {
        linearAgentSessionId: "linear-session-id",
        opencodeSessionId: "opencode-session-id",
        organizationId: "org-id",
        projectDirectory: "/workspace/opencode-event-bridge",
        workspaceDirectory: "/tmp/opencode/oeb-1",
      },
    ]);
  });

  it("sends multiple selected answers for one OpenCode question", async () => {
    const sessionKey = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const pendingKey = pendingInputKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeKv(
      new Map([
        [sessionKey, JSON.stringify(locator)],
        [
          pendingKey,
          JSON.stringify({
            answers: [null],
            linearAgentSessionId: "linear-session-id",
            opencodeRequestId: "question-id",
            opencodeSessionId: "opencode-session-id",
            questions: [
              {
                header: "Colors",
                multiple: true,
                options: [
                  { description: "Red choice", label: "Red" },
                  { description: "Blue choice", label: "Blue" },
                ],
                question: "Pick colors",
              },
            ],
            type: "question",
          }),
        ],
      ]),
    );
    const questionReplies: Array<{
      readonly answers: ReadonlyArray<ReadonlyArray<string>>;
      readonly requestId: string;
    }> = [];
    const activities: Array<ActivityRecord> = [];

    await Effect.runPromise(
      processAllowedWebhook(promptedPayload("red, blue")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ questionReplies }),
            store,
          }),
        ),
      ),
    );

    expect(questionReplies).toEqual([{ answers: [["Red", "Blue"]], requestId: "question-id" }]);
    expect(store.values.has(pendingKey)).toBe(false);
  });

  it("aborts on stop signal and posts stopped", async () => {
    const key = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeKv(new Map([[key, JSON.stringify(locator)]]));
    const aborts: Array<string> = [];
    const cancels: Array<string> = [];
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];

    await Effect.runPromise(
      processAllowedWebhook(stopPayload()).pipe(
        Effect.provide(
          provide({
            cancels,
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ aborts }),
            store,
          }),
        ),
      ),
    );

    expect(aborts).toEqual(["opencode-session-id"]);
    expect(cancels).toEqual(["linear-session-id"]);
    expect(activities.at(-1)?.content).toEqual({ body: "Stopped.", type: "response" });
  });

  it("cleans up completed issues after aborting sessions", async () => {
    const key = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeKv(new Map([[key, JSON.stringify(locator)]]));
    const aborts: Array<string> = [];
    const cancels: Array<string> = [];
    const removals: Array<string> = [];
    const activities: Array<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }> = [];

    await Effect.runPromise(
      processAllowedWebhook(issuePayload()).pipe(
        Effect.provide(
          provide({
            cancels,
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ aborts, removals }),
            store,
          }),
        ),
      ),
    );

    expect(aborts).toEqual(["opencode-session-id"]);
    expect(cancels).toEqual(["linear-session-id"]);
    expect(removals).toEqual(["/tmp/opencode/oeb-1"]);
    expect(store.values.has(key)).toBe(false);
  });

  it("keeps cleanup state when worktree removal fails", async () => {
    const key = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const store = makeKv(new Map([[key, JSON.stringify(locator)]]));
    const aborts: Array<string> = [];
    const cancels: Array<string> = [];
    const removals: Array<string> = [];
    const activities: Array<ActivityRecord> = [];

    const error = await Effect.runPromise(
      processAllowedWebhook(issuePayload()).pipe(
        Effect.provide(
          provide({
            cancels,
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ aborts, removals, removeWorktreeFailure: true }),
            store,
          }),
        ),
        Effect.flip,
      ),
    );

    expect(error).toMatchObject({ reason: "OpenCodeFailure" });
    expect(aborts).toEqual(["opencode-session-id"]);
    expect(cancels).toEqual(["linear-session-id"]);
    expect(removals).toEqual([]);
    expect(store.values.has(key)).toBe(true);
  });

  it("dedupes worktree removal across issue agent sessions", async () => {
    const first = agentSessionKey({
      linearAgentSessionId: "linear-session-id",
      organizationId: "org-id",
    });
    const second = agentSessionKey({
      linearAgentSessionId: "linear-session-2",
      organizationId: "org-id",
    });
    const secondLocator = {
      ...locator,
      linearAgentSessionId: "linear-session-2",
      opencodeSessionId: "opencode-session-2",
    };
    const store = makeKv(
      new Map([
        [first, JSON.stringify(locator)],
        [second, JSON.stringify(secondLocator)],
      ]),
    );
    const aborts: Array<string> = [];
    const cancels: Array<string> = [];
    const removals: Array<string> = [];
    const activities: Array<ActivityRecord> = [];

    await Effect.runPromise(
      processAllowedWebhook(issuePayload()).pipe(
        Effect.provide(
          provide({
            cancels,
            linear: makeLinear({
              activities,
              issueSessionIds: ["linear-session-id", "linear-session-2"],
            }),
            opencode: makeOpencode({ aborts, removals }),
            store,
          }),
        ),
      ),
    );

    expect(aborts).toEqual(["opencode-session-id", "opencode-session-2"]);
    expect(cancels).toEqual(["linear-session-id", "linear-session-2"]);
    expect(removals).toEqual(["/tmp/opencode/oeb-1"]);
    expect(store.values.has(first)).toBe(false);
    expect(store.values.has(second)).toBe(false);
  });
});
