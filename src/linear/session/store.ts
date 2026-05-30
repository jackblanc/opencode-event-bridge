import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LinearAgentSessionKey = Schema.TemplateLiteral([
  "linear:",
  Schema.String.check(Schema.isMinLength(1)),
  ":agent-session:",
  Schema.String.check(Schema.isMinLength(1)),
]);

export const LinearPendingInputKey = Schema.TemplateLiteral([
  "linear:",
  Schema.String.check(Schema.isMinLength(1)),
  ":pending:",
  Schema.String.check(Schema.isMinLength(1)),
]);

export type LinearAgentSessionKey = Schema.Schema.Type<typeof LinearAgentSessionKey>;
export type LinearPendingInputKey = Schema.Schema.Type<typeof LinearPendingInputKey>;

const QuestionOption = Schema.Struct({
  description: Schema.String,
  label: Schema.String,
});

export const Question = Schema.Struct({
  custom: Schema.optional(Schema.Boolean),
  header: Schema.String,
  multiple: Schema.optional(Schema.Boolean),
  options: Schema.Array(QuestionOption),
  question: Schema.String,
});

export const SessionLocator = Schema.Struct({
  linearAgentSessionId: Schema.String,
  opencodeSessionId: Schema.String,
  projectDirectory: Schema.String,
  workspaceDirectory: Schema.String,
});

export const PendingOpenCodeInput = Schema.Union([
  Schema.Struct({
    linearAgentSessionId: Schema.String,
    promptContext: Schema.String,
    type: Schema.Literal("projectSelection"),
  }),
  Schema.Struct({
    linearAgentSessionId: Schema.String,
    opencodeRequestId: Schema.String,
    opencodeSessionId: Schema.String,
    type: Schema.Literal("permission"),
  }),
  Schema.Struct({
    answers: Schema.Array(Schema.NullOr(Schema.Array(Schema.String))),
    linearAgentSessionId: Schema.String,
    opencodeRequestId: Schema.String,
    opencodeSessionId: Schema.String,
    questions: Schema.Array(Question),
    type: Schema.Literal("question"),
  }),
]);

export type Question = Schema.Schema.Type<typeof Question>;
export type SessionLocator = Schema.Schema.Type<typeof SessionLocator>;
export type PendingOpenCodeInput = Schema.Schema.Type<typeof PendingOpenCodeInput>;

export type LinearSessionStoreKv<R = never> = {
  readonly delete: (
    key: LinearAgentSessionKey | LinearPendingInputKey,
  ) => Effect.Effect<void, unknown, R>;
  readonly get: (
    key: LinearAgentSessionKey | LinearPendingInputKey,
  ) => Effect.Effect<string | null, unknown, R>;
  readonly put: (
    key: LinearAgentSessionKey | LinearPendingInputKey,
    value: string,
  ) => Effect.Effect<void, unknown, R>;
};

export type LinearSessionStoreService = {
  readonly deletePendingInput: (input: {
    readonly organizationId: string;
    readonly linearAgentSessionId: string;
  }) => Effect.Effect<void, LinearSessionStoreError>;
  readonly deleteSessionLocator: (input: {
    readonly organizationId: string;
    readonly linearAgentSessionId: string;
  }) => Effect.Effect<void, LinearSessionStoreError>;
  readonly getPendingInput: (input: {
    readonly organizationId: string;
    readonly linearAgentSessionId: string;
  }) => Effect.Effect<PendingOpenCodeInput | null, LinearSessionStoreError>;
  readonly getSessionLocator: (input: {
    readonly organizationId: string;
    readonly linearAgentSessionId: string;
  }) => Effect.Effect<SessionLocator | null, LinearSessionStoreError>;
  readonly putPendingInput: (input: {
    readonly organizationId: string;
    readonly pending: PendingOpenCodeInput;
  }) => Effect.Effect<void, LinearSessionStoreError>;
  readonly putSessionLocator: (input: {
    readonly organizationId: string;
    readonly locator: SessionLocator;
  }) => Effect.Effect<void, LinearSessionStoreError>;
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

export const agentSessionKey = (input: {
  readonly organizationId: string;
  readonly linearAgentSessionId: string;
}): LinearAgentSessionKey =>
  `linear:${input.organizationId}:agent-session:${input.linearAgentSessionId}`;

export const pendingInputKey = (input: {
  readonly organizationId: string;
  readonly linearAgentSessionId: string;
}): LinearPendingInputKey => `linear:${input.organizationId}:pending:${input.linearAgentSessionId}`;

const getRecord = <R, S extends Schema.Top>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly key: LinearAgentSessionKey | LinearPendingInputKey;
  readonly schema: S;
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

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(input.schema))(value).pipe(
      Effect.mapError(
        (cause) => new LinearSessionStoreError({ cause, key: input.key, reason: "InvalidRecord" }),
      ),
    );
  });

const putRecord = <R, S extends Schema.Top>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly key: LinearAgentSessionKey | LinearPendingInputKey;
  readonly record: Schema.Schema.Type<S>;
  readonly schema: S;
}) =>
  Schema.encodeEffect(Schema.fromJsonString(input.schema))(input.record).pipe(
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

const deleteRecord = <R>(input: {
  readonly kv: LinearSessionStoreKv<R>;
  readonly key: LinearAgentSessionKey | LinearPendingInputKey;
}) =>
  input.kv
    .delete(input.key)
    .pipe(
      Effect.mapError(
        (cause) => new LinearSessionStoreError({ cause, key: input.key, reason: "StoreFailure" }),
      ),
    );

export const makeLinearSessionStore = (kv: LinearSessionStoreKv) =>
  LinearSessionStore.of({
    deletePendingInput: (input) => deleteRecord({ key: pendingInputKey(input), kv }),
    deleteSessionLocator: (input) => deleteRecord({ key: agentSessionKey(input), kv }),
    getPendingInput: (input) =>
      getRecord({ key: pendingInputKey(input), kv, schema: PendingOpenCodeInput }),
    getSessionLocator: (input) =>
      getRecord({ key: agentSessionKey(input), kv, schema: SessionLocator }),
    putPendingInput: (input) =>
      putRecord({
        key: pendingInputKey({
          linearAgentSessionId: input.pending.linearAgentSessionId,
          organizationId: input.organizationId,
        }),
        kv,
        record: input.pending,
        schema: PendingOpenCodeInput,
      }),
    putSessionLocator: (input) =>
      putRecord({
        key: agentSessionKey({
          linearAgentSessionId: input.locator.linearAgentSessionId,
          organizationId: input.organizationId,
        }),
        kv,
        record: input.locator,
        schema: SessionLocator,
      }),
  });
