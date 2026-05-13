# Agent Notes

## Commands

- Use Bun only: `bun install`, `bun run ...`.
- Baseline gate: `bun run check`.
- Auto-fix: `bun run lint:fix`, `bun run format:fix`.

## Local References

- Effect v4 source: `~/oss/effect-smol`.
- Alchemy source: `~/oss/alchemy`.
- Read dependency source/docs before guessing behavior.

## Code Conventions

- No `any`, type assertions, or non-null assertions.
- Parse external inputs at boundaries; keep illegal states unrepresentable.
- Prefer small, direct functions until reuse is real.
