# opencode-event-bridge

Linear webhook bridge deployed with Alchemy on Cloudflare Workers.

## Terminology

- Project directory: the base repository directory OpenCode serves and uses to create worktrees.
- Workspace directory: the per-Linear-issue git worktree directory where an OpenCode session runs.
- Project label: the Linear issue label that selects the OpenCode project for a new run.
- Issue workspace: the OpenCode worktree and branch shared by all runs on one Linear issue.

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

Current implementation plan:

```text
plans/v2-linear-opencode-agent-parity.md
```
