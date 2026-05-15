# opencode-event-bridge

Linear webhook bridge deployed with Alchemy on Cloudflare Workers.

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
