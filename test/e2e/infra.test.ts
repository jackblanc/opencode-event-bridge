import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";

import Stack from "../../alchemy.run.ts";

const stage = process.env["STAGE"] ?? "test";

const { afterAll, beforeAll, deploy, destroy, test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage,
});

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!process.env["CI"])(destroy(Stack), { timeout: 300_000 });

test(
  "deploys the Linear ingress Worker",
  Effect.gen(function* () {
    const url = yield* stack;

    expect(url).toBeTypeOf("string");
    expect(url).toMatch(/^https:\/\//);
  }),
);
