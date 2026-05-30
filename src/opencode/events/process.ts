import type { Event } from "@opencode-ai/sdk/v2/client";

import * as Effect from "effect/Effect";

import type { PendingOpenCodeInput } from "../../linear/session/store.ts";

import { LinearHttpClient } from "../../linear/client/client.ts";
import { selectMetadata } from "../../linear/session/project.ts";
import { LinearSessionStore } from "../../linear/session/store.ts";

export type OpenCodeEventRun = {
  readonly accessToken: string;
  readonly linearAgentSessionId: string;
  readonly opencodeSessionId: string;
  readonly opencodeSessionIds: ReadonlyArray<string>;
  readonly organizationId: string;
};

const detailFrom = (error: unknown) => {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return JSON.stringify(error);
};

const linearTodoStatus = (status: string): "pending" | "inProgress" | "completed" | "canceled" => {
  if (status === "in_progress") {
    return "inProgress";
  }

  if (status === "completed") {
    return "completed";
  }

  if (status === "cancelled") {
    return "canceled";
  }

  return "pending";
};

const questionBody = (question: {
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
}) => {
  const options = question.options
    .map((option) => `- ${option.label}: ${option.description}`)
    .join("\n");
  return `${question.question}\n\n${options}`;
};

const eventSessionId = (event: Event) => {
  if ("properties" in event && "sessionID" in event.properties) {
    const sessionId = event.properties.sessionID;
    if (typeof sessionId === "string") {
      return sessionId;
    }
  }

  return undefined;
};

const eventBelongsToRun = (input: { readonly event: Event; readonly run: OpenCodeEventRun }) => {
  const sessionId = eventSessionId(input.event);
  return sessionId === undefined || input.run.opencodeSessionIds.includes(sessionId);
};

export const processOpenCodeEvent = (input: {
  readonly event: Event;
  readonly run: OpenCodeEventRun;
}) =>
  Effect.gen(function* () {
    const linear = yield* LinearHttpClient;
    const store = yield* LinearSessionStore;

    if (!eventBelongsToRun(input)) {
      return;
    }

    if (input.event.type === "todo.updated") {
      yield* linear.updateAgentSessionPlan({
        accessToken: input.run.accessToken,
        agentSessionId: input.run.linearAgentSessionId,
        plan: input.event.properties.todos.map((todo) => ({
          content: todo.content,
          status: linearTodoStatus(todo.status),
        })),
      });
      return;
    }

    if (input.event.type === "session.error") {
      yield* linear.createAgentActivity({
        accessToken: input.run.accessToken,
        agentSessionId: input.run.linearAgentSessionId,
        content: { body: detailFrom(input.event.properties.error), type: "error" },
      });
      return;
    }

    if (input.event.type === "permission.asked") {
      const existing = yield* store.getPendingInput({
        linearAgentSessionId: input.run.linearAgentSessionId,
        organizationId: input.run.organizationId,
      });

      if (existing !== null) {
        return;
      }

      const pending: PendingOpenCodeInput = {
        linearAgentSessionId: input.run.linearAgentSessionId,
        opencodeRequestId: input.event.properties.id,
        opencodeSessionId: input.event.properties.sessionID,
        type: "permission",
      };
      yield* linear.createAgentActivity({
        accessToken: input.run.accessToken,
        agentSessionId: input.run.linearAgentSessionId,
        content: {
          body: `${input.event.properties.permission}\n\nApprove\nApprove Always\nReject`,
          type: "elicitation",
        },
        signal: "select",
        signalMetadata: selectMetadata(["Approve", "Approve Always", "Reject"]),
      });
      yield* store.putPendingInput({ organizationId: input.run.organizationId, pending });
      return;
    }

    if (input.event.type === "question.asked") {
      const existing = yield* store.getPendingInput({
        linearAgentSessionId: input.run.linearAgentSessionId,
        organizationId: input.run.organizationId,
      });

      if (existing !== null) {
        return;
      }

      const pending: PendingOpenCodeInput = {
        answers: input.event.properties.questions.map(() => null),
        linearAgentSessionId: input.run.linearAgentSessionId,
        opencodeRequestId: input.event.properties.id,
        opencodeSessionId: input.event.properties.sessionID,
        questions: input.event.properties.questions,
        type: "question",
      };
      const question = pending.questions[0];

      if (question !== undefined) {
        yield* linear.createAgentActivity({
          accessToken: input.run.accessToken,
          agentSessionId: input.run.linearAgentSessionId,
          content: { body: questionBody(question), type: "elicitation" },
          signal: "select",
          signalMetadata: selectMetadata(question.options.map((option) => option.label)),
        });
      }

      yield* store.putPendingInput({ organizationId: input.run.organizationId, pending });
    }
  });
