import type { Event } from "@opencode-ai/sdk/v2/client";

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

import { LinearHttpClient } from "../../src/linear/client/client.ts";
import {
  LinearSessionStore,
  makeLinearSessionStore,
  pendingInputKey,
} from "../../src/linear/session/store.ts";
import { processOpenCodeEvent } from "../../src/opencode/events/process.ts";

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

type ActivityRecord = {
  readonly agentSessionId: string;
  readonly content: LinearAgentActivityContent;
  readonly signal?: LinearAgentActivityInput["signal"];
  readonly signalMetadata?: LinearAgentActivityInput["signalMetadata"];
};

const makeLinear = (input: {
  readonly activities: Array<ActivityRecord>;
  readonly plans: Array<
    ReadonlyArray<{
      readonly content: string;
      readonly status: "pending" | "inProgress" | "completed" | "canceled";
    }>
  >;
}) =>
  ({
    addIssueLabel: () => Effect.void,
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
    getIssueAgentSessionIds: () => Effect.succeed([]),
    getIssueLabels: () => Effect.succeed([]),
    refreshOAuthToken: () => Effect.die("unused"),
    updateAgentSessionExternalUrls: () => Effect.void,
    updateAgentSessionPlan: (plan) =>
      Effect.sync(() => {
        input.plans.push(plan.plan);
      }).pipe(Effect.asVoid),
  }) satisfies LinearHttpClientService;

const run = {
  accessToken: "linear-access-token",
  linearAgentSessionId: "linear-session-id",
  opencodeSessionId: "opencode-session-id",
  opencodeSessionIds: ["opencode-session-id"],
  organizationId: "org-id",
};

describe("processOpenCodeEvent", () => {
  it("maps todo updates to Linear plan states", async () => {
    const store = makeKv();
    const activities: Array<ActivityRecord> = [];
    const plans: Array<
      ReadonlyArray<{
        readonly content: string;
        readonly status: "pending" | "inProgress" | "completed" | "canceled";
      }>
    > = [];
    const event: Event = {
      id: "event-id",
      properties: {
        sessionID: "opencode-session-id",
        todos: [
          { content: "Build", priority: "high", status: "in_progress" },
          { content: "Ship", priority: "medium", status: "cancelled" },
        ],
      },
      type: "todo.updated",
    };

    await Effect.runPromise(
      processOpenCodeEvent({ event, run }).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear({ activities, plans })),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
        ]),
      ),
    );

    expect(plans).toEqual([
      [
        { content: "Build", status: "inProgress" },
        { content: "Ship", status: "canceled" },
      ],
    ]);
  });

  it("stores permission requests and posts elicitation", async () => {
    const store = makeKv();
    const activities: Array<ActivityRecord> = [];
    const plans: Array<
      ReadonlyArray<{
        readonly content: string;
        readonly status: "pending" | "inProgress" | "completed" | "canceled";
      }>
    > = [];
    const event: Event = {
      id: "event-id",
      properties: {
        always: [],
        id: "permission-id",
        metadata: {},
        patterns: ["*"],
        permission: "Run command?",
        sessionID: "opencode-session-id",
      },
      type: "permission.asked",
    };

    await Effect.runPromise(
      processOpenCodeEvent({ event, run }).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear({ activities, plans })),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
        ]),
      ),
    );

    expect(activities).toEqual([
      {
        agentSessionId: "linear-session-id",
        content: { body: "Run command?\n\nApprove\nApprove Always\nReject", type: "elicitation" },
        signal: "select",
        signalMetadata: {
          options: [
            { label: "Approve", value: "Approve" },
            { label: "Approve Always", value: "Approve Always" },
            { label: "Reject", value: "Reject" },
          ],
        },
      },
    ]);
    expect(
      store.values.get(
        pendingInputKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
      ),
    ).toBe(
      JSON.stringify({
        linearAgentSessionId: "linear-session-id",
        opencodeRequestId: "permission-id",
        opencodeSessionId: "opencode-session-id",
        type: "permission",
      }),
    );
  });

  it("stores child session permission requests for a tracked run", async () => {
    const store = makeKv();
    const activities: Array<ActivityRecord> = [];
    const plans: Array<
      ReadonlyArray<{
        readonly content: string;
        readonly status: "pending" | "inProgress" | "completed" | "canceled";
      }>
    > = [];
    const event: Event = {
      id: "event-id",
      properties: {
        always: [],
        id: "permission-id",
        metadata: {},
        patterns: ["*"],
        permission: "Run command?",
        sessionID: "child-session-id",
      },
      type: "permission.asked",
    };

    await Effect.runPromise(
      processOpenCodeEvent({
        event,
        run: { ...run, opencodeSessionIds: ["opencode-session-id", "child-session-id"] },
      }).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear({ activities, plans })),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
        ]),
      ),
    );

    expect(
      store.values.get(
        pendingInputKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
      ),
    ).toBe(
      JSON.stringify({
        linearAgentSessionId: "linear-session-id",
        opencodeRequestId: "permission-id",
        opencodeSessionId: "child-session-id",
        type: "permission",
      }),
    );
  });

  it("posts session errors to Linear", async () => {
    const store = makeKv();
    const activities: Array<ActivityRecord> = [];
    const plans: Array<
      ReadonlyArray<{
        readonly content: string;
        readonly status: "pending" | "inProgress" | "completed" | "canceled";
      }>
    > = [];
    const event: Event = {
      id: "event-id",
      properties: {
        error: { data: { message: "boom" }, name: "UnknownError" },
        sessionID: "opencode-session-id",
      },
      type: "session.error",
    };

    await Effect.runPromise(
      processOpenCodeEvent({ event, run }).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear({ activities, plans })),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
        ]),
      ),
    );

    expect(activities).toEqual([
      {
        agentSessionId: "linear-session-id",
        content: {
          body: JSON.stringify({ data: { message: "boom" }, name: "UnknownError" }),
          type: "error",
        },
        signal: undefined,
        signalMetadata: undefined,
      },
    ]);
  });

  it("stores questions and posts the first elicitation", async () => {
    const store = makeKv();
    const activities: Array<ActivityRecord> = [];
    const plans: Array<
      ReadonlyArray<{
        readonly content: string;
        readonly status: "pending" | "inProgress" | "completed" | "canceled";
      }>
    > = [];
    const event: Event = {
      id: "event-id",
      properties: {
        id: "question-id",
        questions: [
          {
            header: "Color",
            options: [{ description: "Red choice", label: "Red" }],
            question: "Pick color",
          },
        ],
        sessionID: "opencode-session-id",
      },
      type: "question.asked",
    };

    await Effect.runPromise(
      processOpenCodeEvent({ event, run }).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear({ activities, plans })),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
        ]),
      ),
    );

    expect(activities).toEqual([
      {
        agentSessionId: "linear-session-id",
        content: { body: "Pick color\n\n- Red: Red choice", type: "elicitation" },
        signal: "select",
        signalMetadata: { options: [{ label: "Red", value: "Red" }] },
      },
    ]);
    expect(
      store.values.get(
        pendingInputKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
      ),
    ).toBe(
      JSON.stringify({
        answers: [null],
        linearAgentSessionId: "linear-session-id",
        opencodeRequestId: "question-id",
        opencodeSessionId: "opencode-session-id",
        questions: [
          {
            header: "Color",
            options: [{ description: "Red choice", label: "Red" }],
            question: "Pick color",
          },
        ],
        type: "question",
      }),
    );
  });

  it("keeps the active pending input instead of queuing another one", async () => {
    const store = makeKv();
    const activities: Array<ActivityRecord> = [];
    const plans: Array<
      ReadonlyArray<{
        readonly content: string;
        readonly status: "pending" | "inProgress" | "completed" | "canceled";
      }>
    > = [];
    const first: Event = {
      id: "event-1",
      properties: {
        always: [],
        id: "permission-1",
        metadata: {},
        patterns: ["*"],
        permission: "Run first?",
        sessionID: "opencode-session-id",
      },
      type: "permission.asked",
    };
    const second: Event = {
      id: "event-2",
      properties: {
        always: [],
        id: "permission-2",
        metadata: {},
        patterns: ["*"],
        permission: "Run second?",
        sessionID: "opencode-session-id",
      },
      type: "permission.asked",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* processOpenCodeEvent({ event: first, run });
        yield* processOpenCodeEvent({ event: second, run });
      }).pipe(
        Effect.provide([
          Layer.succeed(LinearHttpClient)(makeLinear({ activities, plans })),
          Layer.succeed(LinearSessionStore)(makeLinearSessionStore(store.kv)),
        ]),
      ),
    );

    expect(
      store.values.get(
        pendingInputKey({ linearAgentSessionId: "linear-session-id", organizationId: "org-id" }),
      ),
    ).toBe(
      JSON.stringify({
        linearAgentSessionId: "linear-session-id",
        opencodeRequestId: "permission-1",
        opencodeSessionId: "opencode-session-id",
        type: "permission",
      }),
    );
    expect(activities.map((activity) => activity.content)).toEqual([
      { body: "Run first?\n\nApprove\nApprove Always\nReject", type: "elicitation" },
    ]);
  });
});
