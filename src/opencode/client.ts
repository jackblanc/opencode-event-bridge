import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

class OpenCodeClientError extends Schema.TaggedErrorClass<OpenCodeClientError>()(
  "OpenCodeClientError",
  {
    reason: Schema.Literals(["RequestFailed", "InvalidResponse"]),
  },
) {}

export type OpenCodeClientService = {
  readonly createWorktree: (input: {
    readonly branch: string;
  }) => Effect.Effect<{ readonly workspaceDirectory: string }, OpenCodeClientError>;
  readonly createSession: (input: {
    readonly workspaceDirectory: string;
    readonly title: string;
  }) => Effect.Effect<{ readonly id: string }, OpenCodeClientError>;
  readonly sendMessage: (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
    readonly body: string;
  }) => Effect.Effect<void, OpenCodeClientError>;
};

export class OpenCodeClient extends Context.Service<OpenCodeClient, OpenCodeClientService>()(
  "app/OpenCodeClient",
) {}

export type OpenCodeFetch = typeof fetch;

const resultData = <A>(
  promise: Promise<
    | { readonly data: A; readonly error?: undefined }
    | { readonly data?: undefined; readonly error: unknown }
  >,
) =>
  Effect.promise(async () => promise).pipe(
    Effect.mapError(() => new OpenCodeClientError({ reason: "RequestFailed" })),
    Effect.flatMap((result) => {
      if (result.error !== undefined) {
        return new OpenCodeClientError({ reason: "RequestFailed" });
      }

      if (result.data === undefined) {
        return new OpenCodeClientError({ reason: "InvalidResponse" });
      }

      return Effect.succeed(result.data);
    }),
  );

export const makeOpenCodeClient = (fetch: OpenCodeFetch) => {
  const client = createOpencodeClient({ baseUrl: "http://opencode", fetch });

  return OpenCodeClient.of({
    createSession: (input) =>
      resultData(
        client.session.create({
          directory: input.workspaceDirectory,
          title: input.title,
        }),
      ).pipe(Effect.map((session) => ({ id: session.id }))),
    createWorktree: (input) =>
      resultData(
        client.worktree.create({
          worktreeCreateInput: { name: input.branch },
        }),
      ).pipe(Effect.map((worktree) => ({ workspaceDirectory: worktree.directory }))),
    sendMessage: (input) =>
      resultData(
        client.session.prompt({
          directory: input.workspaceDirectory,
          parts: [{ text: input.body, type: "text" }],
          sessionID: input.sessionId,
        }),
      ).pipe(Effect.asVoid),
  });
};
