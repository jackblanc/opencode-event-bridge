import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client";

import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
  PendingOpenCodeInput,
  pendingInputKey,
  SessionLocator,
} from "../../src/linear/session/store.ts";
import { OpenCodeClient, OpenCodeClientError } from "../../src/opencode/client.ts";
import { OpenCodeRunObserverService } from "../../src/opencode/run-observer.ts";

const orgAuth = {
  accessToken: "linear-access-token",
  accessTokenExpiresAt: 1_000,
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
const encodeLocator = Schema.encodeSync(Schema.fromJsonString(SessionLocator));
const encodePendingInput = Schema.encodeSync(Schema.fromJsonString(PendingOpenCodeInput));
const encodeUnknown = Schema.encodeSync(Schema.UnknownFromJsonString);

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
          LinearHttpClientError.make({ cause: "forbidden", reason: "PermissionFailure" }),
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
        ? Effect.fail(
            OpenCodeClientError.make({ detail: "remove failed", reason: "RequestFailed" }),
          )
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
  Context.make(LinearHttpClient, input.linear).pipe(
    Context.add(LinearOrgAuthStore, { getOrgAuth: () => Effect.succeed(orgAuth) }),
    Context.add(LinearSessionStore, makeLinearSessionStore(input.store.kv)),
    Context.add(OpenCodeClient, input.opencode),
    Context.add(OpenCodeRunObserverService, makeObserver(input.runs ?? [], input.cancels ?? [])),
  );

describe("LinearSessionStore", () => {
  it.effect("preserves invalid record cause and key", () =>
    Effect.gen(function* () {
      const key = agentSessionKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });
      const store = makeLinearSessionStore(makeKv(new Map([[key, encodeUnknown({})]])).kv);

      const error = yield* store
        .getSessionLocator({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(LinearSessionStoreError);
      expect(error.reason).toBe("InvalidRecord");
      expect(error.key).toBe(key);
    }),
  );
});

describe("processLinearWebhook", () => {
  it.effect("rejects unauthorized organizations before reading auth", () =>
    Effect.gen(function* () {
      const store = makeKv();
      const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
      const activities: Array<ActivityRecord> = [];
      const base = createdPayload();
      const payload: LinearWebhookPayload = {
        ...base,
        agentSession: { ...base.agentSession, organizationId: "other-org-id" },
        organizationId: "other-org-id",
      };

      const result = yield* processAllowedWebhook(payload).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      );

      expect(result).toBe("organization-not-allowed");
      expect(prompts).toEqual([]);
      expect(activities).toEqual([]);
    }),
  );

  it.effect("starts a labelled issue and stores a session locator", () =>
    Effect.gen(function* () {
      const store = makeKv();
      const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
      const activities: Array<{
        readonly agentSessionId: string;
        readonly content: LinearAgentActivityContent;
      }> = [];

      yield* processAllowedWebhook(createdPayload()).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      );

      expect(prompts).toEqual([{ body: "start", sessionId: "opencode-session-id" }]);
      expect(
        store.values.get(
          agentSessionKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
        ),
      ).toBe(encodeLocator(locator));
    }),
  );

  it.effect("elicits project selection when no label matches", () =>
    Effect.gen(function* () {
      const store = makeKv();
      const activities: Array<ActivityRecord> = [];
      const pendingKey = pendingInputKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });

      yield* processAllowedWebhook(createdPayload()).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities, labels: [] }),
            opencode: makeOpencode(),
            store,
          }),
        ),
      );

      expect(activities.at(-1)?.content.type).toBe("elicitation");
      expect(activities.at(-1)?.signal).toBe("select");
      expect(store.values.get(pendingKey)).toBe(
        encodePendingInput({
          linearAgentSessionId: "linear-session-id",
          promptContext: "start",
          type: "projectSelection",
        }),
      );
    }),
  );

  it.effect("matches plain and grouped project labels", () =>
    Effect.gen(function* () {
      const labels = [
        [{ id: "plain", name: "opencode-event-bridge", parent: null }],
        [{ id: "grouped", name: "opencode-event-bridge", parent: { name: "repo" } }],
      ];

      yield* Effect.forEach(
        labels,
        (group) =>
          Effect.gen(function* () {
            const store = makeKv();
            const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
            const activities: Array<ActivityRecord> = [];

            yield* processAllowedWebhook(createdPayload()).pipe(
              Effect.provide(
                provide({
                  linear: makeLinear({ activities, labels: group }),
                  opencode: makeOpencode({ prompts }),
                  store,
                }),
              ),
            );

            expect(prompts).toEqual([{ body: "start", sessionId: "opencode-session-id" }]);
          }),
        { discard: true },
      );
    }),
  );

  it.effect("elicits project selection when labels are ambiguous", () =>
    Effect.gen(function* () {
      const store = makeKv();
      const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
      const activities: Array<ActivityRecord> = [];

      yield* processAllowedWebhook(createdPayload()).pipe(
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
      );

      expect(prompts).toEqual([]);
      expect(activities.at(-1)?.content.type).toBe("elicitation");
      expect(activities.at(-1)?.signalMetadata?.options).toEqual([
        { label: "opencode-event-bridge", value: "opencode-event-bridge" },
        { label: "other", value: "other" },
      ]);
    }),
  );

  it.effect("continues an existing OpenCode session before reading labels", () =>
    Effect.gen(function* () {
      const key = agentSessionKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });
      const store = makeKv(new Map([[key, encodeLocator(locator)]]));
      const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
      const activities: Array<{
        readonly agentSessionId: string;
        readonly content: LinearAgentActivityContent;
      }> = [];

      yield* processAllowedWebhook(promptedPayload("continue")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities, labels: [] }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      );

      expect(prompts).toEqual([{ body: "continue", sessionId: "opencode-session-id" }]);
    }),
  );

  it.effect("starts after project selection and writes the project label", () =>
    Effect.gen(function* () {
      const pendingKey = pendingInputKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });
      const store = makeKv(
        new Map([
          [
            pendingKey,
            encodePendingInput({
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

      yield* processAllowedWebhook(promptedPayload("opencode-event-bridge")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities, labelWrites, labels: [] }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      );

      expect(labelWrites).toEqual(["repo:opencode-event-bridge"]);
      expect(prompts).toEqual([
        { body: "original prompt context", sessionId: "opencode-session-id" },
      ]);
      expect(store.values.has(pendingKey)).toBe(false);
    }),
  );

  it.effect("continues startup and warns when project label write is rejected", () =>
    Effect.gen(function* () {
      const store = makeKv();
      const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
      const activities: Array<ActivityRecord> = [];

      yield* processAllowedWebhook(promptedPayload("opencode-event-bridge")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities, labelWriteFailure: true, labels: [] }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
        ),
      );

      expect(prompts).toEqual([{ body: "start", sessionId: "opencode-session-id" }]);
      expect(activities.map((activity) => activity.content)).toContainEqual({
        body: "Warning: could not write Linear repo label.",
        type: "response",
      });
    }),
  );

  it.effect("does not start when project label write fails for a non-permission reason", () =>
    Effect.gen(function* () {
      const store = makeKv();
      const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
      const activities: Array<ActivityRecord> = [];

      const result = yield* processAllowedWebhook(promptedPayload("opencode-event-bridge")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({
              activities,
              labelWriteError: LinearHttpClientError.make({
                cause: "schema changed",
                reason: "InvalidGraphqlResponse",
              }),
              labels: [],
            }),
            opencode: makeOpencode({ prompts }),
            store,
          }),
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
    }),
  );

  it.effect("replies to pending permission and clears pending input", () =>
    Effect.gen(function* () {
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
          [sessionKey, encodeLocator(locator)],
          [
            pendingKey,
            encodePendingInput({
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

      yield* processAllowedWebhook(promptedPayload("Approve Always")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ permissionReplies }),
            runs,
            store,
          }),
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
    }),
  );

  it.effect("recovers pending permission from OpenCode before continuing", () =>
    Effect.gen(function* () {
      const sessionKey = agentSessionKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });
      const pendingKey = pendingInputKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });
      const store = makeKv(new Map([[sessionKey, encodeLocator(locator)]]));
      const prompts: Array<{ readonly body: string; readonly sessionId: string }> = [];
      const activities: Array<ActivityRecord> = [];

      yield* processAllowedWebhook(promptedPayload("continue")).pipe(
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
      );

      expect(prompts).toEqual([]);
      expect(activities.at(-1)?.signal).toBe("select");
      expect(store.values.get(pendingKey)).toBe(
        encodePendingInput({
          linearAgentSessionId: "linear-session-id",
          opencodeRequestId: "permission-id",
          opencodeSessionId: "child-session-id",
          type: "permission",
        }),
      );
    }),
  );

  it.effect("collects multi-question replies before replying to OpenCode", () =>
    Effect.gen(function* () {
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
          [sessionKey, encodeLocator(locator)],
          [
            pendingKey,
            encodePendingInput({
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

      yield* processAllowedWebhook(promptedPayload("Red")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ questionReplies }),
            runs,
            store,
          }),
        ),
      );

      expect(questionReplies).toEqual([]);
      expect(activities.at(-1)?.content).toEqual({
        body: "Pick animal\n\n- Dog: Dog choice",
        type: "elicitation",
      });

      yield* processAllowedWebhook(promptedPayload("Dog")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ questionReplies }),
            runs,
            store,
          }),
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
    }),
  );

  it.effect("sends multiple selected answers for one OpenCode question", () =>
    Effect.gen(function* () {
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
          [sessionKey, encodeLocator(locator)],
          [
            pendingKey,
            encodePendingInput({
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

      yield* processAllowedWebhook(promptedPayload("red, blue")).pipe(
        Effect.provide(
          provide({
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ questionReplies }),
            store,
          }),
        ),
      );

      expect(questionReplies).toEqual([{ answers: [["Red", "Blue"]], requestId: "question-id" }]);
      expect(store.values.has(pendingKey)).toBe(false);
    }),
  );

  it.effect("aborts on stop signal and posts stopped", () =>
    Effect.gen(function* () {
      const key = agentSessionKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });
      const store = makeKv(new Map([[key, encodeLocator(locator)]]));
      const aborts: Array<string> = [];
      const cancels: Array<string> = [];
      const activities: Array<{
        readonly agentSessionId: string;
        readonly content: LinearAgentActivityContent;
      }> = [];

      yield* processAllowedWebhook(stopPayload()).pipe(
        Effect.provide(
          provide({
            cancels,
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ aborts }),
            store,
          }),
        ),
      );

      expect(aborts).toEqual(["opencode-session-id"]);
      expect(cancels).toEqual(["linear-session-id"]);
      expect(activities.at(-1)?.content).toEqual({ body: "Stopped.", type: "response" });
    }),
  );

  it.effect("cleans up completed issues after aborting sessions", () =>
    Effect.gen(function* () {
      const key = agentSessionKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });
      const store = makeKv(new Map([[key, encodeLocator(locator)]]));
      const aborts: Array<string> = [];
      const cancels: Array<string> = [];
      const removals: Array<string> = [];
      const activities: Array<{
        readonly agentSessionId: string;
        readonly content: LinearAgentActivityContent;
      }> = [];

      yield* processAllowedWebhook(issuePayload()).pipe(
        Effect.provide(
          provide({
            cancels,
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ aborts, removals }),
            store,
          }),
        ),
      );

      expect(aborts).toEqual(["opencode-session-id"]);
      expect(cancels).toEqual(["linear-session-id"]);
      expect(removals).toEqual(["/tmp/opencode/oeb-1"]);
      expect(store.values.has(key)).toBe(false);
    }),
  );

  it.effect("keeps cleanup state when worktree removal fails", () =>
    Effect.gen(function* () {
      const key = agentSessionKey({
        linearAgentSessionId: "linear-session-id",
        organizationId: "org-id",
      });
      const store = makeKv(new Map([[key, encodeLocator(locator)]]));
      const aborts: Array<string> = [];
      const cancels: Array<string> = [];
      const removals: Array<string> = [];
      const activities: Array<ActivityRecord> = [];

      const error = yield* processAllowedWebhook(issuePayload()).pipe(
        Effect.provide(
          provide({
            cancels,
            linear: makeLinear({ activities }),
            opencode: makeOpencode({ aborts, removals, removeWorktreeFailure: true }),
            store,
          }),
        ),
        Effect.flip,
      );

      expect(error).toMatchObject({ reason: "OpenCodeFailure" });
      expect(aborts).toEqual(["opencode-session-id"]);
      expect(cancels).toEqual(["linear-session-id"]);
      expect(removals).toEqual([]);
      expect(store.values.has(key)).toBe(true);
    }),
  );

  it.effect("dedupes worktree removal across issue agent sessions", () =>
    Effect.gen(function* () {
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
          [first, encodeLocator(locator)],
          [second, encodeLocator(secondLocator)],
        ]),
      );
      const aborts: Array<string> = [];
      const cancels: Array<string> = [];
      const removals: Array<string> = [];
      const activities: Array<ActivityRecord> = [];

      yield* processAllowedWebhook(issuePayload()).pipe(
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
      );

      expect(aborts).toEqual(["opencode-session-id", "opencode-session-2"]);
      expect(cancels).toEqual(["linear-session-id", "linear-session-2"]);
      expect(removals).toEqual(["/tmp/opencode/oeb-1"]);
      expect(store.values.has(first)).toBe(false);
      expect(store.values.has(second)).toBe(false);
    }),
  );
});
