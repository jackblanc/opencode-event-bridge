# V2 Linear OpenCode Agent Parity Plan

## Goal

Bring the useful V1 Linear <> OpenCode agent behaviors into V2 without copying V1's architecture or duplicated state.

V2 should remain small, typed, Worker-native, well tested, and extensible.

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
  - repo selection replies
- Add issue cleanup for Linear `Issue` update events:
  - completed/canceled issues abort active OpenCode sessions
  - remove issue worktree only after session abort succeeds
  - delete related persisted state after cleanup succeeds
- Add stop signal handling:
  - Linear agent activity `signal: "stop"` aborts OpenCode session
  - post `Stopped.`
- Add agent mode selection:
  - derive `plan` or `build` from Linear issue state
  - pass mode to OpenCode prompts
  - prepend a small mode directive to created-session prompts
- Add repo selection:
  - missing/invalid/unmatched repo label creates Linear elicitation
  - exact project label/name/repo label reply starts session
  - selected repo label is written back to Linear when allowed

### Optional Follow-Up

- Auto move unstarted issues to first started workflow state.
- Add small stage activities:
  - starting OpenCode
  - workspace ready
  - prompt sent
- Add richer tool/action progress if Linear UX needs it.

## State

Persist only domain state needed for continuation, cleanup, and human interaction.

```ts
type IssueRun = {
  readonly organizationId: string;
  readonly linearIssueId: string;
  readonly projectDirectory: string;
  readonly workspaceDirectory: string;
  readonly branchName: string;
  readonly sessions: readonly SessionRef[];
};

type SessionRef = {
  readonly linearAgentSessionId: string;
  readonly opencodeSessionId: string;
};

type PendingInteraction =
  | {
      readonly type: "permission";
      readonly linearAgentSessionId: string;
      readonly opencodeRequestId: string;
      readonly workspaceDirectory: string;
    }
  | {
      readonly type: "question";
      readonly linearAgentSessionId: string;
      readonly opencodeRequestId: string;
      readonly workspaceDirectory: string;
      readonly questions: readonly Question[];
      readonly answers: readonly (readonly string[] | null)[];
    }
  | {
      readonly type: "repo-selection";
      readonly linearAgentSessionId: string;
      readonly linearIssueId: string;
      readonly options: readonly RepoSelectionOption[];
      readonly promptContext: string;
    };
```

Indexes:

- `linear:{org}:issue:{issue}:run`
- `linear:{org}:agent-session:{session}`
- `linear:{org}:pending:{session}`

Avoid adding an OpenCode-session index unless OpenCode event handling cannot carry Linear context through observer run records.

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
  - add permission, question, and repo-selection reply handling
- `src/opencode/events/process.ts`
  - add OpenCode event to Linear activity/update processing
- `src/opencode/client.ts`
  - add permission reply, question reply, question list if needed, abort, remove worktree, prompt agent mode
- `src/linear/client/client.ts`
  - add Linear operations for elicitation, plan update, issue state, repo label write, issue sessions if needed
- `src/linear/session/store.ts`
  - replace current records with issue run, agent session, and pending interaction ADTs

## Execution

1. Add state schemas and store methods for issue run, agent session, and pending interaction.
2. Extend OpenCode client with abort, remove worktree, permission reply, question reply, question list, and prompt agent mode.
3. Extend Linear client with elicitation, plan update, issue state, repo label write, issue session lookup, and external URL update.
4. Add repo selection flow before session startup.
5. Add permission/question pending interaction flows.
6. Add stop signal handling.
7. Add issue cleanup processor and route `Issue` webhooks to it.
8. Add OpenCode event processor used by the run observer.
9. Update tests around each semantic behavior.
10. Run `pnpm run check`.

## Validation

- Unit tests:
  - created session with valid repo label creates/reuses worktree and prompts OpenCode
  - prompted session continues existing OpenCode session
  - missing repo label creates repo-selection pending interaction
  - repo-selection reply starts session and clears pending interaction
  - permission request posts Linear elicitation and stores pending interaction
  - permission reply calls OpenCode and clears pending interaction
  - question request posts Linear elicitation and stores pending interaction
  - multi-question replies are collected before OpenCode reply
  - stop signal aborts OpenCode and posts `Stopped.`
  - issue completed/canceled aborts sessions and removes worktree only after abort success
  - OpenCode todo update updates Linear plan
  - OpenCode session error posts Linear error
- Gate:
  - `pnpm run check`

## Open Questions

- OpenCode event processor placement:
  - Durable Object observer: keeps V2 Worker-native and central; requires observer records to carry enough Linear context.
  - OpenCode plugin: closer to V1 behavior; reintroduces separate runtime surface.
- Repo selection scope:
  - Exact matching only: simplest and predictable.
  - Fuzzy matching: nicer UX but more code and ambiguity.
- Auto In Progress:
  - Config flag: useful workflow automation with clear opt-in.
  - Omit for now: smaller core bridge.
