import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LinearIssueWorktreeKey = Schema.TemplateLiteral([
  "linear:",
  Schema.String.check(Schema.isMinLength(1)),
  ":issue:",
  Schema.String.check(Schema.isMinLength(1)),
  ":worktree",
]);

export const LinearAgentSessionKey = Schema.TemplateLiteral([
  "linear:",
  Schema.String.check(Schema.isMinLength(1)),
  ":agent-session:",
  Schema.String.check(Schema.isMinLength(1)),
]);

export type LinearIssueWorktreeKey = Schema.Schema.Type<typeof LinearIssueWorktreeKey>;
export type LinearAgentSessionKey = Schema.Schema.Type<typeof LinearAgentSessionKey>;

export const LinearIssueWorktreeRecord = Schema.Struct({
  linearIssueId: Schema.String,
  opencodeWorkspaceDirectory: Schema.String,
  organizationId: Schema.String,
});

export const LinearAgentSessionRecord = Schema.Struct({
  linearAgentSessionId: Schema.String,
  linearIssueId: Schema.String,
  opencodeWorkspaceDirectory: Schema.String,
  opencodeSessionId: Schema.String,
  organizationId: Schema.String,
});

export type LinearIssueWorktreeRecord = Schema.Schema.Type<typeof LinearIssueWorktreeRecord>;
export type LinearAgentSessionRecord = Schema.Schema.Type<typeof LinearAgentSessionRecord>;

export type LinearSessionStoreKv<R = never> = {
  readonly get: (
    key: LinearIssueWorktreeKey | LinearAgentSessionKey,
  ) => Effect.Effect<string | null, unknown, R>;
  readonly put: (
    key: LinearIssueWorktreeKey | LinearAgentSessionKey,
    value: string,
  ) => Effect.Effect<void, unknown, R>;
};

export type LinearSessionStoreService = {
  readonly getIssueWorktree: (input: {
    readonly organizationId: string;
    readonly linearIssueId: string;
  }) => Effect.Effect<LinearIssueWorktreeRecord | null, LinearSessionStoreError>;
  readonly putIssueWorktree: (
    record: LinearIssueWorktreeRecord,
  ) => Effect.Effect<void, LinearSessionStoreError>;
  readonly getAgentSession: (input: {
    readonly organizationId: string;
    readonly linearAgentSessionId: string;
  }) => Effect.Effect<LinearAgentSessionRecord | null, LinearSessionStoreError>;
  readonly putAgentSession: (
    record: LinearAgentSessionRecord,
  ) => Effect.Effect<void, LinearSessionStoreError>;
};

export class LinearSessionStore extends Context.Service<
  LinearSessionStore,
  LinearSessionStoreService
>()("app/LinearSessionStore") {}

export class LinearSessionStoreError extends Schema.TaggedErrorClass<LinearSessionStoreError>()(
  "LinearSessionStoreError",
  {
    cause: Schema.optional(Schema.Defect),
    key: Schema.optional(Schema.String),
    reason: Schema.Literals(["InvalidRecord", "MissingAgentSession", "StoreFailure"]),
  },
) {}

export const issueWorktreeKey = (input: {
  readonly organizationId: string;
  readonly linearIssueId: string;
}): LinearIssueWorktreeKey =>
  `linear:${input.organizationId}:issue:${input.linearIssueId}:worktree`;

export const agentSessionKey = (input: {
  readonly organizationId: string;
  readonly linearAgentSessionId: string;
}): LinearAgentSessionKey =>
  `linear:${input.organizationId}:agent-session:${input.linearAgentSessionId}`;

const getIssueWorktreeRecord = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly key: LinearIssueWorktreeKey;
}) =>
  Effect.gen(function* () {
    const value = yield* input.kv
      .get(input.key)
      .pipe(
        Effect.mapError(
          (cause) => new LinearSessionStoreError({ cause, key: input.key, reason: "StoreFailure" }),
        ),
      );

    if (value === null) {
      return null;
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LinearIssueWorktreeRecord))(
      value,
    ).pipe(
      Effect.mapError(
        (cause) => new LinearSessionStoreError({ cause, key: input.key, reason: "InvalidRecord" }),
      ),
    );
  });

const getAgentSessionRecord = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly key: LinearAgentSessionKey;
}) =>
  Effect.gen(function* () {
    const value = yield* input.kv
      .get(input.key)
      .pipe(
        Effect.mapError(
          (cause) => new LinearSessionStoreError({ cause, key: input.key, reason: "StoreFailure" }),
        ),
      );

    if (value === null) {
      return null;
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LinearAgentSessionRecord))(
      value,
    ).pipe(
      Effect.mapError(
        (cause) => new LinearSessionStoreError({ cause, key: input.key, reason: "InvalidRecord" }),
      ),
    );
  });

const putIssueWorktreeRecord = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly key: LinearIssueWorktreeKey;
  readonly record: LinearIssueWorktreeRecord;
}) =>
  Schema.encodeEffect(Schema.fromJsonString(LinearIssueWorktreeRecord))(input.record).pipe(
    Effect.mapError(
      (cause) => new LinearSessionStoreError({ cause, key: input.key, reason: "InvalidRecord" }),
    ),
    Effect.flatMap((value) =>
      input.kv
        .put(input.key, value)
        .pipe(
          Effect.mapError(
            (cause) =>
              new LinearSessionStoreError({ cause, key: input.key, reason: "StoreFailure" }),
          ),
        ),
    ),
  );

const putAgentSessionRecord = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly key: LinearAgentSessionKey;
  readonly record: LinearAgentSessionRecord;
}) =>
  Schema.encodeEffect(Schema.fromJsonString(LinearAgentSessionRecord))(input.record).pipe(
    Effect.mapError(
      (cause) => new LinearSessionStoreError({ cause, key: input.key, reason: "InvalidRecord" }),
    ),
    Effect.flatMap((value) =>
      input.kv
        .put(input.key, value)
        .pipe(
          Effect.mapError(
            (cause) =>
              new LinearSessionStoreError({ cause, key: input.key, reason: "StoreFailure" }),
          ),
        ),
    ),
  );

const getIssueWorktree = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly organizationId: string;
  readonly linearIssueId: string;
}) =>
  getIssueWorktreeRecord({
    key: issueWorktreeKey(input),
    kv: input.kv,
  });

const putIssueWorktree = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly record: LinearIssueWorktreeRecord;
}) =>
  putIssueWorktreeRecord({
    key: issueWorktreeKey(input.record),
    kv: input.kv,
    record: input.record,
  });

const getAgentSession = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly organizationId: string;
  readonly linearAgentSessionId: string;
}) =>
  getAgentSessionRecord({
    key: agentSessionKey(input),
    kv: input.kv,
  });

const putAgentSession = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly record: LinearAgentSessionRecord;
}) =>
  putAgentSessionRecord({
    key: agentSessionKey(input.record),
    kv: input.kv,
    record: input.record,
  });

export const makeLinearSessionStore = (kv: LinearSessionStoreKv) =>
  LinearSessionStore.of({
    getAgentSession: (input) => getAgentSession({ ...input, kv }),
    getIssueWorktree: (input) => getIssueWorktree({ ...input, kv }),
    putAgentSession: (record) => putAgentSession({ kv, record }),
    putIssueWorktree: (record) => putIssueWorktree({ kv, record }),
  });
