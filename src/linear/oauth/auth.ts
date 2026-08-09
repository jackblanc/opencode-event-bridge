import { Clock, Context, Effect, Schema } from "effect";

import { LinearOrgAuthRecord } from "./schema.ts";

type LinearOrgAuthRecord = typeof LinearOrgAuthRecord.Type;

export type LinearOrgAuthStoreKv<E = never, R = never> = {
  readonly get: (key: string) => Effect.Effect<string | null, E, R>;
  readonly put: (key: string, value: string) => Effect.Effect<void, E, R>;
};

export type LinearOrgAuthRefresh<E = never> = (
  record: LinearOrgAuthRecord,
) => Effect.Effect<LinearOrgAuthRecord, E>;

export type LinearOrgAuthStoreService = {
  readonly getOrgAuth: (input: {
    readonly organizationId: string;
  }) => Effect.Effect<LinearOrgAuthRecord, LinearOrgAuthStoreError>;
};

export class LinearOrgAuthStore extends Context.Service<
  LinearOrgAuthStore,
  LinearOrgAuthStoreService
>()("opencode-event-bridge/linear/oauth/auth/LinearOrgAuthStore") {}

export class LinearOrgAuthStoreError extends Schema.TaggedErrorClass<LinearOrgAuthStoreError>()(
  "LinearOrgAuthStoreError",
  {
    cause: Schema.optional(Schema.Defect()),
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

const readOrgAuth = <E>(input: {
  readonly kv: LinearOrgAuthStoreKv<E>;
  readonly organizationId: string;
}) =>
  Effect.gen(function* () {
    const value = yield* input.kv.get(input.organizationId).pipe(
      Effect.mapError((cause) =>
        LinearOrgAuthStoreError.make({
          cause,
          key: input.organizationId,
          reason: "StoreFailure",
        }),
      ),
    );

    if (value === null) {
      return yield* LinearOrgAuthStoreError.make({ reason: "MissingOrganizationAuth" });
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(LinearOrgAuthRecord))(value).pipe(
      Effect.mapError((cause) =>
        LinearOrgAuthStoreError.make({
          cause,
          key: input.organizationId,
          reason: "InvalidRecord",
        }),
      ),
    );
  });

const putOrgAuth = <E>(input: {
  readonly kv: LinearOrgAuthStoreKv<E>;
  readonly record: LinearOrgAuthRecord;
}) =>
  Schema.encodeEffect(Schema.fromJsonString(LinearOrgAuthRecord))(input.record).pipe(
    Effect.mapError((cause) =>
      LinearOrgAuthStoreError.make({
        cause,
        key: input.record.organizationId,
        reason: "InvalidRecord",
      }),
    ),
    Effect.flatMap((value) =>
      input.kv.put(input.record.organizationId, value).pipe(
        Effect.mapError((cause) =>
          LinearOrgAuthStoreError.make({
            cause,
            key: input.record.organizationId,
            reason: "StoreFailure",
          }),
        ),
      ),
    ),
  );

export const makeLinearOrgAuthStore = <E, RefreshE>(input: {
  readonly kv: LinearOrgAuthStoreKv<E>;
  readonly refresh?: LinearOrgAuthRefresh<RefreshE>;
}) =>
  LinearOrgAuthStore.of({
    getOrgAuth: (getInput) =>
      Effect.gen(function* () {
        const record = yield* readOrgAuth({
          kv: input.kv,
          organizationId: getInput.organizationId,
        });
        const now = yield* Clock.currentTimeMillis;

        if (record.accessTokenExpiresAt > now + expirySkewMillis || input.refresh === undefined) {
          return record;
        }

        const refreshed = yield* input
          .refresh(record)
          .pipe(
            Effect.mapError((cause) =>
              LinearOrgAuthStoreError.make({ cause, reason: "RefreshFailure" }),
            ),
          );
        yield* putOrgAuth({ kv: input.kv, record: refreshed });

        return refreshed;
      }),
  });
