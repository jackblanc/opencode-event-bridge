import { Context, Effect, Schema } from "effect";

import { LinearOrgAuthRecord } from "./schema.ts";

type LinearOrgAuthRecord = Schema.Schema.Type<typeof LinearOrgAuthRecord>;

export type LinearOrgAuthStoreKv<R = never> = {
  readonly get: (key: string) => Effect.Effect<string | null, unknown, R>;
  readonly put: (key: string, value: string) => Effect.Effect<void, unknown, R>;
};

export type LinearOrgAuthRefresh = (
  record: LinearOrgAuthRecord,
) => Effect.Effect<LinearOrgAuthRecord, unknown>;

export type LinearOrgAuthStoreService = {
  readonly getOrgAuth: (input: {
    readonly organizationId: string;
  }) => Effect.Effect<LinearOrgAuthRecord, LinearOrgAuthStoreError>;
};

export class LinearOrgAuthStore extends Context.Service<
  LinearOrgAuthStore,
  LinearOrgAuthStoreService
>()("app/LinearOrgAuthStore") {}

export class LinearOrgAuthStoreError extends Schema.TaggedErrorClass<LinearOrgAuthStoreError>()(
  "LinearOrgAuthStoreError",
  {
    cause: Schema.optional(Schema.Defect),
    key: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "InvalidRecord",
      "MissingOrganizationAuth",
      "RefreshFailure",
      "StoreFailure",
    ]),
  },
) {}

const expirySkewMillis = 60_000;

const readOrgAuth = (input: {
  readonly kv: LinearOrgAuthStoreKv;
  readonly organizationId: string;
}) =>
  Effect.gen(function* () {
    const value = yield* input.kv.get(input.organizationId).pipe(
      Effect.mapError(
        (cause) =>
          new LinearOrgAuthStoreError({
            cause,
            key: input.organizationId,
            reason: "StoreFailure",
          }),
      ),
    );

    if (value === null) {
      return yield* new LinearOrgAuthStoreError({ reason: "MissingOrganizationAuth" });
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LinearOrgAuthRecord))(
      value,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new LinearOrgAuthStoreError({
            cause,
            key: input.organizationId,
            reason: "InvalidRecord",
          }),
      ),
    );
  });

const putOrgAuth = (input: {
  readonly kv: LinearOrgAuthStoreKv;
  readonly record: LinearOrgAuthRecord;
}) =>
  Schema.encodeEffect(Schema.fromJsonString(LinearOrgAuthRecord))(input.record).pipe(
    Effect.mapError(
      (cause) =>
        new LinearOrgAuthStoreError({
          cause,
          key: input.record.organizationId,
          reason: "InvalidRecord",
        }),
    ),
    Effect.flatMap((value) =>
      input.kv.put(input.record.organizationId, value).pipe(
        Effect.mapError(
          (cause) =>
            new LinearOrgAuthStoreError({
              cause,
              key: input.record.organizationId,
              reason: "StoreFailure",
            }),
        ),
      ),
    ),
  );

export const makeLinearOrgAuthStore = (kv: LinearOrgAuthStoreKv, refresh?: LinearOrgAuthRefresh) =>
  LinearOrgAuthStore.of({
    getOrgAuth: (input) =>
      Effect.gen(function* () {
        const record = yield* readOrgAuth({ kv, organizationId: input.organizationId });

        if (record.accessTokenExpiresAt > Date.now() + expirySkewMillis || refresh === undefined) {
          return record;
        }

        const refreshed = yield* refresh(record).pipe(
          Effect.mapError(
            (cause) => new LinearOrgAuthStoreError({ cause, reason: "RefreshFailure" }),
          ),
        );
        yield* putOrgAuth({ kv, record: refreshed });

        return refreshed;
      }),
  });
