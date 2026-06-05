---
name: linear
description: Use the Linear CLI for issue management, delegation, and project work. Semantic commands capture agent intent and handle state transitions automatically.
---

# Linear CLI Quick Reference

## Token Location (Single Source of Truth)

Linear OAuth tokens live in **one place only**:

```
~/.openclaw/workspace/{agentId}/.secrets/linear.env
```

Exception: the **main** agent has no subdirectory — its token lives at `~/.openclaw/workspace/.secrets/linear.env`. (The `getLinearSecretPath()` helper handles this special case automatically; never compute the path inline.)

Each agent has its own unique token. Tokens must **never** be shared between agents.

The CLI resolves the agent name from `OPENCLAW_MCP_AGENT_ID` or `OPENCLAW_AGENT_NAME` env vars, then loads `LINEAR_OAUTH_TOKEN` from that canonical path.

**When rotating tokens:** update only the file at `~/.openclaw/workspace/{agentId}/.secrets/linear.env` (or `~/.openclaw/workspace/.secrets/linear.env` for main). Do **not** create or update files in `~/.openclaw/workspace-{agentId}/` — those are vestigial profile workspaces and should not contain secrets.

Use `linear doctor` to verify token validity and identity.

## Debugging

- Add `--debug` to any command to dump raw GraphQL errors to stderr when something fails. Useful for diagnosing opaque validation errors.
- Common validation errors and their workarounds:
  - **Self-reference in comment body** → bare ticket ID detected; use em-dashes (—) or spell out the ID
  - **Comment too long** → exceeds max length; split into multiple comments or shorten
  - **Team/label mismatch** → label from wrong team; use a label from the issue's team
  - **Generic Argument Validation Error** → re-run with `--debug` to inspect which field failed

## Core Semantics — Know These

### Assignee vs Delegate
- **Assignee** = human who must act next. Set automatically by `needsHuman` and `complete`. Cleared when an agent takes ownership.
- **Delegate** = agent who owns the ticket. Set by `considerWork` (self) and `handoffWork`/`refuseWork` (another agent). Cleared by `complete` and `needsHuman`.
- **The key insight:** assignee is ONLY set when a human needs to do something. This makes "assigned to me" views in Linear reliable — every ticket there is genuinely waiting on human input.

### Semantic Commands (Agent Standard)

These are the ONLY commands agents should use for workflow state transitions. Every command captures intent and handles multiple API calls atomically.

#### Read Commands

```
linear observe-issue <ID>             # Read issue + last 10 comments (no ownership change)
linear observe-issue <ID> --all       # Read issue + ALL comments
linear observe-issue <ID> --human     # Chronological timeline: creation +
                                      #   comments + state/delegate/assignee/
                                      #   priority change events, each with
                                      #   ISO and relative timestamp.
```

JSON output has `comments[]` and `history[]` sorted ascending by `createdAt` — agents can read sequentially without re-sorting.

Use `observe-issue` when you are @mentioned (not delegated) or doing a board sweep. No state changes.

#### Write Commands

```
linear consider-work <ID>             # Accept delegation: set delegate=self, status=Thinking, clear assignee; rejects Backlog; no-op on Done/Canceled
linear consider-work <ID> --force     # Explicitly override Backlog gate or reopen Done/Canceled issues with a warning
                                      # Returns issue context + last 10 comments
linear begin-work <ID>                # Start active work: status=Doing (idempotent)
linear refuse-work <ID> <agent>       # Decline: status=Todo, delegate to another agent (requires --comment)
linear handoff-work <ID> <agent>      # Hand off: status=Todo, delegate to agent (requires --comment)
linear handoff-work <ID> <agent> --review-handoff --comment "..."
                                      # Peer-review handoff: also applies gate:agent-review label and
                                      # prefixes comment with [Review Handoff]. Fails if the label
                                      # is missing on the target team.
linear complete <ID>                  # Finish: status=Done, clear delegate + assignee (optional --comment)
                                      # Auto-strips gate:agent-review / gate:human-review if present.
linear needs-human <ID> <human>       # Escalate: status=Todo, assignee=human, clear delegate (requires --comment)
linear park <ID>                      # Deprioritize: status=Backlog, clear delegate + assignee (optional --comment)
linear manage <ID>                    # Take stewardship: status=Managing, delegate=self, clear assignee (optional --comment)
linear manage <ID> --interval 2h      # Same, but set per-ticket wake cadence (m/h/d). Default cadence is 30m.
linear undelegate <ID>                # Clear delegate + assignee without changing status (optional --comment)
linear note <ID> --comment "<msg>"    # Post comment only: no state, delegate, or assignee change
                                      # Works on any status (including Done/Canceled)
```

> **Note:** camelCase aliases (`considerWork`, `beginWork`, etc.) still work for backward compatibility but kebab-case is the standard.


### Inline Comment Safety — use `--comment-file` for Markdown/code

Never pass comment bodies containing backticks, code spans, file paths in backticks, fenced code, or non-trivial Markdown via inline `--comment`. Inline comments are parsed by the shell before `linear` receives them, so backticks can be treated as command substitution and silently stripped.

Repro:

```bash
$ echo "removed `personal/expense-tally.md` from the vault"
removed  from the vault
```

Rule: if a Linear comment contains backticks, code, paths, Markdown formatting, multiple paragraphs, or anything you would be sad to see corrupted, write it to a temp file and use `--comment-file <path>`. This applies to `note`, `refuse-work`, `needs-human`, `handoff-work`, and `complete`.

Safe pattern:

```bash
cat > /tmp/linear-comment.md <<'EOF'
Removed `personal/expense-tally.md` from the vault.
EOF
linear handoff-work AI-123 "Charles (CTO)" --comment-file /tmp/linear-comment.md
```

#### Comment Options

All write commands accept `--comment "<msg>"` or `--comment-file <path>` for comments. `refuse-work`, `handoff-work`, and `needs-human` accept an optional comment — if omitted, the command still succeeds but emits a soft stderr warning. `consider-work` and `begin-work` do not accept comments — agents should not comment without a handoff.

> **One comment per turn, maximum.** If you have already posted a substantive comment in the current turn (via `note`, a prior `handoff-work`, etc.), do NOT post a second comment that summarizes or references the first. The comment IS the output. Never follow a substantive comment with a meta-comment like "Analysis posted — see above" or "Investigation complete — handing back for review." If you used `linear note` to post your analysis and now need to hand off, use the handoff command's `--comment` to add only what's genuinely new — or if the note already says everything, keep the handoff comment minimal (one sentence max).

### When to Use Each Command

| Situation | Command |
|---|---|
| You receive a webhook delegation | `consider-work <ID>` |
| You are @mentioned but not delegated | `observe-issue <ID>` |
| You start actively coding/researching | `begin-work <ID>` |
| You're done and passing to another agent | `handoff-work <ID> <agent> --comment "..."` |
| You're done and the ticket is complete | `complete <ID>` |
| You need a human decision/input | `needs-human <ID> <human> --comment "..."` |
| You're the wrong person for this task | `refuse-work <ID> <agent> --comment "..."` |
| Intentionally deprioritizing / parking a ticket | `park <ID>` |
| Owning a parent / externally-blocked ticket (stewardship) | `manage <ID>` |
| Browsing tickets without ownership | `observe-issue <ID>` |
| Adding context to a closed ticket | `note <ID> --comment "..."` |

### Workflow Rules (from AGENTS.md)

1. **All communication goes in the ticket.** Post analysis, findings, updates, deliverables as comments via `--comment` on semantic commands.
2. **Always hand off when your work is done.** Use `handoff-work`, `complete`, or `needs-human`. Never leave a ticket delegated to yourself after completing work.
3. **If it's not your area, give your perspective and delegate back.** Use `handoff-work` or `refuse-work`.
4. **Structural issues get their own tickets.** Don't bury observations as footnotes.
5. **Move tickets forward immediately.** New tickets → delegate to appropriate agent via the semantic commands.
6. **One comment per turn, maximum.** Never post a second comment in the same turn that summarizes or references a comment you just posted. The "Assessment posted — see above" pattern is noise. Pick the right command and put everything in its `--comment`. If the handoff command forces a `--comment` but you already said everything in a `note`, write one sentence max on the handoff comment (e.g., "See prior comment for full analysis.") — don't repeat yourself.

### Closing Rules — Non-Negotiable

6. **The agent who does the work cannot close the ticket.** `complete` must only be called by a reviewer — never by the agent who implemented the work. Once you've done the work, use `handoffWork` or `needsHuman` to pass it to a reviewer. The reviewer calls `complete`.
7. **Do not close a ticket with open flagged issues.** If a reviewer raised an issue in a comment, it must be resolved in one of three ways before `complete` is called:
   - A new ticket was created to track it, OR
   - The original poster confirmed it can be ignored, OR
   - The fix was implemented and confirmed.
   Silence is not resolution. A flagged issue with no explicit response blocks `complete`.

### Managing — Stewardship State

`Managing` is for tickets you own but cannot push forward right now: parent
tickets whose work lives in children, tickets blocked on external state
(deploy, CI, third-party reply), or staged dependencies (B depends on A). It
sits outside `linear queue` / `--next` so it never competes with directly
executable work, but the Linear Connector wakes you on a cadence to re-review.

**Default cadence:** 30 minutes per ticket. Override per-ticket by adding a
line to the description (the `manage` command can write this for you):

```
Managing-interval: 2h
```

Accepted units: `s`, `m`, `h`, `d`. Bare numbers default to minutes.

**Stewardship checklist** (what to do when the connector wakes you):

1. Check subtask state. If a child resolved since your last review, decide
   whether the parent moves forward.
2. Look for stalled children — anything in Backlog that should be To Do?
   Anything assigned to the wrong person?
3. Verify assignee + delegate on each child match the current owner.
4. If something material changed, post a delta-only note on the parent: what
   changed since the last stewardship comment, and where the current
   blocker/owner is now.
5. Do not restate unchanged child status, old blockers, or the whole project
   summary. If the only update would be a recap, post nothing.

Move tickets out of Managing when they're complete (`complete`), abandoned
(`needs-human` / `refuse-work`), or actively workable (`begin-work`). Do not
let Managing become a graveyard.

**Good stewardship comment shape:**

> Since last check: FCY-516 merged and is Done. Current blocker is FCY-514,
> with Noah actively implementing; no action needed on the parent.

Avoid serial recap comments that list every child and repeat unchanged blockers
from prior updates. The reader should learn only the new state transition and
the current bottleneck.

### Comment Verification

**Never read-after-write to verify a comment.** The mutation result is the strongly-consistent source of truth. Trust the `commentId` and `commentUrl` printed on success. If you genuinely need to confirm propagation (rare), use `linear verify-comment <commentId>` — it uses the strongly-consistent node query, not the eventually-consistent connection feed. The `linear comments` / `observe-issue` connection feed can lag by seconds to minutes.

### Deprecated Commands (Human Use Only)

The following commands still work but print deprecation warnings for agents:
- `linear status`, `linear assign`, `linear delegate`, `linear handoff`, `linear comment`

Agents should NOT use these. They bypass the semantic intent model and cause delegate/assignee drift. Use semantic commands instead.

## Navigation & Utility Commands

```
linear queue                         # Issues delegated to you, not yet started (To Do only by default; excludes Backlog/Managing/Thinking/Doing)
linear queue --include-backlog       # Explicitly include parked Backlog issues (still excludes Managing)
linear queue --next                  # Highest-priority not-yet-started issue only
linear queue --blocked               # Blocked issues only
linear managing                      # Tickets you are stewarding (Managing state) — connector wakes you on a cadence to re-review
linear my-issues                     # All issues assigned or delegated to you
linear my-issues --status "To Do"    # Filter by status
linear my-issues --new               # New/unviewed issues
linear board <TEAM>                  # Team board view (active states only — excludes Done/Canceled)
linear recently-done <TEAM>          # Recently completed/canceled tickets in a team (default 2-day window)
linear recently-done <TEAM> --days 7 # Custom lookback window
linear review-queue                  # Items in review state
linear stalled <days>                # Stale tickets
linear parent <ID> <PARENT_ID>       # Set an existing issue as a child/sub-issue
linear unparent <ID>                 # Remove an issue from its parent
linear children <ID>                 # View sub-issues
linear relations <ID>                # View related issues
linear block <ID> --blocked-by <ID>  # Mark as blocking
linear unblock <ID> --blocked-by <ID>  # Remove block
linear verify-comment <commentId>    # Strongly-consistent comment existence check
linear project-issues <project>      # List project issues
linear create <TEAM> "<title>"       # Create issue (defaults to To Do state)
linear create <TEAM> "<title>" --description-file <path>  # Preferred for Markdown/multiline descriptions
linear create <TEAM> "<title>" --project <name|id>  # Attach to a Linear project
linear create <TEAM> "<title>" --state <name>  # Explicit state: todo, backlog, doing, thinking (default: To Do)
linear create <TEAM> "<title>" --dry-run  # Print resolved payload without writing
linear create <TEAM> "<title>" --assignee <name|uuid>  # Assign on create
linear create <TEAM> "<title>" --delegate <name|uuid>  # Delegate on create
linear edit <ID> --title/--desc      # Edit title/description
```

## Reading Image / File Attachments

Linear `uploads.linear.app` URLs (screenshots, mockups, PDFs pasted into a description or comment) are **not public** and do **not** need a browser session cookie — a common misconception. They are served behind the **same Linear API token** the CLI already uses for GraphQL. Two gotchas trip people up:

1. The URL returns **401** with no `Authorization` header.
2. It **302-redirects** to a signed CDN URL, so a fetch that doesn't follow redirects fails.

Don't hand-roll the curl. Use the command — it attaches the agent's token and follows the redirect, then prints the local path so you can read the file:

```
linear fetch-image <uploads.linear.app URL>            # saves to a temp file, prints the path
linear fetch-image <url> -o /tmp/shot.png              # explicit output path
```

Output is JSON: `{ url, savedPath, contentType, bytes }`. The extension is derived from the response `Content-Type` (handles png/jpg/gif/webp/svg/pdf). After fetching, read the `savedPath` with your normal file/image tooling.

**Safety:** the command only accepts `linear.app` / `*.linear.app` hosts. It refuses any other host so the Linear token can never be sent to (and leaked at) an arbitrary URL.

## Creating Issues in the Right Project

Agents often get this wrong, so treat project selection as part of the create operation — not a cleanup step.

### Required create workflow

1. If the user names a project/workspace/initiative, resolve it first:
   ```bash
   linear projects
   ```
2. Use the exact project name or, safer, the project UUID from `linear projects`.
3. Run a dry run before creating when project placement matters:
   ```bash
   linear create <TEAM> "<title>" --project <project-id-or-exact-name> --dry-run
   ```
4. Confirm the dry-run payload has the intended `teamId`/team key and `projectId`/project name.
5. Only then create the issue with the same `--project` value.

### When project is ambiguous

- If the user says a project name that matches multiple things or could mean team vs project, ask one clarifying question.
- If the user says “in the Linear Connector space/project”, search `linear projects` and use the exact Linear Connector project ID/name, not the AI Systems team default.
- If no project is specified, it is okay to create team-only — but do not invent a project.

### Safer pattern

```bash
linear projects > /tmp/linear-projects.json
# choose the exact project id/name from the list
linear create AI "Title" --project "<project-id>" --description-file /tmp/desc.md --delegate "Charles" --dry-run
linear create AI "Title" --project "<project-id>" --description-file /tmp/desc.md --delegate "Charles"
```

Prefer project IDs over names when available; names are easier for humans but IDs avoid ambiguity and stale memory.

## Ticket State on Creation

**Rule: actionable tickets go to To Do, not Backlog.**

- `linear create` defaults to To Do (Linear's API default). This is correct — do not override it with `--state backlog` for work that is ready to be picked up.
- **Backlog is for intentional parking only**: non-milestone project ideas, waiting-on-something items, deprioritized work that Matt has explicitly asked to defer.
- The Linear connector skips Backlog wake-ups. A ticket with a delegate in Backlog will never be auto-dispatched — it silently sits until a human manually flips it.
- If you create a ticket with `--state backlog` AND `--assignee` or `--delegate`, the CLI will warn you. Fix it by using `--state todo` instead.

| Situation | Correct state |
|---|---|
| Ticket is ready for implementation, has a delegate | To Do (default) |
| Ticket is a future idea not yet scoped | Backlog |
| Matt says "put this in the backlog" | Backlog (and remove from milestone) |
| Sub-task spawned during active sprint | To Do |

## Team Keys
- `LIFE` — Matt's Personal Life
- `LN3` — Lane 3 (Lane team)
- `ILL` — Innovative Language Learning (work)
