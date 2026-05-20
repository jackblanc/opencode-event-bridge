import { Schema } from "effect";
import * as Effect from "effect/Effect";

import type { LinearWebhookPayload } from "../webhook/payload.ts";

import { OpenCodeClient } from "../../opencode/client.ts";
import { openCodeWebBaseUrl } from "../../opencode/config.ts";
import { LinearHttpClient } from "../client/client.ts";
import { LinearOrgAuthStore } from "../oauth/auth.ts";
import { LinearSessionStore, LinearSessionStoreError } from "./store.ts";

class LinearSessionProcessorError extends Schema.TaggedErrorClass<LinearSessionProcessorError>()(
  "LinearSessionProcessorError",
  {
    cause: Schema.optional(Schema.Defect),
    reason: Schema.Literals([
      "MissingRepositoryLabel",
      "AmbiguousRepositoryLabel",
      "AuthFailure",
      "LinearFailure",
      "OpenCodeFailure",
      "StoreFailure",
    ]),
  },
) {}

const branchNameFor = (identifier: string) => identifier.toLowerCase();

const base64Encode = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let text = "";

  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }

  return btoa(text).replace(/=+$/, "");
};

const opencodeSessionUrl = (input: {
  readonly projectDirectory: string;
  readonly sessionId: string;
}) => `${openCodeWebBaseUrl}/${base64Encode(input.projectDirectory)}/session/${input.sessionId}`;

const errorBody = (reason: string) => {
  if (reason === "MissingRepositoryLabel") {
    return "I cannot start because this issue is missing a `repo:*` label.";
  }

  if (reason === "AmbiguousRepositoryLabel") {
    return "I cannot start because this issue has multiple `repo:*` labels.";
  }

  if (reason === "MissingAgentSession") {
    return "I cannot continue because I do not have an OpenCode session for this Linear agent session.";
  }

  return "I could not continue this OpenCode run. Check bridge logs for details.";
};

const repoLabelPrefix = "repo:";

const repoLabelGroup = "repo";

const repoProjectFromLabels = (
  labels: ReadonlyArray<{
    readonly name: string;
    readonly parent?: { readonly name: string } | null;
  }>,
) => {
  const projects = new Set(
    labels
      .map((label) => {
        if (label.name.startsWith(repoLabelPrefix)) {
          return label.name.slice(repoLabelPrefix.length).trim();
        }

        if (label.parent?.name === repoLabelGroup) {
          return label.name.trim();
        }

        return "";
      })
      .filter((label) => label.length > 0),
  );
  projects.delete("");

  if (projects.size === 0) {
    return new LinearSessionProcessorError({ reason: "MissingRepositoryLabel" });
  }

  if (projects.size > 1) {
    return new LinearSessionProcessorError({ reason: "AmbiguousRepositoryLabel" });
  }

  const project = projects.values().next().value;

  if (project === undefined) {
    return new LinearSessionProcessorError({ reason: "MissingRepositoryLabel" });
  }

  return Effect.succeed(project);
};

const ensureWorktree = (input: {
  readonly organizationId: string;
  readonly linearIssueId: string;
  readonly issueIdentifier: string;
  readonly opencodeProjectDirectory: string;
}) =>
  Effect.gen(function* () {
    const store = yield* LinearSessionStore;
    const opencode = yield* OpenCodeClient;
    const stored = yield* store
      .getIssueWorktree(input)
      .pipe(
        Effect.mapError(
          (cause) => new LinearSessionProcessorError({ cause, reason: "StoreFailure" }),
        ),
      );

    if (stored !== null) {
      return stored.opencodeWorkspaceDirectory;
    }

    const worktree = yield* opencode
      .createWorktree({
        branch: branchNameFor(input.issueIdentifier),
        projectDirectory: input.opencodeProjectDirectory,
      })
      .pipe(
        Effect.mapError(
          (cause) => new LinearSessionProcessorError({ cause, reason: "OpenCodeFailure" }),
        ),
      );

    yield* store
      .putIssueWorktree({
        linearIssueId: input.linearIssueId,
        opencodeWorkspaceDirectory: worktree.workspaceDirectory,
        organizationId: input.organizationId,
      })
      .pipe(
        Effect.mapError(
          (cause) => new LinearSessionProcessorError({ cause, reason: "StoreFailure" }),
        ),
      );

    return worktree.workspaceDirectory;
  });

export const processLinearWebhook = (payload: LinearWebhookPayload) =>
  Effect.gen(function* () {
    const store = yield* LinearSessionStore;
    const opencode = yield* OpenCodeClient;
    const linear = yield* LinearHttpClient;
    const authStore = yield* LinearOrgAuthStore;

    if (payload.type === "Issue") {
      return "ignored";
    }

    const orgAuth = yield* authStore.getOrgAuth({ organizationId: payload.organizationId }).pipe(
      Effect.mapError((cause) => new LinearSessionProcessorError({ cause, reason: "AuthFailure" })),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logError("linear session processing failed", {
            action: payload.action,
            agentSessionId: payload.agentSession.id,
            cause: error.cause,
            issueId: payload.agentSession.issue.id,
            issueIdentifier: payload.agentSession.issue.identifier,
            organizationId: payload.organizationId,
            reason: error.reason,
            webhookId: payload.webhookId,
          }).pipe(Effect.as(undefined)),
        onSuccess: Effect.succeed,
      }),
    );

    if (orgAuth === undefined) {
      return "error";
    }

    const postActivity = (input: Parameters<typeof linear.createAgentActivity>[0]["content"]) =>
      linear
        .createAgentActivity({
          accessToken: orgAuth.accessToken,
          agentSessionId: payload.agentSession.id,
          content: input,
        })
        .pipe(
          Effect.mapError(
            (cause) => new LinearSessionProcessorError({ cause, reason: "LinearFailure" }),
          ),
        );

    const updateSessionLink = (input: {
      readonly projectDirectory: string;
      readonly sessionId: string;
    }) =>
      linear
        .updateAgentSessionExternalUrls({
          accessToken: orgAuth.accessToken,
          agentSessionId: payload.agentSession.id,
          externalUrls: [
            {
              label: "OpenCode",
              url: opencodeSessionUrl(input),
            },
          ],
        })
        .pipe(
          Effect.mapError(
            (cause) => new LinearSessionProcessorError({ cause, reason: "LinearFailure" }),
          ),
        );

    const run = Effect.gen(function* () {
      if (payload.action === "created") {
        const existing = yield* store
          .getAgentSession({
            linearAgentSessionId: payload.agentSession.id,
            organizationId: payload.organizationId,
          })
          .pipe(
            Effect.mapError(
              (cause) => new LinearSessionProcessorError({ cause, reason: "StoreFailure" }),
            ),
          );

        if (existing !== null) {
          return "created";
        }

        yield* postActivity({
          body: "Accepted. Starting OpenCode.",
          type: "thought",
        });

        const labels = yield* linear
          .getIssueLabels({
            accessToken: orgAuth.accessToken,
            issueId: payload.agentSession.issue.id,
          })
          .pipe(
            Effect.mapError(
              (cause) => new LinearSessionProcessorError({ cause, reason: "LinearFailure" }),
            ),
          );
        const projectLabel = yield* repoProjectFromLabels(labels);
        yield* Effect.log("linear session repo resolved", {
          issueIdentifier: payload.agentSession.issue.identifier,
          projectLabel,
        });
        const project = yield* opencode
          .resolveProject({ project: projectLabel })
          .pipe(
            Effect.mapError(
              (cause) => new LinearSessionProcessorError({ cause, reason: "OpenCodeFailure" }),
            ),
          );
        yield* Effect.log("linear session opencode project resolved", {
          issueIdentifier: payload.agentSession.issue.identifier,
          opencodeProjectDirectory: project.directory,
          opencodeProjectId: project.id,
        });
        const workspaceDirectory = yield* ensureWorktree({
          issueIdentifier: payload.agentSession.issue.identifier,
          linearIssueId: payload.agentSession.issue.id,
          opencodeProjectDirectory: project.directory,
          organizationId: payload.organizationId,
        });
        yield* Effect.log("linear session worktree ready", {
          issueIdentifier: payload.agentSession.issue.identifier,
          workspaceDirectory,
        });

        const session = yield* opencode
          .createSession({
            title: payload.agentSession.issue.title,
            workspaceDirectory,
          })
          .pipe(
            Effect.mapError(
              (cause) => new LinearSessionProcessorError({ cause, reason: "OpenCodeFailure" }),
            ),
          );
        yield* Effect.log("linear session opencode session created", {
          issueIdentifier: payload.agentSession.issue.identifier,
          opencodeSessionId: session.id,
        });

        yield* updateSessionLink({
          projectDirectory: project.directory,
          sessionId: session.id,
        });

        yield* store
          .putAgentSession({
            linearAgentSessionId: payload.agentSession.id,
            linearIssueId: payload.agentSession.issue.id,
            opencodeSessionId: session.id,
            opencodeWorkspaceDirectory: workspaceDirectory,
            organizationId: payload.organizationId,
          })
          .pipe(
            Effect.mapError(
              (cause) => new LinearSessionProcessorError({ cause, reason: "StoreFailure" }),
            ),
          );

        const response = yield* opencode
          .sendMessage({
            body: payload.promptContext,
            sessionId: session.id,
            workspaceDirectory,
          })
          .pipe(
            Effect.mapError(
              (cause) => new LinearSessionProcessorError({ cause, reason: "OpenCodeFailure" }),
            ),
          );
        yield* Effect.log("linear session opencode response received", {
          issueIdentifier: payload.agentSession.issue.identifier,
          opencodeSessionId: session.id,
        });

        yield* postActivity({
          body: response.body,
          type: "response",
        });

        return "created";
      }

      yield* postActivity({
        body: "Accepted. Continuing OpenCode.",
        type: "thought",
      });

      const record = yield* store
        .getAgentSession({
          linearAgentSessionId: payload.agentActivity.agentSessionId,
          organizationId: payload.organizationId,
        })
        .pipe(
          Effect.mapError(
            (cause) => new LinearSessionProcessorError({ cause, reason: "StoreFailure" }),
          ),
        );

      if (record === null) {
        return yield* new LinearSessionStoreError({ reason: "MissingAgentSession" });
      }

      const response = yield* opencode
        .sendMessage({
          body: payload.agentActivity.content.body,
          sessionId: record.opencodeSessionId,
          workspaceDirectory: record.opencodeWorkspaceDirectory,
        })
        .pipe(
          Effect.mapError(
            (cause) => new LinearSessionProcessorError({ cause, reason: "OpenCodeFailure" }),
          ),
        );

      yield* postActivity({
        body: response.body,
        type: "response",
      });
      return "prompted";
    });

    return yield* Effect.catch(run, (error) => {
      const context = {
        action: payload.action,
        agentSessionId: payload.agentSession.id,
        cause: "cause" in error ? error.cause : undefined,
        detail:
          "cause" in error &&
          typeof error.cause === "object" &&
          error.cause !== null &&
          "detail" in error.cause
            ? error.cause.detail
            : undefined,
        issueId: payload.agentSession.issue.id,
        issueIdentifier: payload.agentSession.issue.identifier,
        organizationId: payload.organizationId,
        reason: error.reason,
        webhookId: payload.webhookId,
      };

      return Effect.logError("linear session processing failed", context).pipe(
        Effect.flatMap(() =>
          postActivity({
            body: errorBody(error.reason),
            type: "error",
          }).pipe(
            Effect.catch((postError) =>
              Effect.logError("linear session error activity failed", {
                ...context,
                postErrorReason: postError.reason,
              }),
            ),
          ),
        ),
        Effect.as("error"),
      );
    });
  });
