# opencode-event-bridge

Linear webhook bridge deployed with Alchemy on Cloudflare Workers.

## Terminology

- Project directory: the base repository directory OpenCode serves and uses to create worktrees.
- Workspace directory: the per-Linear-issue git worktree directory where an OpenCode session runs.

Install dependencies:

```bash
pnpm install
```

Run checks:

```bash
pnpm run check
```

Deploy with Alchemy:

```bash
pnpm exec alchemy deploy
```

Provision CI secrets with the admin profile:

```bash
pnpm run provision:github
```
