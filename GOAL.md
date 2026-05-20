# Goal

`opencode-event-bridge` is a Cloudflare-hosted bridge between Linear Agent Sessions and OpenCode.

It replaces `~/projects/opencode-linear-agent` with a new implementation that:

- Runs on Cloudflare.
- Is provisioned with Alchemy.
- Is written with Effect TypeScript.
- Talks to OpenCode over HTTP/SSE instead of an OpenCode plugin.
- Reaches OpenCode through the project's tunnel/VPC setup.

The target is a complete MVP user journey, not feature parity with v1.

## Product Shape

- Linear is the user-facing surface.
- OpenCode is the execution engine.
- The bridge translates Linear Agent Session work into OpenCode work and sends the result back to Linear.
- Cloudflare owns the deployed runtime and durable workflow state.
- Alchemy owns infrastructure provisioning.
- Effect owns application composition, typed services, schemas, and errors.

## Architecture

The bridge should be structured around a small domain workflow with infrastructure adapters around it.

- Cloudflare hosts the deployed app and any stateful runtime needed to continue work after webhook receipt.
- Alchemy provisions Cloudflare resources, bindings, and deployment configuration.
- Effect owns workflow composition, dependency injection, typed errors, schemas, and boundary parsing.
- Linear integration is an adapter for OAuth install, webhook receipt and verification, Agent Activities, and issue metadata.
- OpenCode integration is an adapter for HTTP/SSE communication with the latest OpenCode API.
- Durable state is an adapter for the minimum records needed to continue Linear/OpenCode sessions.
- OpenCode is reached from Cloudflare through the tunnel/VPC path.
- Active OpenCode SSE ownership should use Durable Objects first. If Worker runtime limits make that impractical, use a Cloudflare Container.

The workflow should not depend on Alchemy resource definitions, Cloudflare request handlers, OpenCode plugin state, or OpenCode filesystem access.

### OpenCode Runtime Access

The current default path is Workers VPC to a locally running OpenCode server. The VPC Service owns the private routing target; Cloudflare Tunnel public ingress is not part of the Worker-to-OpenCode path.

Local OpenCode must not be exposed through a public hostname. If Workers VPC cannot reach the local loopback listener directly, use a local-only private address or proxy target instead of a public tunnel.

Cloudflare Containers are a candidate for reproducible execution, but they require an explicit workspace materialization strategy. OpenCode's remote workspace sync handles session/event state between OpenCode instances; it does not by itself sync local repository files or uncommitted working tree changes into a container.

## Critical User Journeys

### Install

An admin installs the Linear app. The bridge stores what it needs to receive Linear webhooks and post Agent Activities back to that Linear organization.

### Start Work

A user delegates an issue to the agent or mentions the agent in Linear.

The bridge receives the Linear Agent Session webhook, verifies it, accepts it quickly, and posts a small acknowledgement so the user knows the agent is working.

### Pick The Repository

The bridge determines which OpenCode project should handle the issue.

The MVP signal is a Linear issue label using the existing `repo:*` convention. If the repository is missing or unclear, the bridge posts a clear error activity. Repository selection elicitations are deferred.

### Run OpenCode

The bridge creates or reuses the OpenCode workspace needed for the Linear issue, creates or reuses the OpenCode session needed for the Linear Agent Session, and sends the Linear prompt/context to OpenCode.

The MVP uses build-style OpenCode execution and does not support interactive question or permission flows.

### Show Progress

The bridge tells Linear that OpenCode is processing and links to the OpenCode session when a useful URL is available.

The MVP does not mirror every OpenCode event into Linear.

### Deliver Result

When OpenCode completes, the bridge posts the final assistant response back to the Linear Agent Session.

If the bridge cannot continue, it posts a clear Linear error activity instead of failing silently.

## Phase 1 Done Means

- Linear install works.
- Linear delegation or mention reaches the deployed Cloudflare app.
- Webhook verification works.
- The bridge acknowledges accepted work quickly.
- Repository routing works from `repo:*` labels.
- Missing or unclear repository routing posts a useful Linear error activity.
- OpenCode work starts in the right project/workspace.
- Follow-up prompts in the same Linear Agent Session continue the same OpenCode session.
- Linear gets a processing update with an OpenCode link when available.
- Linear gets the final OpenCode assistant response.
- Linear gets a useful error activity when the bridge cannot proceed.
- `pnpm run check` passes.

## State

Keep only the state required to continue the journeys above:

- Linear organization auth.
- Linear issue to OpenCode workspace/project association.
- Linear Agent Session to OpenCode session association.
- Pending repository selection is deferred until repository selection elicitations are implemented.

Use Cloudflare stateful primitives.

## Boundaries

- Keep Cloudflare and Alchemy at infrastructure boundaries where practical.
- Keep workflow logic in Effect services.
- Parse external inputs at boundaries.
- Target the latest OpenCode API and verify exact API shapes from current source/docs during implementation.
- Detect OpenCode completion from the latest available OpenCode API. Current API exposes completed assistant messages, not a `session.completed` event.
- Do not couple the bridge to the OpenCode server filesystem or plugin runtime.

## Out Of Scope For Phase 1

- Full v1 feature parity.
- OpenCode plugin integration.
- Local webhook server or tunnel as the production architecture.
- Streaming every OpenCode thought, tool, todo, or stage update into Linear.
- Linear plan updates.
- Interactive OpenCode question handling.
- Permission approval flow.
- Repository selection and general elicitation.
- Automatic Linear issue status transitions.
- Cleanup when issues complete or cancel.
- Migration of old v1 file state.
- Broad fuzzy repository matching.

## Later Direction

After Phase 1 works end to end, likely improvements include:

- Linear-native question and permission flows.
- Richer but still low-noise progress updates.
- Better repository selection.
- Cleanup for completed, canceled, or stale work.
- E2E coverage with fake Linear and fake OpenCode servers.
