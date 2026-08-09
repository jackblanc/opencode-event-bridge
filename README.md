# OpenCode Event Bridge

Linear agent bridge for OpenCode. Runs Linear ingress on Cloudflare Workers and sends work to a local `opencode serve`.

Cloudflare owns ingress, queueing, OAuth/session KV, and private connectivity to OpenCode.

## How It Works

- Linear sends webhooks to the public Worker at `/api/webhook/linear`.
- The ingress Worker verifies the Linear signature and queues the payload.
- The processor Worker loads Linear OAuth/session state from KV.
- The processor reaches local OpenCode through a Cloudflare Tunnel-backed VPC service.
- A Run Observer Durable Object watches OpenCode events and posts semantic updates back to Linear.

## Requirements

- Cloudflare account with Workers, KV, Queues, Durable Objects, Tunnel, and VPC service access.
- Cloudflare API token that can deploy those resources.
- `cloudflared` installed on the machine running OpenCode.
- Linear workspace admin access.
- Linear Agents API access. The Linear Agents API is in Developer Preview and may change.
- OpenCode installed locally.
- `pnpm`.

## Linear App

Create an app at:

```text
https://linear.app/settings/api/applications/new
```

Configure:

- Redirect URI: `https://<worker-host>/api/oauth/callback`
- Webhook URL: `https://<worker-host>/api/webhook/linear`
- Scopes: `write`, `app:mentionable`, `app:assignable`
- Webhook events: `AgentSessionEvent`, `Issue`

The Worker hostname is printed after deploy. If Linear requires values before deploy, use a temporary placeholder and update after deploy.

Save:

- OAuth client ID
- OAuth client secret
- Webhook secret

## Configure

Copy env:

```bash
cp .env.example .env
```

Set:

```bash
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
LINEAR_OAUTH_CLIENT_ID=
LINEAR_OAUTH_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
LINEAR_ALLOWED_ORGANIZATION_ID=
```

Only this Linear organization can install or use the deployed bridge.

Optional GitHub secret provisioning:

```bash
GITHUB_OWNER=
GITHUB_REPOSITORY_NAME=opencode-event-bridge
```

Install:

```bash
pnpm install
```

## Deploy

Deployment options:

- Clone this repo, set `.env`, and deploy from your machine with `pnpm run deploy:dev` or `pnpm run deploy:prod`.
- Fork this repo if you want GitHub Actions deploys. Set repository secrets manually, or run the GitHub provisioning stack below from a trusted admin profile.

Deploy dev:

```bash
pnpm run deploy:dev
```

Deploy prod:

```bash
pnpm run deploy:prod
```

The stack returns the public Linear ingress URL. Use that host for the Linear redirect URI and webhook URL.

The stack creates:

- public Linear ingress Worker
- private webhook processor Worker
- Linear webhook queue
- OAuth state KV
- Linear org auth KV
- Linear session KV
- OpenCode Tunnel
- OpenCode VPC service
- Run Observer Durable Object

Worker logs can include Linear webhook payloads, including issue descriptions, comments, prompts, guidance, and previous comments. Deploy into an account whose logs you treat as sensitive.

## Run OpenCode

Start OpenCode on the expected private address:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

OpenCode must know about the projects you want Linear to use. Project labels in Linear match OpenCode project names or directory basenames.

Recommended OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "linear": {
      "type": "remote",
      "url": "https://mcp.linear.app/mcp",
      "enabled": true
    }
  }
}
```

## Connect The Tunnel

After deploy, run the Cloudflare Tunnel connector on the same machine as OpenCode:

```bash
cloudflared tunnel run --token <OpenCodeTunnel token>
```

Get the token from Cloudflare Zero Trust for the tunnel created by the stack, or from local Alchemy state if you manage deploys from this machine.

Keep this process running. Without it, the Worker cannot reach `127.0.0.1:4096`.

## Install In Linear

Open:

```text
https://<worker-host>/api/oauth/authorize
```

Approve the app. The callback stores the Linear org OAuth record in KV.

## Use

1. Create a Linear issue.
2. Add a project label such as `repo:opencode-event-bridge`.
3. Delegate the issue to the Linear app agent.
4. The bridge creates or reuses an OpenCode worktree branch named after the issue identifier, lowercased.
5. Linear receives an OpenCode session link and final responses.

If the issue has no matching project label, the bridge asks you to select an OpenCode project in Linear.

Follow-up prompts continue the same OpenCode session through the stored Session Locator. Project labels only select new sessions.

Completing or canceling an issue aborts active OpenCode sessions, removes related worktrees after abort succeeds, and clears bridge-owned session state.

## Project Labels

These can match OpenCode projects:

- plain label name
- `repo:<name>`
- grouped `repo` child label

Matching is trim + lowercase against the OpenCode project name and project directory basename.

## Verify

Local checks:

```bash
pnpm run check
```

`pnpm run lint` runs type-aware Oxlint with TypeScript and Effect diagnostics.
`pnpm install` patches Oxlint with `@effect/tsgo`; keep the exact
`@effect/tsgo`, `typescript`, `oxlint`, and `oxlint-tsgolint` versions aligned.
TypeScript remains an unpatched, typecheck-only path so Effect diagnostics are
not reported twice.

Infra deploy test:

```bash
pnpm run test:e2e
```

This deploys real Cloudflare resources using the current environment and stage. CI tears down after the test; local runs keep resources/state for inspection and cleanup.

Manual smoke:

```bash
curl http://127.0.0.1:4096/project
```

Then trigger a Linear agent session and confirm Linear receives:

- accepted/start activity
- OpenCode session link
- final assistant response

## CI Secrets

For fork-based deploys, set these repository secrets manually or provision them with an admin Cloudflare profile:

```bash
pnpm run provision:github
```

This creates a least-scoped Cloudflare API token for CI and stores:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `LINEAR_OAUTH_CLIENT_ID`
- `LINEAR_OAUTH_CLIENT_SECRET`
- `LINEAR_WEBHOOK_SECRET`
- `LINEAR_ALLOWED_ORGANIZATION_ID`

GitHub does not pass these secrets to public fork PRs. The e2e deploy test is skipped for fork PRs. Do not switch CI to `pull_request_target`.

Use a GitHub `production` environment with required approval for production deploys.

## Troubleshooting

Webhook 401:

- Check `LINEAR_WEBHOOK_SECRET`.
- Check Linear webhook URL is `/api/webhook/linear`.

OAuth callback fails:

- Check redirect URI is `/api/oauth/callback` on the deployed Worker host.
- Re-open `/api/oauth/authorize`.

OpenCode unreachable:

- Confirm `opencode serve --hostname 127.0.0.1 --port 4096`.
- Confirm `cloudflared tunnel run --token ...` is still running.
- Confirm the deployed VPC service points at `127.0.0.1:4096`.

No project match:

- Check OpenCode lists the project.
- Add a `repo:<project-directory-basename>` label.
- Or answer the Linear project-selection prompt.

## Commands

```bash
pnpm install
pnpm run check
pnpm run deploy:dev
pnpm run deploy:prod
pnpm run provision:github
```
