# Agent Notes

## Commands

- Use pnpm only: `pnpm install`, `pnpm run ...`.
- Baseline gate: `pnpm run check`.
- Auto-fix: `pnpm run lint:fix`, `pnpm run format:fix`.

## Dependency Patches

- Create dependency patches with pnpm's patch workflow:
- Step 1: run `pnpm patch <pkg>@<version>`.
- Step 2: edit the temporary patch directory printed by pnpm and test locally.
- Step 3: run `pnpm patch-commit <patchDir>` to generate `patches/*.patch` and update package metadata.
- Do not hand-edit package patches.

## Triage

- For deployed Worker failures, check runtime logs first with Wrangler (`pnpm exec wrangler tail <worker>`) and reproduce against the deployed URL while tailing. Do not infer production failures from local code alone.

## Local References

- Effect v4 source: `~/oss/effect-smol` (https://github.com/effect-ts/effect-smol)
- Alchemy source: `~/oss/alchemy-effect` (https://github.com/alchemy-run/alchemy-effect)
- Read dependency source/docs before guessing behavior.

## Code Conventions

- No `any`, type assertions, or non-null assertions.
- Parse external inputs at boundaries; keep illegal states unrepresentable.
- Prefer small, direct functions until reuse is real.
- Use `HttpApiBuilder.handle` by default. Use `handleRaw` only when raw request bytes are required, such as signature verification.
- Put Effect Schema structs/codecs in dedicated schema modules, not Worker route files.
- Do not hard-code deployed Worker URLs. Derive public callback URLs from the runtime request URL unless an explicit config value is required.
- Before using platform primitives directly, check Effect/Alchemy APIs first. Prefer Effect HTTP Client for outbound HTTP and Effect Random for generated values.
- Keep OAuth/session state minimal. Store only values required for validation or later execution.
