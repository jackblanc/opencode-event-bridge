import type { Event } from "@opencode-ai/sdk/v2/client";

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
      "SessionError",
      "Timeout",
    ]),
  },
) {}

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
  readonly promptAsync: (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
    readonly body: string;
  }) => Effect.Effect<void, OpenCodeClientError>;
  readonly completedResponse: (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
  }) => Effect.Effect<{ readonly body: string }, OpenCodeClientError>;
  readonly waitUntilIdle: (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
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
) => {
  const message = messages.findLast(
    (item) => item.info.role === "assistant" && item.info.time.completed !== undefined,
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
  status: { readonly [key: string]: { readonly type: string } },
  sessionId: string,
) => {
  const item = status[sessionId];
  return item === undefined || item.type === "idle";
};

const eventIsIdle = (event: Event, sessionId: string) =>
  (event.type === "session.idle" && event.properties.sessionID === sessionId) ||
  (event.type === "session.status" &&
    event.properties.sessionID === sessionId &&
    event.properties.status.type === "idle");

const eventSessionError = (event: Event, sessionId: string) => {
  if (event.type !== "session.error" || event.properties.sessionID !== sessionId) {
    return undefined;
  }

  return detailFrom(event.properties.error);
};

const waitMillis = 250;
const maxWaitMillis = 10 * 60 * 1_000;

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

  return OpenCodeClient.of({
    completedResponse: (input) =>
      sessionMessages(input).pipe(
        Effect.flatMap((messages) => {
          const body = responseBody(messages);

          if (body !== undefined) {
            return Effect.succeed({ body });
          }

          return new OpenCodeClientError({ reason: "InvalidResponse" });
        }),
      ),
    waitUntilIdle: (input) =>
      resultData(client.session.status({ directory: input.workspaceDirectory })).pipe(
        Effect.flatMap((status) => {
          if (sessionIsIdle(status, input.sessionId)) {
            return Effect.void;
          }

          return Effect.tryPromise({
            catch: (cause) =>
              new OpenCodeClientError({ detail: detailFrom(cause), reason: "RequestFailed" }),
            try: async () => {
              await Promise.resolve();
              return new Promise<void>((resolve, reject) => {
                const controller = new AbortController();
                const started = Date.now();
                let settled = false;

                const settle = (result: Effect.Effect<void, OpenCodeClientError>) => {
                  if (settled) {
                    return;
                  }

                  settled = true;
                  controller.abort();
                  Effect.runPromise(result).then(resolve, reject);
                };

                const poll = () => {
                  if (settled) {
                    return;
                  }

                  if (Date.now() - started > maxWaitMillis) {
                    settle(new OpenCodeClientError({ reason: "Timeout" }));
                    return;
                  }

                  client.session.status({ directory: input.workspaceDirectory }).then(
                    (result) => {
                      if (result.error !== undefined) {
                        settle(
                          new OpenCodeClientError({
                            detail: detailFrom(result.error),
                            reason: "RequestFailed",
                          }),
                        );
                        return;
                      }

                      if (sessionIsIdle(result.data, input.sessionId)) {
                        settle(Effect.void);
                        return;
                      }

                      setTimeout(poll, waitMillis);
                    },
                    (cause: unknown) => {
                      settle(
                        new OpenCodeClientError({
                          detail: detailFrom(cause),
                          reason: "RequestFailed",
                        }),
                      );
                    },
                  );
                };

                client.event
                  .subscribe({ directory: input.workspaceDirectory }, { signal: controller.signal })
                  .then(
                    (events) => {
                      void Promise.resolve()
                        .then(async () => {
                          for await (const event of events.stream) {
                            if (eventIsIdle(event, input.sessionId)) {
                              settle(Effect.void);
                              return;
                            }

                            const detail = eventSessionError(event, input.sessionId);
                            if (detail !== undefined) {
                              settle(new OpenCodeClientError({ detail, reason: "SessionError" }));
                              return;
                            }
                          }
                        })
                        .then(undefined, (cause: unknown) => {
                          if (!settled) {
                            settle(
                              new OpenCodeClientError({
                                detail: detailFrom(cause),
                                reason: "RequestFailed",
                              }),
                            );
                          }
                        });
                    },
                    (cause: unknown) => {
                      settle(
                        new OpenCodeClientError({
                          detail: detailFrom(cause),
                          reason: "RequestFailed",
                        }),
                      );
                    },
                  );

                poll();
              });
            },
          });
        }),
      ),
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
    promptAsync: (input) =>
      resultVoid(
        client.session.promptAsync({
          directory: input.workspaceDirectory,
          parts: [{ text: input.body, type: "text" }],
          sessionID: input.sessionId,
        }),
      ),
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
  });
};
