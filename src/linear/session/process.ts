import * as Effect from "effect/Effect";

import type {
  LinearAgentActivityContent,
  LinearAgentActivitySignalMetadata,
} from "../client/client.ts";
import type { LinearWebhookPayload } from "../webhook/payload.ts";
import type { OpenCodeProject } from "./project.ts";

import { OpenCodeClient, pathBasename } from "../../opencode/client.ts";
import { openCodeWebBaseUrl } from "../../opencode/config.ts";
import { OpenCodeRunObserverService } from "../../opencode/run-observer.ts";
import { LinearHttpClient } from "../client/client.ts";
import { processPromptedInteraction } from "../interaction/process.ts";
import { processIssueWebhook } from "../issue/process.ts";
import { LinearOrgAuthStore } from "../oauth/auth.ts";
import { errorBody, LinearSessionProcessorError } from "./error.ts";
import {
  matchProject,
  normalize,
  projectCandidatesFromLabels,
  repoLabelPrefix,
  selectMetadata,
} from "./project.ts";
import { LinearSessionStore } from "./store.ts";

const branchNameFor = (identifier: string) => identifier.toLowerCase();

const base64Encode = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let text = "";

  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }

  return btoa(text).replace(/=+$/, "");
};

const opencodeSessionUrl = (input: { readonly directory: string; readonly sessionId: string }) =>
  `${openCodeWebBaseUrl}/${base64Encode(input.directory)}/session/${input.sessionId}`;

const worktreeMatches = (input: { readonly branch: string; readonly workspaceDirectory: string }) =>
  normalize(pathBasename(input.workspaceDirectory)) === normalize(input.branch);

const ensureWorktree = (input: {
  readonly issueIdentifier: string;
  readonly projectDirectory: string;
}) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCodeClient;
    const branch = branchNameFor(input.issueIdentifier);
    const worktrees = yield* opencode
      .listWorktrees({ projectDirectory: input.projectDirectory })
      .pipe(
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
        ),
      );
    const matched = worktrees.find((worktree) =>
      worktreeMatches({ branch, workspaceDirectory: worktree.workspaceDirectory }),
    );

    if (matched !== undefined) {
      return matched.workspaceDirectory;
    }

    return yield* opencode
      .createWorktree({ branch, projectDirectory: input.projectDirectory })
      .pipe(
        Effect.map((worktree) => worktree.workspaceDirectory),
        Effect.mapError((cause) =>
          LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
        ),
      );
  });

export const processLinearWebhook = (message: {
  readonly allowedOrganizationId: string;
  readonly payload: LinearWebhookPayload;
}) =>
  Effect.gen(function* () {
    const payload = message.payload;
    if (payload.organizationId !== message.allowedOrganizationId) {
      yield* Effect.logWarning("linear webhook rejected for unauthorized organization", {
        action: payload.action,
        organizationId: payload.organizationId,
        type: payload.type,
        webhookId: payload.webhookId,
      });
      return "organization-not-allowed";
    }

    const authStore = yield* LinearOrgAuthStore;
    const orgAuth = yield* authStore.getOrgAuth({ organizationId: payload.organizationId }).pipe(
      Effect.matchEffect({
        onFailure: (cause) => {
          if (cause.reason !== "MissingOrganizationAuth") {
            return LinearSessionProcessorError.make({ cause, reason: "AuthFailure" });
          }

          return Effect.logError("linear session processing failed", {
            action: payload.action,
            cause: cause.cause,
            organizationId: payload.organizationId,
            reason: cause.reason,
            webhookId: payload.webhookId,
          }).pipe(Effect.as(undefined));
        },
        onSuccess: Effect.succeed,
      }),
    );

    if (orgAuth === undefined) {
      return "error";
    }

    if (payload.type === "Issue") {
      return yield* processIssueWebhook({ accessToken: orgAuth.accessToken, payload });
    }

    const store = yield* LinearSessionStore;
    const opencode = yield* OpenCodeClient;
    const observer = yield* OpenCodeRunObserverService;
    const linear = yield* LinearHttpClient;

    const postActivity = (input: {
      readonly content: LinearAgentActivityContent;
      readonly signal?: "select";
      readonly signalMetadata?: LinearAgentActivitySignalMetadata;
    }) =>
      linear
        .createAgentActivity({
          accessToken: orgAuth.accessToken,
          agentSessionId: payload.agentSession.id,
          content: input.content,
          signal: input.signal,
          signalMetadata: input.signalMetadata,
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            LinearSessionProcessorError.make({ cause, reason: "LinearFailure" }),
          ),
        );

    const updateSessionLink = (input: { readonly directory: string; readonly sessionId: string }) =>
      linear
        .updateAgentSessionExternalUrls({
          accessToken: orgAuth.accessToken,
          agentSessionId: payload.agentSession.id,
          externalUrls: [{ label: "OpenCode", url: opencodeSessionUrl(input) }],
        })
        .pipe(
          Effect.mapError((cause) =>
            LinearSessionProcessorError.make({ cause, reason: "LinearFailure" }),
          ),
        );

    const observeRun = (input: {
      readonly opencodeSessionId: string;
      readonly projectDirectory: string;
      readonly workspaceDirectory: string;
    }) =>
      observer.start({
        linearAgentSessionId: payload.agentSession.id,
        opencodeSessionId: input.opencodeSessionId,
        organizationId: payload.organizationId,
        projectDirectory: input.projectDirectory,
        workspaceDirectory: input.workspaceDirectory,
      });
    const cancelRun = () => observer.cancel({ linearAgentSessionId: payload.agentSession.id });

    const writeProjectLabel = (project: OpenCodeProject) =>
      linear
        .addIssueLabel({
          accessToken: orgAuth.accessToken,
          issueId: payload.agentSession.issue.id,
          labelName: `${repoLabelPrefix}${pathBasename(project.directory)}`,
        })
        .pipe(
          Effect.catchTag("LinearHttpClientError", (error) => {
            if (error.reason === "PermissionFailure") {
              return postActivity({
                content: {
                  body: "Warning: could not write Linear repo label.",
                  type: "response",
                },
              });
            }

            return LinearSessionProcessorError.make({ cause: error, reason: "LinearFailure" });
          }),
        );

    const startSession = (project: OpenCodeProject, promptBody: string) =>
      Effect.gen(function* () {
        yield* postActivity({ content: { body: "Accepted. Starting OpenCode.", type: "thought" } });

        if (payload.action === "prompted") {
          yield* writeProjectLabel(project);
        }

        const workspaceDirectory = yield* ensureWorktree({
          issueIdentifier: payload.agentSession.issue.identifier,
          projectDirectory: project.directory,
        }).pipe(Effect.provideService(OpenCodeClient, opencode));
        const session = yield* opencode
          .createSession({ title: payload.agentSession.issue.title, workspaceDirectory })
          .pipe(
            Effect.mapError((cause) =>
              LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
            ),
          );

        yield* updateSessionLink({ directory: workspaceDirectory, sessionId: session.id });
        yield* store
          .putSessionLocator({
            locator: {
              linearAgentSessionId: payload.agentSession.id,
              opencodeSessionId: session.id,
              projectDirectory: project.directory,
              workspaceDirectory,
            },
            organizationId: payload.organizationId,
          })
          .pipe(
            Effect.mapError((cause) =>
              LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
            ),
          );

        yield* observeRun({
          opencodeSessionId: session.id,
          projectDirectory: project.directory,
          workspaceDirectory,
        });
        yield* opencode
          .promptAsync({ body: promptBody, sessionId: session.id, workspaceDirectory })
          .pipe(
            Effect.tapError(() => cancelRun()),
            Effect.mapError((cause) =>
              LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
            ),
          );

        return payload.action;
      });

    const run = Effect.gen(function* () {
      const locator = yield* store
        .getSessionLocator({
          linearAgentSessionId: payload.agentSession.id,
          organizationId: payload.organizationId,
        })
        .pipe(
          Effect.mapError((cause) =>
            LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
          ),
        );

      if (payload.action === "created") {
        if (locator !== null) {
          return "created";
        }

        const projects = yield* opencode.listProjects.pipe(
          Effect.mapError((cause) =>
            LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
          ),
        );
        const labels = yield* linear
          .getIssueLabels({
            accessToken: orgAuth.accessToken,
            issueId: payload.agentSession.issue.id,
          })
          .pipe(
            Effect.mapError((cause) =>
              LinearSessionProcessorError.make({ cause, reason: "LinearFailure" }),
            ),
          );
        const project = matchProject({ candidates: projectCandidatesFromLabels(labels), projects });

        if (project === undefined) {
          yield* store
            .putPendingInput({
              organizationId: payload.organizationId,
              pending: {
                linearAgentSessionId: payload.agentSession.id,
                promptContext: payload.promptContext,
                type: "projectSelection",
              },
            })
            .pipe(
              Effect.mapError((cause) =>
                LinearSessionProcessorError.make({ cause, reason: "StoreFailure" }),
              ),
            );
          yield* postActivity({
            content: {
              body: `Select project:\n\n${projects.map((item) => `- ${item.name}`).join("\n")}`,
              type: "elicitation",
            },
            signal: "select",
            signalMetadata: selectMetadata(projects.map((item) => item.name)),
          });
          return "project-selection";
        }

        return yield* startSession(project, payload.promptContext);
      }

      const interaction = yield* processPromptedInteraction({
        locator,
        payload,
        postActivity,
        startSession,
      });

      if (interaction.type === "handled") {
        return interaction.value;
      }

      yield* postActivity({
        content: { body: "Accepted. Continuing OpenCode.", type: "thought" },
      });
      yield* observeRun({
        opencodeSessionId: interaction.locator.opencodeSessionId,
        projectDirectory: interaction.locator.projectDirectory,
        workspaceDirectory: interaction.locator.workspaceDirectory,
      });
      yield* opencode
        .promptAsync({
          body: interaction.body,
          sessionId: interaction.locator.opencodeSessionId,
          workspaceDirectory: interaction.locator.workspaceDirectory,
        })
        .pipe(
          Effect.tapError(() => cancelRun()),
          Effect.mapError((cause) =>
            LinearSessionProcessorError.make({ cause, reason: "OpenCodeFailure" }),
          ),
        );
      return "prompted";
    });

    return yield* Effect.catch(run, (error) => {
      const context = {
        action: payload.action,
        cause: error.cause,
        organizationId: payload.organizationId,
        reason: error.reason,
        type: payload.type,
        webhookId: payload.webhookId,
      };

      return Effect.logError("linear session processing failed", context).pipe(
        Effect.flatMap(() =>
          postActivity({ content: { body: errorBody(error.reason), type: "error" } }).pipe(
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
