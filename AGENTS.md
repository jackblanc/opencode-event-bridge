# Agent Notes

This project is an event bridge for OpenCode, an open-source coding agent. It receives events from external sources and sends them to an OpenCode server for processing.

The only event source right now is Linear. In the future, we could add support for other event sources.

This project is an evolution of ~/projects/opencode-linear-agent, but written in Effect TypeScript instead of raw TS.

This project has no users. Do not worry about breaking changes or backwards compatibility, ever. Produce clean, optimal, and maintainable code.

## Commands

- Use pnpm only: `pnpm install`, `pnpm run ...`.
- Baseline gate: `pnpm run check`.
- Auto-fix: `pnpm run lint:fix`, `pnpm run format:fix`.

## Dependency References

Reference the source code of our open source dependencies to understand them. If a user says "read OpenCode" or "check the source code", reference these local repository checkouts.

- Effect v4: `~/oss/effect-smol` (https://github.com/effect-ts/effect-smol)
- Alchemy: `~/oss/alchemy-effect` (https://github.com/alchemy-run/alchemy-effect)
  - distilled (SDKs used by Alchemy): `~/oss/distilled` (https://github.com/alchemy-run/distilled)
- OpenCode: `~/oss/opencode` (https://github.com/anomalyco/opencode)

## Linear Documentation References

Linear provides a robust Agent API for connecting Linear to coding agents.

We do not use Linear's TypeScript SDK directly because it's not very good. But, the SDK is a useful reference. It is cloned to `~/oss/linear`.

To understand the Agent API, read the web documentation:

- [Agent Interaction Guidelines (AIG)](https://linear.app/developers/aig.md)
- [Getting Started](https://linear.app/developers/agents.md)
- [Developing the Agent Interaction](https://linear.app/developers/agent-interaction.md)
- [Interaction Best Practices](https://linear.app/developers/agent-best-practices.md)
- [Signals](https://linear.app/developers/agent-signals.md)

## Dependency Patches

- Create dependency patches with pnpm's patch workflow:
- Step 1: run `pnpm patch <pkg>@<version>`.
- Step 2: edit the temporary patch directory printed by pnpm and test locally.
- Step 3: run `pnpm patch-commit <patchDir>` to generate `patches/*.patch` and update package metadata.
- Do not hand-edit package patches.

## Triage

- For deployed Worker failures, use Cloudflare Observability/query APIs for logs and reproduce against the deployed URL. Do not infer production failures from local code alone.

## Code Conventions

- No `any`, type assertions, or non-null assertions.
- Parse external inputs at boundaries; keep illegal states unrepresentable.
- Prefer small, direct functions until reuse is real.
- Use `HttpApiBuilder.handle` by default. Use `handleRaw` only when raw request bytes are required, such as signature verification.
- Put Effect Schema structs/codecs in dedicated schema modules, not Worker route files.
- Do not hard-code deployed Worker URLs. Derive public callback URLs from the runtime request URL unless an explicit config value is required.
- Before using platform primitives directly, check Effect/Alchemy APIs first. Prefer Effect HTTP Client for outbound HTTP and Effect Random for generated values.
- Keep OAuth/session state minimal. Store only values required for validation or later execution.
