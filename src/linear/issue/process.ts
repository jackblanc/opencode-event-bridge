import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { SessionLocator } from "../session/store.ts";
import type { IssueCleanupWebhookPayload, IssueWebhookPayload } from "../webhook/payload.ts";

import { OpenCodeClient } from "../../opencode/client.ts";
import { OpenCodeRunObserverService } from "../../opencode/run-observer.ts";
import { LinearHttpClient } from "../client/client.ts";
import { LinearSessionProcessorError } from "../session/error.ts";
import { LinearSessionStore } from "../session/store.ts";

const uniqueWorktrees = (locators: ReadonlyArray<SessionLocator>) => {
  const worktrees = new Map<string, SessionLocator>();

  for (const locator of locators) {
    worktrees.set(`${locator.projectDirectory}:${locator.workspaceDirectory}`, locator);
  }

  return [...worktrees.values()];
};

export const processIssueWebhook = (input: {
  readonly accessToken: string;
  readonly payload: IssueCleanupWebhookPayload | IssueWebhookPayload;
}) =>
  Effect.gen(function* () {
    const payload = input.payload;
    const closed =
      payload.data.state.type === "completed" || payload.data.state.type === "canceled";

    if (payload.action !== "update" || !closed) {
      return "ignored";
    }

    const linear = yield* LinearHttpClient;
    const opencode = yield* OpenCodeClient;
    const observer = yield* OpenCodeRunObserverService;
    const store = yield* LinearSessionStore;

    const ids = yield* linear
      .getIssueAgentSessionIds({
        accessToken: input.accessToken,
        issueId: payload.data.id,
      })
      .pipe(
        Effect.mapError(
          (cause) => new LinearSessionProcessorError({ cause, reason: "LinearFailure" }),
        ),
      );
    const locators = yield* Effect.all(
      ids.map((linearAgentSessionId) =>
        store
          .getSessionLocator({
            linearAgentSessionId,
            organizationId: payload.organizationId,
          })
          .pipe(
            Effect.mapError(
              (cause) => new LinearSessionProcessorError({ cause, reason: "StoreFailure" }),
            ),
          ),
      ),
    );
    const loaded = locators.filter((locator) => locator !== null);

    const aborts = yield* Effect.all(
      loaded.map((locator) =>
        opencode.abortSession({
          sessionId: locator.opencodeSessionId,
          workspaceDirectory: locator.workspaceDirectory,
        }),
      ),
      { mode: "result" },
    );
    const abort = aborts.find(Result.isFailure);

    if (abort !== undefined) {
      return yield* new LinearSessionProcessorError({
        cause: abort.failure,
        reason: "OpenCodeFailure",
      });
    }

    yield* Effect.all(
      loaded.map((locator) =>
        observer.cancel({ linearAgentSessionId: locator.linearAgentSessionId }),
      ),
      { discard: true },
    );

    const removals = yield* Effect.all(
      uniqueWorktrees(loaded).map((locator) =>
        opencode.removeWorktree({
          projectDirectory: locator.projectDirectory,
          workspaceDirectory: locator.workspaceDirectory,
        }),
      ),
      { mode: "result" },
    );
    const removal = removals.find(Result.isFailure);

    if (removal !== undefined) {
      return yield* new LinearSessionProcessorError({
        cause: removal.failure,
        reason: "OpenCodeFailure",
      });
    }

    const deletes = yield* Effect.all(
      loaded.flatMap((locator) => [
        store.deletePendingInput({
          linearAgentSessionId: locator.linearAgentSessionId,
          organizationId: payload.organizationId,
        }),
        store.deleteSessionLocator({
          linearAgentSessionId: locator.linearAgentSessionId,
          organizationId: payload.organizationId,
        }),
      ]),
      { mode: "result" },
    );
    const deletion = deletes.find(Result.isFailure);

    if (deletion !== undefined) {
      return yield* new LinearSessionProcessorError({
        cause: deletion.failure,
        reason: "StoreFailure",
      });
    }

    return "cleaned";
  });
