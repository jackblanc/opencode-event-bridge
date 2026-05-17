import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { describe, expect, it, vi } from "vitest";

import type {
  LinearAgentSessionKey,
  LinearIssueWorktreeKey,
} from "../../src/linear/session/store.ts";
import type { LinearWebhookPayload } from "../../src/linear/webhook/payload.ts";

import { processLinearWebhook } from "../../src/linear/session/process.ts";
import { LinearSessionStore, makeLinearSessionStore } from "../../src/linear/session/store.ts";
import { receiveLinearWebhook } from "../../src/linear/webhook/receive.ts";
import { makeOpenCodeClient, OpenCodeClient } from "../../src/opencode/client.ts";

const secret = "linear-webhook-secret";

type OpenCodeRequest = {
  readonly body: unknown;
  readonly method: string;
  readonly url: string;
};

const makeKv = () => {
  const values = new Map<string, string>();

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

const responseFor = (request: OpenCodeRequest) => {
  if (request.url === "http://opencode/experimental/worktree") {
    return Response.json({ directory: "/tmp/opencode/oeb-1", name: "oeb-1" });
  }

  if (request.url === "http://opencode/session?directory=%2Ftmp%2Fopencode%2Foeb-1") {
    return Response.json({ id: "opencode-session-id" });
  }

  if (
    request.url ===
    "http://opencode/session/opencode-session-id/message?directory=%2Ftmp%2Fopencode%2Foeb-1"
  ) {
    return Response.json({});
  }

  return new Response("unexpected OpenCode request", { status: 500 });
};

const makeRecordingFetch =
  (requests: Ref.Ref<ReadonlyArray<OpenCodeRequest>>): typeof fetch =>
  async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const effect = Effect.gen(function* () {
      const observed = {
        body: yield* jsonBodyOf(request.clone()),
        method: request.method,
        url: request.url,
      };

      yield* Ref.update(requests, (items) => [...items, observed]);
      return responseFor(observed);
    });

    return Effect.runPromise(effect);
  };

describe("Linear webhook to OpenCode", () => {
  it("receives a signed created agent session and sends OpenCode requests", async () => {
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));

    await Effect.gen(function* () {
      const queued = yield* Ref.make<ReadonlyArray<LinearWebhookPayload>>([]);
      const requests = yield* Ref.make<ReadonlyArray<OpenCodeRequest>>([]);
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
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
          Layer.succeed(OpenCodeClient)(makeOpenCodeClient(makeRecordingFetch(requests))),
        ]),
      );

      const observed = yield* Ref.get(requests);

      expect(observed).toEqual([
        {
          body: { name: "oeb-1" },
          method: "POST",
          url: "http://opencode/experimental/worktree",
        },
        {
          body: {
            title: "Wire Linear to OpenCode",
          },
          method: "POST",
          url: "http://opencode/session?directory=%2Ftmp%2Fopencode%2Foeb-1",
        },
        {
          body: {
            parts: [{ text: "start", type: "text" }],
          },
          method: "POST",
          url: "http://opencode/session/opencode-session-id/message?directory=%2Ftmp%2Fopencode%2Foeb-1",
        },
      ]);
    }).pipe(Effect.runPromise);
  });
});
