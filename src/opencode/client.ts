import type { Event, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Clock, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { openCodePrivateBaseUrl } from "./config.ts";

export class OpenCodeClientError extends Schema.TaggedErrorClass<OpenCodeClientError>()(
  "OpenCodeClientError",
  {
    detail: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "InputPending",
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
  readonly abortSession: (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
  }) => Effect.Effect<void, OpenCodeClientError>;
  readonly listProjects: Effect.Effect<
    ReadonlyArray<{ readonly directory: string; readonly id: string; readonly name: string }>,
    OpenCodeClientError
  >;
  readonly listWorktrees: (input: {
    readonly projectDirectory: string;
  }) => Effect.Effect<ReadonlyArray<{ readonly workspaceDirectory: string }>, OpenCodeClientError>;
  readonly listSessionTree: (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
  }) => Effect.Effect<ReadonlyArray<string>, OpenCodeClientError>;
  readonly createWorktree: (input: {
    readonly branch: string;
    readonly projectDirectory: string;
  }) => Effect.Effect<{ readonly workspaceDirectory: string }, OpenCodeClientError>;
  readonly removeWorktree: (input: {
    readonly projectDirectory: string;
    readonly workspaceDirectory: string;
  }) => Effect.Effect<void, OpenCodeClientError>;
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
  readonly waitUntilIdle: <E>(input: {
    readonly sessionId: string;
    readonly onEvent?: (
      event: Event,
      opencodeSessionIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, E>;
    readonly requireStart?: boolean;
    readonly workspaceDirectory: string;
  }) => Effect.Effect<void, OpenCodeClientError>;
  readonly listPendingPermissions: (input: {
    readonly workspaceDirectory: string;
    readonly sessionId: string;
    readonly sessionIds?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<PermissionRequest>, OpenCodeClientError>;
  readonly listPendingQuestions: (input: {
    readonly workspaceDirectory: string;
    readonly sessionId: string;
    readonly sessionIds?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<QuestionRequest>, OpenCodeClientError>;
  readonly replyPermission: (input: {
    readonly requestId: string;
    readonly reply: "once" | "always" | "reject";
    readonly workspaceDirectory: string;
  }) => Effect.Effect<void, OpenCodeClientError>;
  readonly replyQuestion: (input: {
    readonly answers: ReadonlyArray<ReadonlyArray<string>>;
    readonly requestId: string;
    readonly workspaceDirectory: string;
  }) => Effect.Effect<void, OpenCodeClientError>;
};

export class OpenCodeClient extends Context.Service<OpenCodeClient, OpenCodeClientService>()(
  "opencode-event-bridge/opencode/client/OpenCodeClient",
) {}

export type OpenCodeFetch = typeof fetch;

type OpenCodeSdkResult<A> = Promise<
  | { readonly data: A; readonly error?: undefined }
  | { readonly data?: undefined; readonly error: unknown }
>;

const resultData = <A>(run: (signal: AbortSignal) => OpenCodeSdkResult<A>) =>
  Effect.tryPromise({
    catch: (cause) =>
      OpenCodeClientError.make({ detail: detailFrom(cause), reason: "RequestFailed" }),
    try: run,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.error !== undefined) {
        return OpenCodeClientError.make({
          detail: detailFrom(result.error),
          reason: "RequestFailed",
        });
      }

      if (result.data === undefined) {
        return OpenCodeClientError.make({ reason: "InvalidResponse" });
      }

      return Effect.succeed(result.data);
    }),
  );

const resultVoid = (
  run: (
    signal: AbortSignal,
  ) => Promise<
    | { readonly data: void; readonly error?: undefined }
    | { readonly data?: undefined; readonly error: unknown }
  >,
) =>
  Effect.tryPromise({
    catch: (cause) =>
      OpenCodeClientError.make({ detail: detailFrom(cause), reason: "RequestFailed" }),
    try: run,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.error !== undefined) {
        return OpenCodeClientError.make({
          detail: detailFrom(result.error),
          reason: "RequestFailed",
        });
      }

      return Effect.void;
    }),
  );

const fetchVoid = (run: (signal: AbortSignal) => Promise<Response>) =>
  Effect.tryPromise({
    catch: (cause) =>
      OpenCodeClientError.make({ detail: detailFrom(cause), reason: "RequestFailed" }),
    try: run,
  }).pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.void;
      }

      return Effect.tryPromise({
        catch: (cause) =>
          OpenCodeClientError.make({ detail: detailFrom(cause), reason: "RequestFailed" }),
        try: () => response.text(),
      }).pipe(
        Effect.flatMap((detail) => OpenCodeClientError.make({ detail, reason: "RequestFailed" })),
      );
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

const sessionIsActive = (
  status: { readonly [key: string]: { readonly type: string } },
  sessionId: string,
) => {
  const item = status[sessionId];
  return item !== undefined && item.type !== "idle";
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

const permissionAskedEvent = (permission: PermissionRequest): Event => ({
  id: permission.id,
  properties: permission,
  type: "permission.asked",
});

const questionAskedEvent = (question: QuestionRequest): Event => ({
  id: question.id,
  properties: question,
  type: "question.asked",
});

const eventIsIdle = (event: Event, sessionId: string) =>
  (event.type === "session.idle" && event.properties.sessionID === sessionId) ||
  (event.type === "session.status" &&
    event.properties.sessionID === sessionId &&
    event.properties.status.type === "idle");

const eventStartsSession = (event: Event, sessionIds: ReadonlySet<string>) => {
  const sessionId = eventSessionId(event);
  return sessionId !== undefined && sessionIds.has(sessionId) && !eventIsIdle(event, sessionId);
};

const eventWaitsForInput = (event: Event, sessionIds: ReadonlySet<string>) =>
  (event.type === "permission.asked" || event.type === "question.asked") &&
  sessionIds.has(event.properties.sessionID);

const eventSessionError = (event: Event, sessionIds: ReadonlySet<string>) => {
  if (event.type !== "session.error") {
    return undefined;
  }

  const sessionId = event.properties.sessionID;
  if (sessionId === undefined || !sessionIds.has(sessionId)) {
    return undefined;
  }

  return detailFrom(event.properties.error);
};

const waitMillis = 250;
const maxWaitMillis = 10 * 60 * 1_000;
const maxWorktreeReadyMillis = 60_000;

const basename = (path: string) => {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
};

export const pathBasename = basename;

export const makeOpenCodeClient = (options: {
  readonly baseUrl?: string;
  readonly fetch: OpenCodeFetch;
}) => {
  const baseUrl = options.baseUrl ?? openCodePrivateBaseUrl;
  const client = createOpencodeClient({ baseUrl, fetch: options.fetch });

  const sessionMessages = (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
  }) =>
    resultData((signal) =>
      client.session.messages(
        {
          directory: input.workspaceDirectory,
          sessionID: input.sessionId,
        },
        { signal },
      ),
    );

  const waitForWorkspace = (
    directory: string,
    started?: number,
  ): Effect.Effect<void, OpenCodeClientError> =>
    Effect.gen(function* () {
      const startedAt = started ?? (yield* Clock.currentTimeMillis);
      return yield* resultData((signal) => client.session.status({ directory }, { signal })).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (now - startedAt > maxWorktreeReadyMillis) {
              return yield* OpenCodeClientError.make({
                detail: error.detail,
                reason: "Timeout",
              });
            }

            yield* Effect.sleep(waitMillis);
            return yield* waitForWorkspace(directory, startedAt);
          }),
        ),
      );
    });

  const listSessionTree = (input: {
    readonly sessionId: string;
    readonly workspaceDirectory: string;
  }): Effect.Effect<ReadonlyArray<string>, OpenCodeClientError> => {
    const seen = new Set<string>();

    const collect = (sessionId: string): Effect.Effect<void, OpenCodeClientError> =>
      Effect.gen(function* () {
        if (seen.has(sessionId)) {
          return;
        }

        seen.add(sessionId);
        const children = yield* resultData((signal) =>
          client.session.children(
            {
              directory: input.workspaceDirectory,
              sessionID: sessionId,
            },
            { signal },
          ),
        );

        yield* Effect.all(
          children.map((child) => collect(child.id)),
          { discard: true },
        );
      });

    return collect(input.sessionId).pipe(Effect.map(() => [...seen]));
  };

  return OpenCodeClient.of({
    abortSession: (input) => {
      const url = new URL(`/session/${encodeURIComponent(input.sessionId)}/abort`, baseUrl);
      url.searchParams.set("directory", input.workspaceDirectory);

      return fetchVoid((signal) =>
        options.fetch(url, {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
          signal,
        }),
      );
    },
    completedResponse: (input) =>
      sessionMessages(input).pipe(
        Effect.flatMap((messages) => {
          const body = responseBody(messages);

          if (body !== undefined) {
            return Effect.succeed({ body });
          }

          return OpenCodeClientError.make({ reason: "InvalidResponse" });
        }),
      ),
    waitUntilIdle: (input) =>
      Effect.gen(function* () {
        const tracked = new Set<string>([input.sessionId]);
        const seenPending = new Set<string>();
        let runStarted = input.requireStart !== true;

        const sessionIds = () => [...tracked];
        const refreshSessionTree = listSessionTree(input).pipe(
          Effect.map((ids) => {
            for (const id of ids) {
              tracked.add(id);
            }
          }),
        );
        const emitEvent = (event: Event) => {
          if (input.onEvent === undefined) {
            return Effect.void;
          }

          return input.onEvent(event, sessionIds()).pipe(
            Effect.mapError((cause) =>
              OpenCodeClientError.make({
                detail: detailFrom(cause),
                reason: "RequestFailed",
              }),
            ),
          );
        };
        const handleEvent = (event: Event) =>
          Effect.gen(function* () {
            if (
              event.type === "session.created" &&
              event.properties.info.parentID !== undefined &&
              tracked.has(event.properties.info.parentID)
            ) {
              tracked.add(event.properties.sessionID);
            }

            const sessionId = eventSessionId(event);
            if (sessionId !== undefined && !tracked.has(sessionId)) {
              return false;
            }

            if (eventStartsSession(event, tracked)) {
              runStarted = true;
            }

            const detail = eventSessionError(event, tracked);
            if (detail !== undefined) {
              return yield* OpenCodeClientError.make({ detail, reason: "SessionError" });
            }

            yield* emitEvent(event);

            if (eventWaitsForInput(event, tracked)) {
              return yield* OpenCodeClientError.make({ reason: "InputPending" });
            }

            return false;
          });
        const emitPending = Effect.gen(function* () {
          const permissions = yield* resultData((signal) =>
            client.permission.list({ directory: input.workspaceDirectory }, { signal }),
          );
          const permissionEvents = permissions
            .filter(
              (permission) =>
                tracked.has(permission.sessionID) &&
                !seenPending.has(`permission:${permission.id}`),
            )
            .map((permission) => ({
              event: permissionAskedEvent(permission),
              key: `permission:${permission.id}`,
            }));

          for (const permission of permissionEvents) {
            yield* handleEvent(permission.event);
            seenPending.add(permission.key);
          }

          const questions = yield* resultData((signal) =>
            client.question.list({ directory: input.workspaceDirectory }, { signal }),
          );
          const questionEvents = questions
            .filter(
              (question) =>
                tracked.has(question.sessionID) && !seenPending.has(`question:${question.id}`),
            )
            .map((question) => ({
              event: questionAskedEvent(question),
              key: `question:${question.id}`,
            }));

          for (const question of questionEvents) {
            yield* handleEvent(question.event);
            seenPending.add(question.key);
          }

          return (
            permissions.some((permission) => tracked.has(permission.sessionID)) ||
            questions.some((question) => tracked.has(question.sessionID))
          );
        });
        const poll = (startedAt: number): Effect.Effect<void, OpenCodeClientError> =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (now - startedAt > maxWaitMillis) {
              return yield* OpenCodeClientError.make({ reason: "Timeout" });
            }

            yield* refreshSessionTree;
            const hasPending = yield* emitPending;
            if (hasPending) {
              return yield* OpenCodeClientError.make({ reason: "InputPending" });
            }

            const status = yield* resultData((signal) =>
              client.session.status({ directory: input.workspaceDirectory }, { signal }),
            );
            if (sessionIds().some((id) => sessionIsActive(status, id))) {
              runStarted = true;
            }

            if (runStarted && sessionIds().every((id) => sessionIsIdle(status, id))) {
              return undefined;
            }

            yield* Effect.sleep(waitMillis);
            return yield* poll(startedAt);
          });
        const eventLoop: Effect.Effect<void, OpenCodeClientError> = Effect.gen(function* () {
          const events = yield* Effect.tryPromise({
            catch: (cause) =>
              OpenCodeClientError.make({ detail: detailFrom(cause), reason: "RequestFailed" }),
            try: (signal) =>
              client.event.subscribe({ directory: input.workspaceDirectory }, { signal }),
          });
          const iterator = events.stream[Symbol.asyncIterator]();

          const loop: Effect.Effect<void, OpenCodeClientError> = Effect.gen(function* () {
            const next = yield* Effect.tryPromise({
              catch: (cause) =>
                OpenCodeClientError.make({ detail: detailFrom(cause), reason: "RequestFailed" }),
              try: () => iterator.next(),
            });

            if (next.done === true) {
              return yield* Effect.never;
            }

            yield* handleEvent(next.value);
            return yield* loop;
          });

          return yield* loop;
        });

        yield* refreshSessionTree;
        const initialStatus = yield* resultData((signal) =>
          client.session.status({ directory: input.workspaceDirectory }, { signal }),
        );
        if (sessionIds().some((id) => sessionIsActive(initialStatus, id))) {
          runStarted = true;
        }

        if (
          input.requireStart !== true &&
          sessionIds().every((id) => sessionIsIdle(initialStatus, id))
        ) {
          return;
        }

        const startedAt = yield* Clock.currentTimeMillis;
        yield* Effect.raceFirst(eventLoop, poll(startedAt));
      }),
    createSession: (input) =>
      resultData((signal) =>
        client.session.create(
          {
            directory: input.workspaceDirectory,
            title: input.title,
          },
          { signal },
        ),
      ).pipe(Effect.map((session) => ({ id: session.id }))),
    createWorktree: (input) =>
      resultData((signal) =>
        client.worktree.create(
          {
            directory: input.projectDirectory,
            worktreeCreateInput: { name: input.branch },
          },
          { signal },
        ),
      ).pipe(
        Effect.flatMap((worktree) =>
          waitForWorkspace(worktree.directory).pipe(
            Effect.as({ workspaceDirectory: worktree.directory }),
          ),
        ),
      ),
    listProjects: resultData((signal) => client.project.list(undefined, { signal })).pipe(
      Effect.map((projects) =>
        projects.map((project) => ({
          directory: project.worktree,
          id: project.id,
          name: project.name ?? basename(project.worktree),
        })),
      ),
    ),
    listWorktrees: (input) =>
      resultData((signal) =>
        client.worktree.list({ directory: input.projectDirectory }, { signal }),
      ).pipe(
        Effect.map((worktrees) => worktrees.map((workspaceDirectory) => ({ workspaceDirectory }))),
      ),
    listSessionTree,
    removeWorktree: (input) =>
      resultData((signal) =>
        client.worktree.remove(
          {
            directory: input.projectDirectory,
            worktreeRemoveInput: { directory: input.workspaceDirectory },
          },
          { signal },
        ),
      ).pipe(Effect.asVoid),
    promptAsync: (input) =>
      resultVoid((signal) =>
        client.session.promptAsync(
          {
            agent: "build",
            directory: input.workspaceDirectory,
            parts: [{ text: input.body, type: "text" }],
            sessionID: input.sessionId,
          },
          { signal },
        ),
      ),
    listPendingPermissions: (input) =>
      resultData((signal) =>
        client.permission.list({ directory: input.workspaceDirectory }, { signal }),
      ).pipe(
        Effect.map((permissions) => {
          const ids = input.sessionIds ?? [input.sessionId];
          return permissions.filter((permission) => ids.includes(permission.sessionID));
        }),
      ),
    listPendingQuestions: (input) =>
      resultData((signal) =>
        client.question.list({ directory: input.workspaceDirectory }, { signal }),
      ).pipe(
        Effect.map((questions) => {
          const ids = input.sessionIds ?? [input.sessionId];
          return questions.filter((question) => ids.includes(question.sessionID));
        }),
      ),
    replyPermission: (input) =>
      resultData((signal) =>
        client.permission.reply(
          {
            directory: input.workspaceDirectory,
            reply: input.reply,
            requestID: input.requestId,
          },
          { signal },
        ),
      ).pipe(Effect.asVoid),
    replyQuestion: (input) =>
      resultData((signal) =>
        client.question.reply(
          {
            answers: input.answers.map((answer) => [...answer]),
            directory: input.workspaceDirectory,
            requestID: input.requestId,
          },
          { signal },
        ),
      ).pipe(Effect.asVoid),
  });
};
