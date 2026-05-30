import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { describe, expect, it, vi } from "vitest";

import type {
  LinearAgentActivityContent,
  LinearHttpClientService,
} from "../../src/linear/client/client.ts";
import type {
  LinearAgentSessionKey,
  LinearPendingInputKey,
} from "../../src/linear/session/store.ts";
import type { LinearWebhookPayload } from "../../src/linear/webhook/payload.ts";
import type { OpenCodeRunRecord } from "../../src/opencode/run-observer.ts";

import { LinearHttpClient } from "../../src/linear/client/client.ts";
import { LinearOrgAuthStore } from "../../src/linear/oauth/auth.ts";
import { processLinearWebhook } from "../../src/linear/session/process.ts";
import { LinearSessionStore, makeLinearSessionStore } from "../../src/linear/session/store.ts";
import { receiveLinearWebhook } from "../../src/linear/webhook/receive.ts";
import { makeOpenCodeClient, OpenCodeClient } from "../../src/opencode/client.ts";
import { OpenCodeRunObserverService } from "../../src/opencode/run-observer.ts";

const secret = "linear-webhook-secret";
const opencodeBaseUrl = "http://127.0.0.1:4096";

type OpenCodeRequest = {
  readonly body: unknown;
  readonly method: string;
  readonly url: string;
};

const makeKv = () => {
  const values = new Map<string, string>();

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

const makeOrgAuthStore = () => ({
  getOrgAuth: () =>
    Effect.succeed({
      accessToken: "linear-access-token",
      accessTokenExpiresAt: Date.now() + 1_000,
      appUserId: "app-user-id",
      organizationId: "org-id",
      organizationName: "Example",
      refreshToken: "refresh-token",
    }),
});

const makeLinear = (
  activities: Ref.Ref<
    ReadonlyArray<{
      readonly agentSessionId: string;
      readonly content: LinearAgentActivityContent;
    }>
  >,
  links: Ref.Ref<
    ReadonlyArray<{
      readonly agentSessionId: string;
      readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
    }>
  >,
): LinearHttpClientService => ({
  addIssueLabel: () => Effect.void,
  createAgentActivity: (input: {
    readonly accessToken: string;
    readonly agentSessionId: string;
    readonly content: LinearAgentActivityContent;
  }) =>
    Ref.update(activities, (items) => [
      ...items,
      { agentSessionId: input.agentSessionId, content: input.content },
    ]).pipe(Effect.as({ id: "activity-id" })),
  exchangeOAuthCode: () => Effect.die("exchangeOAuthCode is not used by webhook flow tests"),
  fetchViewer: () => Effect.die("fetchViewer is not used by webhook flow tests"),
  getIssueAgentSessionIds: () => Effect.succeed(["linear-session-id"]),
  getIssueLabels: () =>
    Effect.succeed([{ id: "label-id", name: "repo:opencode-event-bridge", parent: null }]),
  refreshOAuthToken: () => Effect.die("refreshOAuthToken is not used by webhook flow tests"),
  updateAgentSessionPlan: () => Effect.void,
  updateAgentSessionExternalUrls: (input) =>
    Ref.update(links, (items) => [
      ...items,
      { agentSessionId: input.agentSessionId, externalUrls: input.externalUrls },
    ]),
});

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
      labels: [{ name: "repo:opencode-event-bridge" }],
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
  webhookTimestamp: Date.now(),
});

const rawBodyOf = (payload: LinearWebhookPayload) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const sign = (rawBody: ArrayBuffer) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

const jsonBodyOf = (request: Request) =>
  Effect.promise(async () => {
    if (request.body === null) {
      return null;
    }

    return request.json();
  });

const responseFor = (request: OpenCodeRequest, messageRequests: number, statusRequests: number) => {
  if (request.url === "http://127.0.0.1:4096/project") {
    return Response.json([
      {
        id: "project-id",
        worktree: "/Users/jackblanc/projects/opencode-event-bridge",
        time: { created: 1 },
      },
    ]);
  }

  if (
    request.url ===
    "http://127.0.0.1:4096/experimental/worktree?directory=%2FUsers%2Fjackblanc%2Fprojects%2Fopencode-event-bridge"
  ) {
    if (request.method === "GET") {
      return Response.json([]);
    }

    return Response.json({ directory: "/tmp/opencode/oeb-1", name: "oeb-1" });
  }

  if (request.url === "http://127.0.0.1:4096/session?directory=%2Ftmp%2Fopencode%2Foeb-1") {
    return Response.json({ id: "opencode-session-id" });
  }

  if (
    request.url ===
    "http://127.0.0.1:4096/session/opencode-session-id/message?directory=%2Ftmp%2Fopencode%2Foeb-1"
  ) {
    if (messageRequests === 1) {
      return Response.json([]);
    }

    return Response.json([
      {
        info: {
          cost: 0,
          id: "assistant-message-id",
          mode: "build",
          modelID: "model",
          parentID: "user-message-id",
          path: { cwd: "/tmp/opencode/oeb-1", root: "/tmp/opencode/oeb-1" },
          providerID: "provider",
          role: "assistant",
          sessionID: "opencode-session-id",
          time: { created: 1, completed: 2 },
          tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
        },
        parts: [
          {
            id: "part-id",
            messageID: "assistant-message-id",
            sessionID: "opencode-session-id",
            text: "done",
            type: "text",
          },
        ],
      },
    ]);
  }

  if (
    request.url ===
    "http://127.0.0.1:4096/session/opencode-session-id/prompt_async?directory=%2Ftmp%2Fopencode%2Foeb-1"
  ) {
    return new Response(null, { status: 204 });
  }

  if (request.url === "http://127.0.0.1:4096/session/status?directory=%2Ftmp%2Fopencode%2Foeb-1") {
    if (statusRequests === 1) {
      return Response.json({ "opencode-session-id": { type: "busy" } });
    }

    return Response.json({ "opencode-session-id": { type: "idle" } });
  }

  return new Response("unexpected OpenCode request", { status: 500 });
};

const makeRecordingFetch = (requests: Ref.Ref<ReadonlyArray<OpenCodeRequest>>): typeof fetch => {
  let messageRequests = 0;
  let statusRequests = 0;

  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const effect = Effect.gen(function* () {
      const observed = {
        body: yield* jsonBodyOf(request.clone()),
        method: request.method,
        url: request.url,
      };

      yield* Ref.update(requests, (items) => [...items, observed]);
      if (
        observed.url ===
        "http://127.0.0.1:4096/session/opencode-session-id/message?directory=%2Ftmp%2Fopencode%2Foeb-1"
      ) {
        messageRequests = messageRequests + 1;
      }
      if (
        observed.url === "http://127.0.0.1:4096/session/status?directory=%2Ftmp%2Fopencode%2Foeb-1"
      ) {
        statusRequests = statusRequests + 1;
      }

      return responseFor(observed, messageRequests, statusRequests);
    });

    return Effect.runPromise(effect);
  };
};

describe("Linear webhook to OpenCode", () => {
  it("receives a signed created agent session and sends OpenCode requests", async () => {
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));

    await Effect.gen(function* () {
      const queued = yield* Ref.make<ReadonlyArray<LinearWebhookPayload>>([]);
      const requests = yield* Ref.make<ReadonlyArray<OpenCodeRequest>>([]);
      const activities = yield* Ref.make<
        ReadonlyArray<{
          readonly agentSessionId: string;
          readonly content: LinearAgentActivityContent;
        }>
      >([]);
      const links = yield* Ref.make<
        ReadonlyArray<{
          readonly agentSessionId: string;
          readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
        }>
      >([]);
      const runs = yield* Ref.make<ReadonlyArray<OpenCodeRunRecord>>([]);
      const payload = createdPayload();
      const rawBody = rawBodyOf(payload);
      const signature = yield* sign(rawBody);
      const store = makeKv();

      yield* receiveLinearWebhook({
        event: "AgentSessionEvent",
        queue: {
          send: (message) => Ref.update(queued, (items) => [...items, message]),
        },
        rawBody,
        signature,
        webhookSecret: secret,
      });

      const messages = yield* Ref.get(queued);
      yield* Effect.forEach(messages, processLinearWebhook, { discard: true }).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear(activities, links)),
          Layer.succeed(LinearOrgAuthStore)(makeOrgAuthStore()),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(
            makeOpenCodeClient(makeRecordingFetch(requests), opencodeBaseUrl),
          ),
          Layer.succeed(OpenCodeRunObserverService)(
            OpenCodeRunObserverService.of({
              cancel: () => Effect.void,
              start: (run) => Ref.update(runs, (items) => [...items, run]),
            }),
          ),
        ]),
      );

      const observed = yield* Ref.get(requests);
      const observedActivities = yield* Ref.get(activities);
      const observedLinks = yield* Ref.get(links);
      const observedRuns = yield* Ref.get(runs);

      expect(observed).toEqual([
        {
          body: null,
          method: "GET",
          url: "http://127.0.0.1:4096/project",
        },
        {
          body: null,
          method: "GET",
          url: "http://127.0.0.1:4096/experimental/worktree?directory=%2FUsers%2Fjackblanc%2Fprojects%2Fopencode-event-bridge",
        },
        {
          body: { name: "oeb-1" },
          method: "POST",
          url: "http://127.0.0.1:4096/experimental/worktree?directory=%2FUsers%2Fjackblanc%2Fprojects%2Fopencode-event-bridge",
        },
        {
          body: null,
          method: "GET",
          url: "http://127.0.0.1:4096/session/status?directory=%2Ftmp%2Fopencode%2Foeb-1",
        },
        {
          body: {
            title: "Wire Linear to OpenCode",
          },
          method: "POST",
          url: "http://127.0.0.1:4096/session?directory=%2Ftmp%2Fopencode%2Foeb-1",
        },
        {
          body: {
            agent: "build",
            parts: [{ text: "start", type: "text" }],
          },
          method: "POST",
          url: "http://127.0.0.1:4096/session/opencode-session-id/prompt_async?directory=%2Ftmp%2Fopencode%2Foeb-1",
        },
      ]);
      expect(observedActivities).toEqual([
        {
          agentSessionId: "linear-session-id",
          content: { body: "Accepted. Starting OpenCode.", type: "thought" },
        },
      ]);
      expect(observedRuns).toEqual([
        {
          linearAgentSessionId: "linear-session-id",
          opencodeSessionId: "opencode-session-id",
          organizationId: "org-id",
          projectDirectory: "/Users/jackblanc/projects/opencode-event-bridge",
          workspaceDirectory: "/tmp/opencode/oeb-1",
        },
      ]);
      expect(observedLinks).toEqual([
        {
          agentSessionId: "linear-session-id",
          externalUrls: [
            {
              label: "OpenCode",
              url: "http://localhost:4096/L3RtcC9vcGVuY29kZS9vZWItMQ/session/opencode-session-id",
            },
          ],
        },
      ]);
    }).pipe(Effect.runPromise);
  });
});
