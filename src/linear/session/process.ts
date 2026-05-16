import { Schema } from "effect";
import * as Effect from "effect/Effect";

import type { LinearWebhookPayload } from "../webhook/payload.ts";

import { OpenCodeClient } from "../../opencode/client.ts";
import { LinearSessionStore, LinearSessionStoreError } from "./store.ts";

class LinearSessionProcessorError extends Schema.TaggedErrorClass<LinearSessionProcessorError>()(
  "LinearSessionProcessorError",
  {
    reason: Schema.Literals(["OpenCodeFailure", "StoreFailure"]),
  },
) {}

const branchNameFor = (identifier: string) => identifier.toLowerCase();

const ensureWorktree = (input: {
  readonly organizationId: string;
  readonly linearIssueId: string;
  readonly issueIdentifier: string;
}) =>
  Effect.gen(function* () {
    const store = yield* LinearSessionStore;
    const opencode = yield* OpenCodeClient;
    const stored = yield* store
      .getIssueWorktree(input)
      .pipe(Effect.mapError(() => new LinearSessionProcessorError({ reason: "StoreFailure" })));

    if (stored !== null) {
      return stored.opencodeWorkspaceDirectory;
    }

    const worktree = yield* opencode
      .createWorktree({
        branch: branchNameFor(input.issueIdentifier),
      })
      .pipe(Effect.mapError(() => new LinearSessionProcessorError({ reason: "OpenCodeFailure" })));

    yield* store
      .putIssueWorktree({
        linearIssueId: input.linearIssueId,
        opencodeWorkspaceDirectory: worktree.workspaceDirectory,
        organizationId: input.organizationId,
      })
      .pipe(Effect.mapError(() => new LinearSessionProcessorError({ reason: "StoreFailure" })));

    return worktree.workspaceDirectory;
  });

export const processLinearWebhook = (payload: LinearWebhookPayload) =>
  Effect.gen(function* () {
    const store = yield* LinearSessionStore;
    const opencode = yield* OpenCodeClient;

    if (payload.type === "Issue") {
      return "ignored";
    }

    if (payload.action === "created") {
      const existing = yield* store
        .getAgentSession({
          linearAgentSessionId: payload.agentSession.id,
          organizationId: payload.organizationId,
        })
        .pipe(Effect.mapError(() => new LinearSessionProcessorError({ reason: "StoreFailure" })));

      if (existing !== null) {
        return "created";
      }

      const workspaceDirectory = yield* ensureWorktree({
        issueIdentifier: payload.agentSession.issue.identifier,
        linearIssueId: payload.agentSession.issue.id,
        organizationId: payload.organizationId,
      });

      const session = yield* opencode
        .createSession({
          title: payload.agentSession.issue.title,
          workspaceDirectory,
        })
        .pipe(
          Effect.mapError(() => new LinearSessionProcessorError({ reason: "OpenCodeFailure" })),
        );

      yield* store
        .putAgentSession({
          linearAgentSessionId: payload.agentSession.id,
          linearIssueId: payload.agentSession.issue.id,
          opencodeSessionId: session.id,
          opencodeWorkspaceDirectory: workspaceDirectory,
          organizationId: payload.organizationId,
        })
        .pipe(Effect.mapError(() => new LinearSessionProcessorError({ reason: "StoreFailure" })));

      yield* opencode
        .sendMessage({
          body: payload.promptContext,
          sessionId: session.id,
          workspaceDirectory,
        })
        .pipe(
          Effect.mapError(() => new LinearSessionProcessorError({ reason: "OpenCodeFailure" })),
        );

      return "created";
    }

    const record = yield* store
      .getAgentSession({
        linearAgentSessionId: payload.agentActivity.agentSessionId,
        organizationId: payload.organizationId,
      })
      .pipe(Effect.mapError(() => new LinearSessionProcessorError({ reason: "StoreFailure" })));

    if (record === null) {
      return yield* new LinearSessionStoreError({ reason: "MissingAgentSession" });
    }

    yield* opencode
      .sendMessage({
        body: payload.agentActivity.content.body,
        sessionId: record.opencodeSessionId,
        workspaceDirectory: record.opencodeWorkspaceDirectory,
      })
      .pipe(Effect.mapError(() => new LinearSessionProcessorError({ reason: "OpenCodeFailure" })));
    return "prompted";
  });
