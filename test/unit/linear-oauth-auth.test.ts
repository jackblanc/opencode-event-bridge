import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { LinearOrgAuthStoreError, makeLinearOrgAuthStore } from "../../src/linear/oauth/auth.ts";

const record = {
  accessToken: "old-access-token",
  accessTokenExpiresAt: 1,
  appUserId: "app-user-id",
  organizationId: "org-id",
  organizationName: "Example",
  refreshToken: "old-refresh-token",
};

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
  it("refreshes expired org auth and stores the refreshed record", async () => {
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
    const kv = makeKv(JSON.stringify(record));
    const store = makeLinearOrgAuthStore(kv.kv, (current) =>
      Effect.succeed({
        ...current,
        accessToken: "new-access-token",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        refreshToken: "new-refresh-token",
      }),
    );

    const result = await Effect.runPromise(store.getOrgAuth({ organizationId: "org-id" }));

    expect(result.accessToken).toBe("new-access-token");
    expect(kv.writes).toEqual([
      {
        key: "org-id",
        value: JSON.stringify({
          ...record,
          accessToken: "new-access-token",
          accessTokenExpiresAt: Date.now() + 3_600_000,
          refreshToken: "new-refresh-token",
        }),
      },
    ]);
    vi.useRealTimers();
  });

  it("surfaces refresh failures without overwriting stored auth", async () => {
    const kv = makeKv(JSON.stringify(record));
    const store = makeLinearOrgAuthStore(kv.kv, () => Effect.fail("refresh failed"));

    const error = await Effect.runPromise(
      store.getOrgAuth({ organizationId: "org-id" }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LinearOrgAuthStoreError);
    expect(error.reason).toBe("RefreshFailure");
    expect(kv.writes).toEqual([]);
  });
});
