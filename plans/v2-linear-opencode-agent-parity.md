# V2 Linear OpenCode Agent Parity Plan

## Goal

Bring the V1 Linear <> OpenCode agent behaviors listed in this plan into V2 without copying V1's architecture or duplicated state.

V2 should remain small, typed, Worker-native, well tested, and extensible.

## Acceptance Standard

This is a new project with zero users. Do not leave tech debt behind.

- Make breaking changes when they produce the clean design.
- Delete obsolete code, obsolete tests, stale docs, and redundant state.
- Do not preserve backwards compatibility.
- Do not add migration paths.
- Do not leave TODOs, temporary shims, pass-through abstractions, or deferred cleanup.
- Before calling the work complete, inspect the finished implementation for shortcuts and fix them.

## Scope

### Required

- Add OpenCode event processing that posts meaningful events back to Linear:
  - final assistant responses
  - session errors
  - todo/plan updates
  - permission requests
  - question requests
- Add pending interaction handling for Linear prompted events:
  - permission replies
  - question replies
  - project selection replies
- Add issue cleanup for Linear `Issue` update events:
  - completed/canceled issues abort active OpenCode sessions
  - remove issue worktree only after session abort succeeds
  - delete related persisted state after cleanup succeeds
- Add stop signal handling:
  - Linear agent activity `signal: "stop"` aborts OpenCode session
  - post `Stopped.`
- Add agent mode:
  - always use OpenCode `build`
- Add project selection:
  - missing/invalid/unmatched project label creates Linear elicitation
  - exact OpenCode project label/name/project label reply starts session
  - selected project label is written back to Linear
  - if Linear rejects label mutation with authorization/permission failure, startup continues and Linear receives a warning response
- Add session continuation:
  - store a minimal Session Locator when an OpenCode session is created
  - prompted events for an existing Linear agent session use the Session Locator before reading issue labels
  - project labels only affect new Linear agent sessions

### Out Of Scope

- Auto move unstarted issues to first started workflow state.
- Add richer tool/action progress if Linear UX needs it.
- Duplicate webhook/event idempotency defenses.

## State

Prefer Linear and OpenCode as sources of truth. Persist only bridge-owned locators and interaction aggregation.

```ts
type SessionLocator = {
  readonly linearAgentSessionId: string;
  readonly opencodeSessionId: string;
  readonly projectDirectory: string;
  readonly workspaceDirectory: string;
};

type PendingOpenCodeInput =
  | {
      readonly type: "permission";
      readonly linearAgentSessionId: string;
      readonly opencodeRequestId: string;
      readonly opencodeSessionId: string;
    }
  | {
      readonly type: "question";
      readonly linearAgentSessionId: string;
      readonly opencodeRequestId: string;
      readonly opencodeSessionId: string;
      readonly questions: readonly Question[];
      readonly answers: readonly (readonly string[] | null)[];
    };
```

Rules:

- Linear issue labels identify the OpenCode project for new sessions.
- Linear issue agent sessions identify sessions to clean up when an issue is completed or canceled.
- One OpenCode worktree and branch are shared per Linear issue.
- OpenCode pending permission/question lists identify active requests for prompted events that do not already have Pending OpenCode Input.
- Durable Object observer storage stores exactly the active observation pointer needed by the alarm:
  - `organizationId`
  - `linearAgentSessionId`
  - `opencodeSessionId`
  - `projectDirectory`
  - `workspaceDirectory`

Persisted indexes:

- `linear:{org}:agent-session:{session}` for **Session Locator**.
- `linear:{org}:pending:{session}` for **Pending OpenCode Input** only.

## Code Locations

- `src/linear/webhook/receive.ts`
  - keep as signature verification, payload decode, enqueue only
- `src/linear/webhook/payload.ts`
  - add schemas for stop signal, issue cleanup fields, and interaction payload fields
- `src/linear/session/process.ts`
  - keep AgentSessionEvent orchestration
  - route pending interactions before normal prompt handling
- `src/linear/issue/process.ts`
  - add issue cleanup processor
- `src/linear/interaction/process.ts`
  - add permission, question, and project-selection reply handling
- `src/opencode/events/process.ts`
  - add OpenCode event to Linear activity/update processing
- `src/opencode/client.ts`
  - add project/worktree list, permission reply, question reply, permission/question list, abort, remove worktree, build prompt
- `src/linear/client/client.ts`
  - add Linear operations for elicitation, plan update, project label write, issue agent sessions, and external URL update
- `src/linear/session/store.ts`
  - replace current records with Session Locator and Pending OpenCode Input ADTs

## Behavior Rules

### Project Selection

- Existing Linear agent session:
  - load Session Locator by `linear:{org}:agent-session:{session}`
  - if found, continue that OpenCode session and do not inspect project labels
  - if missing, process as a new session
- New Linear agent session:
  - list OpenCode projects
  - read Linear issue labels
  - derive candidate project labels from plain label name, `repo:*` suffix, and grouped `repo` child labels
  - normalize candidates and OpenCode project names/basenames with trim + lowercase
  - if exactly one OpenCode project matches, create/reuse the Issue Workspace and create an OpenCode session
  - if zero or more than one OpenCode project matches, post one project-selection elicitation and do not create an OpenCode session
- Project-selection reply:
  - match the reply exactly to an OpenCode project name or project directory basename after trim + lowercase
  - create/reuse the Issue Workspace and create an OpenCode session
  - attempt to add `repo:{projectDirectoryBasename}` to the Linear issue
  - on label-write permission failure, post a warning response and continue startup

### Pending OpenCode Input

- Permission request:
  - Run Observer posts one Linear elicitation with choices `Approve`, `Approve Always`, `Reject`
  - store Pending OpenCode Input of type `permission`
  - prompted reply maps `Approve` -> `once`, `Approve Always` -> `always`, `Reject` -> `reject`
  - after OpenCode accepts the permission reply, delete Pending OpenCode Input
- Question request:
  - Run Observer posts exactly one Linear elicitation for the first unanswered question
  - store Pending OpenCode Input of type `question` with all OpenCode questions and null answers
  - each prompted reply fills the next null answer
  - after each partial answer, post the next unanswered question as one Linear elicitation
  - when all answers are present, send one OpenCode question reply with all answers in order
  - after OpenCode accepts the question reply, delete Pending OpenCode Input
- Prompted event ordering:
  - handle Pending OpenCode Input first
  - then query OpenCode pending permission/question lists
  - then treat the prompt as a normal OpenCode follow-up

### Run Observer Semantic Events

- Observe OpenCode events in the Durable Object Run Observer.
- For `todo.updated`, update Linear agent session plan.
  - map OpenCode `pending` -> Linear `pending`
  - map OpenCode `in_progress` -> Linear `inProgress`
  - map OpenCode `completed` -> Linear `completed`
  - map OpenCode `cancelled` -> Linear `canceled`
  - map unknown todo statuses to Linear `pending`
- For `session.error`, post Linear error activity.
- For `permission.asked`, create Pending OpenCode Input and post permission elicitation.
- For `question.asked`, create Pending OpenCode Input and post the first question elicitation.
- For final assistant response:
  - wait until OpenCode session status is idle
  - fetch session messages
  - select the latest completed assistant message
  - concatenate its text parts in order
  - post one Linear response activity
- Do not post OpenCode reasoning, tool progress, shell progress, or non-final text deltas.

### Issue Workspace

- Branch name is the lowercase Linear issue identifier.
- One Issue Workspace exists per Linear issue and OpenCode project.
- Reuse an existing OpenCode worktree when its branch/name matches the expected issue branch.
- Create a worktree only when no matching worktree exists.

### Cleanup

- On Linear `Issue` update where `data.state.type` is `completed` or `canceled`:
  - load all Linear agent session ids for the issue from Linear
  - load Session Locator for each session id
  - abort every located OpenCode session
  - if any abort fails, stop cleanup and keep all locators
  - collect unique `(projectDirectory, workspaceDirectory)` pairs
  - remove every collected worktree
  - after all removals succeed, delete the loaded Session Locators and Pending OpenCode Inputs for those sessions

## Execution

1. Add state schemas and store methods for Session Locator and Pending OpenCode Input.
2. Extend OpenCode client with project/worktree list, abort, remove worktree, permission reply, question reply, permission/question list, and build prompt.
3. Extend Linear client with elicitation, plan update, project label write, issue session lookup, and external URL update.
4. Add project selection flow before session startup.
5. Add permission/question pending interaction flows.
6. Add stop signal handling.
7. Add issue cleanup processor and route `Issue` webhooks to it.
8. Add OpenCode event processor used by the run observer.
9. Update tests around each semantic behavior.
10. Run `pnpm run check`.

## Validation

- Unit tests:
  - created session with valid project label creates/reuses issue workspace and prompts OpenCode
  - prompted session continues existing OpenCode session
  - prompted session ignores changed project labels when Session Locator exists
  - missing project label creates project-selection elicitation
  - plain project label, `repo:*` label, and grouped parent `repo` label all match OpenCode projects
  - ambiguous project labels create project-selection elicitation
  - project-selection reply starts session and writes project label
  - project-selection reply continues startup and posts warning when project label write is forbidden
  - permission request posts Linear elicitation and stores pending interaction
  - permission reply calls OpenCode and clears pending interaction
  - question request posts Linear elicitation and stores pending interaction
  - multi-question replies are collected before OpenCode reply
  - stop signal aborts OpenCode and posts `Stopped.`
  - issue completed/canceled aborts sessions and removes worktree only after abort success
  - cleanup loads Linear issue agent sessions, then Session Locators, then unique worktrees
  - OpenCode todo update updates Linear plan
  - OpenCode session error posts Linear error
- Gate:
  - `pnpm run check`
- Local/deployed E2E:
  - confirm `opencode serve --hostname 127.0.0.1 --port 4096` is reachable at `/project`
  - confirm Cloudflare tunnel/VPC path is running
  - deploy stack with `pnpm exec alchemy deploy`
  - install or verify Linear OAuth app auth for the workspace
  - ensure Linear webhook URL points to deployed `/api/webhook/linear`
  - create a Linear issue in team `CODE` with label `repo:opencode-event-bridge`
  - trigger the installed bridge agent on that issue
  - verify Linear receives acknowledgement, OpenCode link, and final response
  - trigger a follow-up prompt and verify it continues the same OpenCode session
  - trigger OpenCode permission and question flows and verify Linear replies unblock OpenCode
  - send Linear stop signal and verify OpenCode aborts plus Linear receives `Stopped.`
  - move the issue to `Done` or a canceled status and verify cleanup aborts sessions and removes worktree

## Operational Preconditions

- Alchemy/Cloudflare credentials are available for deploy.
- Alchemy secrets are set before deploy: `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`.
- Local OpenCode is running and reachable from the Worker through the tunnel/VPC route.
- The Linear app is installed in the target workspace through `/api/oauth/authorize` before E2E begins.
- The installed bridge agent is triggerable from team `CODE`.
- The Linear label `repo:opencode-event-bridge` exists in team `CODE`.
- The OpenCode server lists a project whose name or directory basename is `opencode-event-bridge`.

If an operational precondition is false, implementation continues through automated unit/integration tests, then E2E validation is blocked with the missing precondition named explicitly.

## Decisions

- Project label matching:
  - Match Linear labels to OpenCode projects listed by the OpenCode API.
  - Candidate label values come from:
    - plain label name, for example `opencode-event-bridge`
    - `repo:*` label suffix, for example `repo:opencode-event-bridge` -> `opencode-event-bridge`
    - grouped Linear label child name when parent is `repo`
  - Candidate label values must equal an OpenCode project name or project directory basename after trim + lowercase normalization.
  - More than one matched OpenCode project for an issue creates project-selection elicitation.
  - Zero matched OpenCode projects for an issue creates project-selection elicitation.
  - Do not query remote repository hosts directly.
- OpenCode event processing:
  - Use the Durable Object Run Observer, not an OpenCode plugin.
  - Report only Semantic Events to Linear.
- Agent mode:
  - Always use OpenCode `build`.
- State:
  - Keep KV state minimal: Session Locator and Pending OpenCode Input only.
  - Do not add idempotency defenses for duplicate Linear/OpenCode events.
- Issue workspace:
  - Use one worktree and branch per Linear issue.
- Auto In Progress:
  - Omit for now.
