import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { openCodePrivateBaseUrl } from "./config.ts";

class OpenCodeClientError extends Schema.TaggedErrorClass<OpenCodeClientError>()(
  "OpenCodeClientError",
  {
    detail: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "ProjectNotFound",
      "ProjectAmbiguous",
      "RequestFailed",
      "InvalidResponse",
    ]),
  },
) {}

const maxMessagePolls = 840;

const detailFrom = (error: unknown) => {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return JSON.stringify({ message: error.message, name: error.name, stack: error.stack });
  }

  return JSON.stringify(error);
};

export type OpenCodeClientService = {
  readonly resolveProject: (input: {
    readonly project: string;
  }) => Effect.Effect<{ readonly directory: string; readonly id: string }, OpenCodeClientError>;
  readonly createWorktree: (input: {
    readonly branch: string;
    readonly projectDirectory: string;
  }) => Effect.Effect<{ readonly workspaceDirectory: string }, OpenCodeClientError>;
  readonly createSession: (input: {
    readonly workspaceDirectory: string;
    readonly title: string;
  }) => Effect.Effect<{ readonly id: string }, OpenCodeClientError>;
  readonly sendMessage: (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
    readonly body: string;
  }) => Effect.Effect<{ readonly body: string }, OpenCodeClientError>;
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
  Effect.tryPromise({
    catch: (cause) =>
      new OpenCodeClientError({ detail: detailFrom(cause), reason: "RequestFailed" }),
    try: async () => promise,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.error !== undefined) {
        return new OpenCodeClientError({
          detail: detailFrom(result.error),
          reason: "RequestFailed",
        });
      }

      if (result.data === undefined) {
        return new OpenCodeClientError({ reason: "InvalidResponse" });
      }

      return Effect.succeed(result.data);
    }),
  );

const resultVoid = (
  promise: Promise<
    | { readonly data: void; readonly error?: undefined }
    | { readonly data?: undefined; readonly error: unknown }
  >,
) =>
  Effect.tryPromise({
    catch: (cause) =>
      new OpenCodeClientError({ detail: detailFrom(cause), reason: "RequestFailed" }),
    try: async () => promise,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.error !== undefined) {
        return new OpenCodeClientError({
          detail: detailFrom(result.error),
          reason: "RequestFailed",
        });
      }

      return Effect.void;
    }),
  );

const responseBody = (
  messages: ReadonlyArray<{
    readonly info: {
      readonly id: string;
      readonly role: string;
      readonly time: { readonly completed?: number; readonly created?: number };
    };
    readonly parts: ReadonlyArray<{ readonly text?: string; readonly type: string }>;
  }>,
  previousCompletedAssistantIds: ReadonlySet<string>,
) => {
  const message = messages.findLast(
    (item) =>
      item.info.role === "assistant" &&
      item.info.time.completed !== undefined &&
      !previousCompletedAssistantIds.has(item.info.id),
  );

  if (message === undefined) {
    return undefined;
  }

  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
};

const sessionIsIdle = (
  statuses: Readonly<Record<string, { readonly type: string }>>,
  sessionId: string,
) => statuses[sessionId]?.type === "idle";

const basename = (path: string) => {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
};

export const makeOpenCodeClient = (
  fetch: OpenCodeFetch,
  baseUrl: string = openCodePrivateBaseUrl,
) => {
  const client = createOpencodeClient({ baseUrl, fetch });

  const sessionMessages = (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
  }) =>
    resultData(
      client.session.messages({
        directory: input.workspaceDirectory,
        sessionID: input.sessionId,
      }),
    );

  const sessionStatuses = (input: { readonly workspaceDirectory: string }) =>
    resultData(
      client.session.status({
        directory: input.workspaceDirectory,
      }),
    );

  const waitForResponse = (
    input: { readonly sessionId: string; readonly workspaceDirectory: string },
    previousCompletedAssistantIds: ReadonlySet<string>,
    remainingPolls: number,
  ): Effect.Effect<{ readonly body: string }, OpenCodeClientError> =>
    sessionStatuses(input).pipe(
      Effect.flatMap((statuses) => {
        if (sessionIsIdle(statuses, input.sessionId)) {
          return sessionMessages(input).pipe(
            Effect.flatMap((messages) => {
              const body = responseBody(messages, previousCompletedAssistantIds);

              if (body !== undefined) {
                return Effect.succeed({ body });
              }

              return new OpenCodeClientError({ reason: "InvalidResponse" });
            }),
          );
        }

        if (remainingPolls <= 0) {
          return new OpenCodeClientError({ reason: "RequestFailed" });
        }

        return Effect.sleep("1 second").pipe(
          Effect.flatMap(() =>
            waitForResponse(input, previousCompletedAssistantIds, remainingPolls - 1),
          ),
        );
      }),
    );

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
          directory: input.projectDirectory,
          worktreeCreateInput: { name: input.branch },
        }),
      ).pipe(Effect.map((worktree) => ({ workspaceDirectory: worktree.directory }))),
    resolveProject: (input) =>
      resultData(client.project.list()).pipe(
        Effect.flatMap((projects) => {
          const matches = projects.filter(
            (project) =>
              project.id === input.project ||
              project.name === input.project ||
              project.worktree === input.project ||
              basename(project.worktree) === input.project,
          );

          if (matches.length === 0) {
            return new OpenCodeClientError({ reason: "ProjectNotFound" });
          }

          if (matches.length > 1) {
            return new OpenCodeClientError({ reason: "ProjectAmbiguous" });
          }

          const project = matches[0];

          if (project === undefined) {
            return new OpenCodeClientError({ reason: "InvalidResponse" });
          }

          return Effect.succeed({ directory: project.worktree, id: project.id });
        }),
      ),
    sendMessage: (input) =>
      sessionMessages(input).pipe(
        Effect.flatMap((messages) => {
          const previousCompletedAssistantIds = new Set(
            messages
              .filter(
                (message) =>
                  message.info.role === "assistant" && message.info.time.completed !== undefined,
              )
              .map((message) => message.info.id),
          );

          return resultVoid(
            client.session.promptAsync({
              directory: input.workspaceDirectory,
              parts: [{ text: input.body, type: "text" }],
              sessionID: input.sessionId,
            }),
          ).pipe(
            Effect.flatMap(() =>
              waitForResponse(input, previousCompletedAssistantIds, maxMessagePolls),
            ),
          );
        }),
      ),
  });
};
