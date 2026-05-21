---
name: opencode-linear-cuj
description: Use when validating the OpenCode Event Bridge Linear-to-OpenCode critical user journey, especially prompt_async handoff, Durable Object observation, KV state, OpenCode session state, and Linear final response delivery.
---

# OpenCode Linear CUJ

Use this skill to execute or reason about the critical user journey for `opencode-event-bridge`.

## Intent

Validate the production-shaped flow without building a fragile full E2E suite:

1. Linear agent session event reaches the bridge.
2. Queue worker records session/worktree state and calls OpenCode `prompt_async`.
3. Queue worker exits after dispatch; it does not wait for OpenCode completion.
4. Durable Object observes the OpenCode run independently.
5. Observer posts one final response back to Linear.
6. Observer terminates permanently on any terminal state.

## Key Semantics

- `prompt_async` means dispatch only. A successful HTTP response means OpenCode accepted the prompt for background execution, not that the prompt completed.
- Async prompt failures are OpenCode runtime events, usually `session.error`, and are observed by the Durable Object, not by the queue worker.
- The queue worker should fail only for dispatch-time failures: OpenCode unavailable, invalid session, bad request, or request rejected before OpenCode forks the prompt.
- The observer owns run completion, terminal error handling, final Linear response delivery, and cleanup.
- Any terminal state must clear the DO alarm and stored run record forever.

## Manual CUJ Procedure

1. Start from a clean local state or record current KV keys.
2. Ensure a reachable OpenCode server is running for the target workspace.
3. Create a test Linear issue with the developer/OAuth token for the Agent app.
4. Delegate the issue to the agent, or construct the exact Linear webhook payload if delegation cannot be triggered locally.
5. Deliver the event through the same bridge entrypoint used by deployed traffic when possible.
6. Confirm queue processing returns quickly after `prompt_async` dispatch.
7. Confirm KV contains the Linear agent session to OpenCode session/workdir mapping.
8. Confirm OpenCode live server has the session and user prompt.
9. Wait for OpenCode to become idle or emit `session.error`.
10. Confirm Linear receives exactly one terminal activity: final response on success, error activity on terminal failure.
11. Confirm observer storage and alarm are cleared after terminal handling.

## Required Assertions

- KV has a record keyed by Linear organization/session that includes `opencodeSessionId` and `opencodeWorkspaceDirectory`.
- OpenCode session exists in the expected workspace directory.
- OpenCode has the dispatched user prompt.
- On success, the posted Linear response is derived from the completed assistant message after the prompt boundary.
- Previous assistant messages are not reposted.
- On `session.error`, the observer posts or records terminal failure and does not retry forever.
- On timeout, missing session, missing workspace, or unrecoverable invalid response, the observer terminates instead of looping forever.
- DO alarm is deleted after terminal handling.
- DO run record is deleted after terminal handling.

## OpenCode References

- OpenCode `prompt_async` handler: `~/oss/opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- OpenCode session status semantics: `~/oss/opencode/packages/opencode/src/session/status.ts`
- OpenCode CLI wait strategy: `~/oss/opencode/packages/opencode/src/cli/cmd/run/stream.transport.ts`

## Bridge References

- Queue processing: `src/linear/session/process.ts`
- OpenCode SDK client: `src/opencode/client.ts`
- Durable Object observer: `src/opencode/run-observer.ts`
- Worker wiring: `src/workers/linear-webhook-processor.ts`

## Review Checklist

- Do not make queue processing wait for OpenCode completion.
- Track a prompt boundary before dispatch so final response selection cannot reuse an old assistant message.
- Prefer OpenCode SDK messages for final response text; do not parse provider metadata.
- Prefer status polling plus event subscription for idle detection because event streams can miss status events.
- Model terminal states explicitly instead of swallowing every observer failure as transient.
- Keep the CUJ executable manually first; automate only stable, deterministic seams.
