# OpenCode Event Bridge

This context describes the bridge between Linear agent interactions and OpenCode runs.

## Language

**OpenCode Run**:
An OpenCode session executing work for one Linear agent session.
_Avoid_: job, task

**Run Observer**:
A Durable Object that watches OpenCode events for one OpenCode run and reports relevant activity to Linear.
_Avoid_: plugin, streamer

**Semantic Event**:
An OpenCode event that changes what Linear users need to know or answer.
_Avoid_: progress event, stream event

**Pending OpenCode Input**:
A bridge-owned interaction that collects Linear user replies needed to answer one OpenCode permission or question request.
_Avoid_: pending state, prompt state

**Session Locator**:
A bridge-owned pointer from a Linear agent session to the OpenCode project, session, and workspace that continue it.
_Avoid_: run state, session state

**Project Label**:
A Linear issue label that selects the OpenCode project for a new run.
_Avoid_: repo label, repository label

**Issue Workspace**:
The OpenCode worktree and branch used for all OpenCode runs on one Linear issue.
_Avoid_: session workspace

**Linear Agent Session**:
A Linear conversation thread between a user and the agent for a specific issue.
_Avoid_: chat, Linear session

## Relationships

- A **Linear Agent Session** starts or continues one **OpenCode Run**
- A **Run Observer** watches exactly one active **OpenCode Run**
- A **Run Observer** reports only **Semantic Events**
- An **OpenCode Run** reports progress and prompts back to its **Linear Agent Session**
- A **Pending OpenCode Input** exists only while Linear replies must be aggregated before OpenCode can continue
- A **Project Label** selects the OpenCode project for a new **OpenCode Run**
- A **Session Locator** exists for each **Linear Agent Session** that has started an **OpenCode Run**
- An **Issue Workspace** is shared by all **OpenCode Runs** for one Linear issue

## Example dialogue

> **Dev:** "When OpenCode asks for permission, does the plugin post to Linear?"
> **Domain expert:** "No. The **Run Observer** sees the OpenCode event and posts an elicitation to the **Linear Agent Session**."

## Flagged ambiguities

- "repo label" was used for labels that select OpenCode projects, but no remote repository is queried — resolved: use **Project Label**.
- "event processing" can mean Linear webhook processing or OpenCode event processing; use **Run Observer** for the OpenCode side.
