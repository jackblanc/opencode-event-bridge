import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  LinearAgentActivityContent,
  LinearAgentActivitySignalMetadata,
} from "../client/client.ts";
import type { OpenCodeProject } from "../session/project.ts";
import type { PendingOpenCodeInput, Question, SessionLocator } from "../session/store.ts";
import type {
  PromptedAgentSessionEventWebhookPayload,
  StopAgentSessionEventWebhookPayload,
} from "../webhook/payload.ts";

import { OpenCodeClient } from "../../opencode/client.ts";
import { OpenCodeRunObserverService } from "../../opencode/run-observer.ts";
import { LinearSessionProcessorError } from "../session/error.ts";
import { matchProject, normalize, selectMetadata } from "../session/project.ts";
import { LinearSessionStore } from "../session/store.ts";

type PostActivity = (input: {
  readonly content: LinearAgentActivityContent;
  readonly signal?: "select";
  readonly signalMetadata?: LinearAgentActivitySignalMetadata;
}) => Effect.Effect<void, LinearSessionProcessorError>;

type StartSession = (
  project: OpenCodeProject,
  promptBody: string,
) => Effect.Effect<string, LinearSessionProcessorError>;

export type PromptedInteractionResult =
  | { readonly type: "handled"; readonly value: string }
  | {
      readonly body: string;
      readonly locator: SessionLocator;
      readonly type: "continue";
    };

const permissionReplyFrom = (body: string): "once" | "always" | "reject" | undefined => {
  const value = body.trim().toLowerCase();

  if (value === "approve") {
    return "once";
  }

  if (value === "approve always") {
    return "always";
  }

  if (value === "reject") {
    return "reject";
  }

  return undefined;
};

const firstUnanswered = (pending: Extract<PendingOpenCodeInput, { readonly type: "question" }>) =>
  pending.answers.findIndex((answer) => answer === null);

const questionBody = (question: Question) => {
  const options = question.options
    .map((option) => `- ${option.label}: ${option.description}`)
    .join("\n");
  return `${question.question}\n\n${options}`;
};

const answerLabels = (input: { readonly body: string; readonly question: Question }) => {
  const body = input.body.trim();

  if (body.length === 0) {
    return [];
  }

  const optionLabel = (value: string) =>
    input.question.options.find((option) => normalize(option.label) === normalize(value))?.label ??
    value;

  if (input.question.multiple !== true) {
    return [optionLabel(body)];
  }

  const labels = body
    .split(/[,;\n]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(optionLabel);

  return labels.length > 0 ? labels : [optionLabel(body)];
};

const pendingQuestionWithAnswer = (
  pending: Extract<PendingOpenCodeInput, { readonly type: "question" }>,
  body: string,
) => {
  const index = firstUnanswered(pending);

  if (index < 0) {
    return pending;
  }

  const question = pending.questions[index];
  const answer = question === undefined ? [body] : answerLabels({ body, question });

  return {
    ...pending,
    answers: pending.answers.map((existing, item) => (item === index ? answer : existing)),
  };
};

const observeRun = (input: { readonly locator: SessionLocator; readonly organizationId: string }) =>
  OpenCodeRunObserverService.pipe(
    Effect.flatMap((observer) =>
      observer.start({
        linearAgentSessionId: input.locator.linearAgentSessionId,
        opencodeSessionId: input.locator.opencodeSessionId,
        organizationId: input.organizationId,
        projectDirectory: input.locator.projectDirectory,
        workspaceDirectory: input.locator.workspaceDirectory,
      }),
    ),
  );

const handled = (value: string): PromptedInteractionResult => ({ type: "handled", value });

const continueRun = (input: {
  readonly body: string;
  readonly locator: SessionLocator;
}): PromptedInteractionResult => ({
  body: input.body,
  locator: input.locator,
  type: "continue",
});

const processPermissionReply = (input: {
  readonly body: string;
  readonly locator: SessionLocator;
  readonly organizationId: string;
  readonly pending: Extract<PendingOpenCodeInput, { readonly type: "permission" }>;
  readonly postActivity: PostActivity;
}) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCodeClient;
    const store = yield* LinearSessionStore;
    const reply = permissionReplyFrom(input.body);

    if (reply === undefined) {
      yield* input.postActivity({
        content: {
          body: "Reply Approve, Approve Always, or Reject.",
          type: "elicitation",
        },
        signal: "select",
        signalMetadata: selectMetadata(["Approve", "Approve Always", "Reject"]),
      });
      return handled("prompted");
    }

    yield* opencode
      .replyPermission({
        reply,
        requestId: input.pending.opencodeRequestId,
        workspaceDirectory: input.locator.workspaceDirectory,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
        ),
      );
    yield* store
      .deletePendingInput({
        linearAgentSessionId: input.locator.linearAgentSessionId,
        organizationId: input.organizationId,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
        ),
      );
    yield* observeRun({ locator: input.locator, organizationId: input.organizationId });

    return handled("prompted");
  });

const processQuestionReply = (input: {
  readonly body: string;
  readonly locator: SessionLocator;
  readonly organizationId: string;
  readonly pending: Extract<PendingOpenCodeInput, { readonly type: "question" }>;
  readonly postActivity: PostActivity;
}) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCodeClient;
    const store = yield* LinearSessionStore;
    const next = pendingQuestionWithAnswer(input.pending, input.body);
    const index = firstUnanswered(next);

    if (index >= 0) {
      yield* store
        .putPendingInput({ organizationId: input.organizationId, pending: next })
        .pipe(
          Effect.mapError((cause) =>
            LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
          ),
        );
      const question = next.questions[index];

      if (question !== undefined) {
        yield* input.postActivity({
          content: { body: questionBody(question), type: "elicitation" },
          signal: "select",
          signalMetadata: selectMetadata(question.options.map((option) => option.label)),
        });
      }

      return handled("prompted");
    }

    const answers = next.answers.filter((answer) => answer !== null);
    yield* opencode
      .replyQuestion({
        answers,
        requestId: input.pending.opencodeRequestId,
        workspaceDirectory: input.locator.workspaceDirectory,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
        ),
      );
    yield* store
      .deletePendingInput({
        linearAgentSessionId: input.locator.linearAgentSessionId,
        organizationId: input.organizationId,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
        ),
      );
    yield* observeRun({ locator: input.locator, organizationId: input.organizationId });

    return handled("prompted");
  });

const processPendingInput = (input: {
  readonly body: string;
  readonly locator: SessionLocator;
  readonly organizationId: string;
  readonly pending: PendingOpenCodeInput;
  readonly postActivity: PostActivity;
}) => {
  if (input.pending.type === "permission") {
    return processPermissionReply({
      body: input.body,
      locator: input.locator,
      organizationId: input.organizationId,
      pending: input.pending,
      postActivity: input.postActivity,
    });
  }

  if (input.pending.type === "question") {
    return processQuestionReply({
      body: input.body,
      locator: input.locator,
      organizationId: input.organizationId,
      pending: input.pending,
      postActivity: input.postActivity,
    });
  }

  return Effect.succeed(handled("project-selection"));
};

const processProjectSelectionReply = (input: {
  readonly body: string;
  readonly organizationId: string;
  readonly pending: Extract<PendingOpenCodeInput, { readonly type: "projectSelection" }>;
  readonly postActivity: PostActivity;
  readonly startSession: StartSession;
}) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCodeClient;
    const store = yield* LinearSessionStore;
    const projects = yield* opencode.listProjects.pipe(
      Effect.mapError((cause) =>
        LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
      ),
    );
    const project = matchProject({ candidates: [input.body], projects });

    if (project === undefined) {
      yield* input.postActivity({
        content: { body: "Select a valid OpenCode project.", type: "elicitation" },
        signal: "select",
        signalMetadata: selectMetadata(projects.map((item) => item.name)),
      });
      return handled("project-selection");
    }

    const value = yield* input.startSession(project, input.pending.promptContext);
    yield* store
      .deletePendingInput({
        linearAgentSessionId: input.pending.linearAgentSessionId,
        organizationId: input.organizationId,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
        ),
      );

    return handled(value);
  });

const recoverOpenCodePendingInput = (input: {
  readonly locator: SessionLocator;
  readonly organizationId: string;
  readonly postActivity: PostActivity;
}) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCodeClient;
    const store = yield* LinearSessionStore;
    const sessionIds = yield* opencode
      .listSessionTree({
        sessionId: input.locator.opencodeSessionId,
        workspaceDirectory: input.locator.workspaceDirectory,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
        ),
      );
    const permissions = yield* opencode
      .listPendingPermissions({
        sessionId: input.locator.opencodeSessionId,
        sessionIds,
        workspaceDirectory: input.locator.workspaceDirectory,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
        ),
      );
    const permission = permissions[0];

    if (permission !== undefined) {
      const pending: PendingOpenCodeInput = {
        linearAgentSessionId: input.locator.linearAgentSessionId,
        opencodeRequestId: permission.id,
        opencodeSessionId: permission.sessionID,
        type: "permission",
      };
      yield* input.postActivity({
        content: {
          body: `${permission.permission}\n\nApprove\nApprove Always\nReject`,
          type: "elicitation",
        },
        signal: "select",
        signalMetadata: selectMetadata(["Approve", "Approve Always", "Reject"]),
      });
      yield* store
        .putPendingInput({ organizationId: input.organizationId, pending })
        .pipe(
          Effect.mapError((cause) =>
            LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
          ),
        );
      return Option.some(handled("prompted"));
    }

    const questions = yield* opencode
      .listPendingQuestions({
        sessionId: input.locator.opencodeSessionId,
        sessionIds,
        workspaceDirectory: input.locator.workspaceDirectory,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
        ),
      );
    const question = questions[0];

    if (question === undefined) {
      return Option.none<PromptedInteractionResult>();
    }

    const pending: PendingOpenCodeInput = {
      answers: question.questions.map(() => null),
      linearAgentSessionId: input.locator.linearAgentSessionId,
      opencodeRequestId: question.id,
      opencodeSessionId: question.sessionID,
      questions: question.questions,
      type: "question",
    };
    const first = pending.questions[0];

    if (first !== undefined) {
      yield* input.postActivity({
        content: { body: questionBody(first), type: "elicitation" },
        signal: "select",
        signalMetadata: selectMetadata(first.options.map((option) => option.label)),
      });
    }

    yield* store
      .putPendingInput({ organizationId: input.organizationId, pending })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
        ),
      );

    return Option.some(handled("prompted"));
  });

export const processPromptedInteraction = (input: {
  readonly locator: SessionLocator | null;
  readonly payload: PromptedAgentSessionEventWebhookPayload | StopAgentSessionEventWebhookPayload;
  readonly postActivity: PostActivity;
  readonly startSession: StartSession;
}) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCodeClient;
    const store = yield* LinearSessionStore;

    if (input.payload.agentActivity.signal === "stop") {
      if (input.locator === null) {
        return yield* LinearSessionProcessorError.make({ reason: "MissingAgentSession" });
      }

      const observer = yield* OpenCodeRunObserverService;
      yield* opencode
        .abortSession({
          sessionId: input.locator.opencodeSessionId,
          workspaceDirectory: input.locator.workspaceDirectory,
        })
        .pipe(
          Effect.mapError((cause) =>
            LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
          ),
        );
      yield* observer.cancel({ linearAgentSessionId: input.payload.agentSession.id });
      yield* input.postActivity({ content: { body: "Stopped.", type: "response" } });
      return handled("stopped");
    }

    const pending = yield* store
      .getPendingInput({
        linearAgentSessionId: input.payload.agentSession.id,
        organizationId: input.payload.organizationId,
      })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
        ),
      );

    if (pending?.type === "projectSelection") {
      return yield* processProjectSelectionReply({
        body: input.payload.agentActivity.content.body,
        organizationId: input.payload.organizationId,
        pending,
        postActivity: input.postActivity,
        startSession: input.startSession,
      });
    }

    if (input.locator === null) {
      const projects = yield* opencode.listProjects.pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
        ),
      );
      const project = matchProject({
        candidates: [input.payload.agentActivity.content.body],
        projects,
      });

      if (project === undefined) {
        yield* input.postActivity({
          content: { body: "Select a valid OpenCode project.", type: "elicitation" },
          signal: "select",
          signalMetadata: selectMetadata(projects.map((item) => item.name)),
        });
        return handled("project-selection");
      }

      const value = yield* input.startSession(
        project,
        input.payload.promptContext ?? input.payload.agentSession.comment.body,
      );
      return handled(value);
    }

    if (pending !== null) {
      return yield* processPendingInput({
        body: input.payload.agentActivity.content.body,
        locator: input.locator,
        organizationId: input.payload.organizationId,
        pending,
        postActivity: input.postActivity,
      });
    }

    const recovered = yield* recoverOpenCodePendingInput({
      locator: input.locator,
      organizationId: input.payload.organizationId,
      postActivity: input.postActivity,
    });

    if (Option.isSome(recovered)) {
      return recovered.value;
    }

    return continueRun({
      body: input.payload.agentActivity.content.body,
      locator: input.locator,
    });
  });
