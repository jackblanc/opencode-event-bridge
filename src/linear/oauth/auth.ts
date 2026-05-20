import { Context, Effect, Schema } from "effect";

import { LinearOrgAuthRecord } from "./schema.ts";

type LinearOrgAuthRecord = Schema.Schema.Type<typeof LinearOrgAuthRecord>;

export type LinearOrgAuthStoreKv<R = never> = {
  readonly get: (key: string) => Effect.Effect<string | null, unknown, R>;
};

export type LinearOrgAuthStoreService = {
  readonly getOrgAuth: (input: {
    readonly organizationId: string;
  }) => Effect.Effect<LinearOrgAuthRecord, LinearOrgAuthStoreError>;
};

export class LinearOrgAuthStore extends Context.Service<
  LinearOrgAuthStore,
  LinearOrgAuthStoreService
>()("app/LinearOrgAuthStore") {}

class LinearOrgAuthStoreError extends Schema.TaggedErrorClass<LinearOrgAuthStoreError>()(
  "LinearOrgAuthStoreError",
  {
    reason: Schema.Literals(["InvalidRecord", "MissingOrganizationAuth", "StoreFailure"]),
  },
) {}

export const makeLinearOrgAuthStore = (kv: LinearOrgAuthStoreKv) =>
  LinearOrgAuthStore.of({
    getOrgAuth: (input) =>
      Effect.gen(function* () {
        const value = yield* kv
          .get(input.organizationId)
          .pipe(Effect.mapError(() => new LinearOrgAuthStoreError({ reason: "StoreFailure" })));

        if (value === null) {
          return yield* new LinearOrgAuthStoreError({ reason: "MissingOrganizationAuth" });
        }

        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LinearOrgAuthRecord))(
          value,
        ).pipe(Effect.mapError(() => new LinearOrgAuthStoreError({ reason: "InvalidRecord" })));
      }),
  });
