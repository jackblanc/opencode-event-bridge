import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LinearOrgAuthStoreError, makeLinearOrgAuthStore } from "../../src/linear/oauth/auth.ts";
import { LinearOrgAuthRecord } from "../../src/linear/oauth/schema.ts";

const record = {
  accessToken: "old-access-token",
  accessTokenExpiresAt: 1,
  appUserId: "app-user-id",
  organizationId: "org-id",
  organizationName: "Example",
  refreshToken: "old-refresh-token",
};
const encodedRecord = Schema.encodeSync(Schema.fromJsonString(LinearOrgAuthRecord))(record);

const makeKv = (value: string | null) => {
  const writes: Array<{ readonly key: string; readonly value: string }> = [];

  return {
    kv: {
      get: () => Effect.succeed(value),
      put: (key: string, next: string) =>
        Effect.sync(() => {
          writes.push({ key, value: next });
        }).pipe(Effect.asVoid),
    },
    writes,
  };
};

describe("LinearOrgAuthStore", () => {
  it.effect("refreshes expired org auth and stores the refreshed record", () =>
    Effect.gen(function* () {
      const kv = makeKv(encodedRecord);
      const store = makeLinearOrgAuthStore({
        kv: kv.kv,
        refresh: (current) =>
          Effect.succeed({
            ...current,
            accessToken: "new-access-token",
            accessTokenExpiresAt: 3_600_000,
            refreshToken: "new-refresh-token",
          }),
      });

      const result = yield* store.getOrgAuth({ organizationId: "org-id" });

      expect(result.accessToken).toBe("new-access-token");
      expect(kv.writes).toEqual([
        {
          key: "org-id",
          value: yield* Schema.encodeEffect(Schema.fromJsonString(LinearOrgAuthRecord))({
            ...record,
            accessToken: "new-access-token",
            accessTokenExpiresAt: 3_600_000,
            refreshToken: "new-refresh-token",
          }),
        },
      ]);
    }),
  );

  it.effect("surfaces refresh failures without overwriting stored auth", () =>
    Effect.gen(function* () {
      const kv = makeKv(encodedRecord);
      const store = makeLinearOrgAuthStore({
        kv: kv.kv,
        refresh: () => Effect.fail("refresh failed"),
      });

      const error = yield* store.getOrgAuth({ organizationId: "org-id" }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LinearOrgAuthStoreError);
      expect(error.reason).toBe("RefreshFailure");
      expect(kv.writes).toEqual([]);
    }),
  );
});
