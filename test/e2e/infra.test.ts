import assert from "node:assert/strict";

import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import Stack from "../../alchemy.run.ts";

const configuration = Effect.runSync(
  Effect.gen(function* () {
    return {
      ci: yield* Config.boolean("CI").pipe(Config.withDefault(false)),
      stage: yield* Config.string("STAGE").pipe(Config.withDefault("test")),
    };
  }),
);

const { afterAll, beforeAll, deploy, destroy, test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: configuration.stage,
});

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(configuration.ci !== true)(destroy(Stack), { timeout: 300_000 });

test(
  "deploys the Linear ingress Worker",
  Effect.gen(function* () {
    const url = yield* stack;

    assert.ok(url !== undefined);
    assert.match(url, /^https:\/\//);
  }),
);
