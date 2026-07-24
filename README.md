# fancy-openclaw-linear-skill

A self-contained Linear skill for OpenClaw agents.

This repo packages both:
- a robust Linear CLI for reading and mutating Linear data
- the workflow guidance that tells agents how to work with Linear safely

It is the recommended companion to the `fancy-openclaw-linear-connector`, but it is also useful on its own.

## What This Is

This is a complete Linear skill package, not an add-on to some other internal skill.

It includes:
- auth/bootstrap behavior
- semantic workflow commands (consider-work, begin-work, handoff-work, complete, needs-human, refuse-work, observe-issue; camelCase aliases supported)
- issue read and write commands
- workflow state discovery
- project / milestone / relation helpers
- board and review helpers
- workflow and hygiene documentation

### Semantic vs Raw Commands

This skill provides two layers of CLI access to Linear:

**Semantic commands** are the agent-facing standard. Each captures a workflow intent (e.g., "I'm considering this task," "I'm done, hand to the next agent") and handles multiple state changes atomically. Agents should use these exclusively — they eliminate the class of bugs where an agent changes status but forgets to clear the delegate.

**Raw commands** (status, assign, delegate, comment, handoff) remain available for human interactive use but print deprecation warnings when called by agents.

## Product Boundary

This repo should be installable and understandable by an outside OpenClaw user without needing access to Fancymatt's legacy internal `linear` skill.

The connector relationship is:

```text
Linear → fancy-openclaw-linear-connector → OpenClaw agent
                                         ↓
                           fancy-openclaw-linear-skill
```

- **Connector** handles ingestion, routing, queueing, and recovery
- **This skill** handles agent-side Linear operations and workflow discipline

## Install

**Standard install — install a published release.** No credential is needed; this repo
is public.

```bash
VERSION=0.3.9   # latest: gh release view --repo fancyfleet/fancy-openclaw-linear-skill
npm install -g "https://github.com/fancyfleet/fancy-openclaw-linear-skill/releases/download/v${VERSION}/fancy-openclaw-linear-skill-cli-${VERSION}.tgz"

# Verify
linear --version    # must print $VERSION
linear auth check
```

This installs a copy of the built dist — not a symlink — so it survives nvm switches
and source directory changes.

**To update:** re-run the command above with the newer `$VERSION`, then confirm with
`linear --version`.

**Which version am I on, and is it current?**

```bash
linear --version    # installed here
curl -s https://api.github.com/repos/fancyfleet/fancy-openclaw-linear-skill/releases/latest | grep '"tag_name"'
```

If those disagree, this host is behind — a verb that is missing here may exist
upstream. See [RELEASING.md](RELEASING.md).

**Installing from source** (development, or a commit that has no release yet):

```bash
git clone https://github.com/fancyfleet/fancy-openclaw-linear-skill.git ~/Code/fancy-openclaw-linear-skill
cd ~/Code/fancy-openclaw-linear-skill
npm install
npm install -g .    # prepack runs build automatically
```

A source install reports the version in `package.json`, which is **not** evidence that
any release contains it. Prefer a release install on anything you did not build
yourself.

**Cutting a release:** see [RELEASING.md](RELEASING.md). Merging a PR publishes nothing
on its own.

**Skill symlink** (for agent workspace SKILL.md discovery, separate from the binary):

```bash
ln -s ~/Code/fancy-openclaw-linear-skill ~/.openclaw/workspace/{agentId}/skills/linear
```

**Do not use `npm link`.** It creates a fragile symlink to the source tree that breaks on nvm switches, npm global installs, or forgotten builds. Always use `npm install -g .` (or `npm install -g <tarball>`) which copies the built dist into node_modules.

## Auth Setup

This skill authenticates to Linear using personal API keys (developer tokens). No OAuth is needed.

### Quick start for a new agent

1. Generate a Linear API key: **Linear → Settings → Account → Security & access → API → New token**
2. Create the secrets directory and write the key:
   ```bash
   mkdir -p ~/.openclaw/workspace/{agentId}/.secrets
   echo "LINEAR_{AGENT}_API_KEY=lin_api_your_token" > ~/.openclaw/workspace/{agentId}/.secrets/linear.env
   chmod 600 ~/.openclaw/workspace/{agentId}/.secrets/linear.env
   ```
3. Verify:
   ```bash
   linear doctor
   ```

You should see your Linear user name and email printed. If not, see `references/auth.md` for the full auth guide including env var names, discovery rules, and troubleshooting.

### Auth discovery priority

1. `LINEAR_API_KEY` environment variable
2. `LINEAR_DEVELOPER_TOKEN` environment variable
3. `~/.openclaw/workspace/{agentId}/.secrets/linear.env` (key must match `linear` + `api_key`/`developer_token`/`token`)

## Command Reference

### Semantic Workflow Commands (Agent Standard)

| Command | Description |
|---|---|
| `linear consider-work <id>` | Mark issue as being considered (status → Thinking, delegate → self, assignee cleared). Returns issue context. Hard-rejects Backlog tickets; `--force` explicitly overrides Backlog and Done/Canceled gates with a warning. |
| `linear begin-work <id>` | Begin actively working (status → Doing). Idempotent. |
| `linear handoff-work <id> <agent> [--comment <msg>] [--comment-file <path>]` | Hand off task to another agent. Sets delegate, clears assignee, posts comment. |
| `linear complete <id> [--comment <msg>] [--comment-file <path>]` | Mark task as Done, clear delegate. |
| `linear needs-human <id> <assignee> [--comment <msg>] [--comment-file <path>]` | Escalate to human. Sets assignee, clears delegate. |
| `linear refuse-work <id> <delegate> [--comment <msg>] [--comment-file <path>]` | Refuse task and delegate to another agent. |
| `linear undelegate <id> [--comment <msg>] [--comment-file <path>]` | Clear delegate and assignee without changing status. |
| `linear observe-issue <id> [--all]` | Read-only observation of an issue. No ownership change. `--all` includes all comments. |
| `linear force-deploy <id> --comment <msg>` | Governed workflow escape hatch for merge/deploy evidence-gate false negatives. Requires an audit comment; skips PR evidence verification while preserving the normal workflow transition. |

### Issue Management

| Command | Description |
|---|---|
| `linear issue <id>` | View issue details |
| `linear create <team> <title> [--description <desc> | --description-file <path>] [--project <id>] [--milestone <id>] [--assignee <id>] [--delegate <id>] [--priority <n>] [--parent <id>] [--dry-run]` | Create a new issue. Prefer `--description-file` for Markdown/multiline descriptions; literal `\n` in `--description` is normalized to real newlines with a warning. `--dry-run` prints the resolved create payload without writing. |
| `linear edit <id> --title <title> --description <desc>` | Edit issue title and/or description |
| `linear delete <id>` | Delete an issue |
| `linear search <query> [--team <team>] [--limit <n>]` | Search issues by text |
| `linear branch <id>` | Get the branch name associated with an issue |
| `linear priority <id> <level>` | Set issue priority |
| `linear comments <id> [--all]` | Read comments on an issue |
| `linear delete-comment <commentId>` | Delete a comment |
| `linear verify-comment <commentId>` | Verify a comment exists using strongly-consistent node lookup |
| `linear upload <file> --comment <issueId>` | Upload a file attachment, optionally linking to a comment |
| `linear fetch-image <url> [-o <path>]` | Download a Linear image/file attachment (`uploads.linear.app`) using the agent's API token — handles auth + redirect, prints the saved path. Restricted to `*.linear.app` hosts. |

### Labels

| Command | Description |
|---|---|
| `linear labels [--team <team>]` | List available labels for a team |
| `linear label <id> <labelName...> [--team <team>]` | Add label(s) to an issue. Case-insensitive. Appends to existing labels. |
| `linear unlabel <id> <labelName...> [--team <team>]` | Remove label(s) from an issue. Case-insensitive. |


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
linear handoff-work AI-123 "Astrid (CPO)" --comment-file /tmp/linear-comment.md
```

### Comment Verification

**Never read-after-write to verify a comment.** The mutation result is the strongly-consistent source of truth. Trust the `commentId` and `commentUrl` printed on success. If you genuinely need to confirm propagation (rare), use `linear verify-comment <commentId>` — it uses the strongly-consistent node query, not the eventually-consistent connection feed. The `linear comments` / `observe-issue` connection feed can lag by seconds to minutes.

### Deprecated Commands (Hidden from --help)

These commands still work when invoked directly but are hidden from `linear --help` output. They bypass the semantic workflow model and should not be used by agents.

| Command | Description |
|---|---|
| `linear assign <id> <user>` | Assign issue to a human user. Clears delegate. |
| `linear delegate <id> <agent>` | Delegate issue to an agent. |
| `linear handoff <id> <reviewer> [comment] [--comment-file <path>]` | Delegate + post comment atomically. |
| `linear status <id> <state> [--team <team>]` | Change issue status. |
| `linear comment <id> <body>` | Post a comment to an issue. |
| `linear comment <id> --body-file <path>` | Post a comment from a file. |

> ⚠️ Hidden from `--help`. Print deprecation warnings when used. Agents should use semantic commands instead.

### Hierarchy & Relations

| Command | Description |
|---|---|
| `linear parent <id> <parentId>` | Set an existing issue as a child of another issue |
| `linear unparent <id>` | Remove an issue from its parent |
| `linear subtask <team> <title> --parent <id>` | Create a subtask under a parent issue |
| `linear children <id>` | View child issues |
| `linear block <id> --blocked-by <issueId>` | Create a blocking relation |
| `linear unblock <id> --blocked-by <issueId>` | Remove a blocking relation |
| `linear relations <id>` | View relations for an issue |

### Projects & Milestones

| Command | Description |
|---|---|
| `linear projects` | List all projects |
| `linear project-detail <name>` | View project details |
| `linear project-issues <name>` | List issues in a project |
| `linear project-attach <id> <name>` | Attach an issue to a project |
| `linear milestones <team>` | List milestones for a team |
| `linear milestone-create <project> <name> <targetDate>` | Create a milestone |
| `linear milestone-attach <id> <name>` | Attach an issue to a milestone |

### Agent Workflows (Personal Queue)

| Command | Description |
|---|---|
| `linear my-issues` | All issues assigned to me |
| `linear my-todos` | Issues in Todo state |
| `linear my-new [--since <iso>]` | Recently updated issues (default: last 24h) |
| `linear queue [--next] [--project <name>] [--include-backlog]` | Delegated actionable queue. Excludes Backlog by default; use `--include-backlog` for explicit parked-ticket visibility. |
| `linear my-queue [--project <name>] [--include-backlog]` | Hidden compatibility alias for `queue` |
| `linear my-next` | Highest-priority pending issue |
| `linear my-blocked [--limit <n>]` | Issues assigned to me in Blocked state |
| `linear review-queue` | Issues needing review |
| `linear stalled [days]` | Issues inactive for N days (default: 2) |
| `linear standup` | Daily standup summary |

### Notifications & Urgency

| Command | Description |
|---|---|
| `linear notifications [--limit <n>]` | Unread notifications |
| `linear urgent [--limit <n>]` | High-priority issues (priority ≤ 2) |

### Organization & Metadata

| Command | Description |
|---|---|
| `linear teams [--refresh]` | List all teams |
| `linear states <team> [--refresh]` | List workflow states for a team |
| `linear board <team>` | View team board (issues grouped by state) |

### Auth & Diagnostics

| Command | Description |
|---|---|
| `linear --version` | Print the CLI version installed on this host. Compare against the latest release to tell "this verb does not exist yet here" apart from a gate refusal. |
| `linear auth check` | Verify authentication |
| `linear auth doctor` | Diagnose Linear auth and CLI setup |
| `linear test` | Run full round-trip integration test |

## Docs

- `SKILL.md` — agent-facing skill entrypoint and quick reference
- `RELEASING.md` — how a merged commit becomes an installed CLI: publish, verify, roll back
- `references/auth.md` — auth setup, env var names, discovery rules, onboarding checklist
- `references/permissions.md` — agent permissions guide, credential types, scope requirements
- `references/hygiene.md` — workflow hygiene rules
- `references/graphql.md` — safe raw GraphQL escape-hatch patterns
- `references/workflows.md` — multi-step workflows including GitHub cleanup
- `references/workflow-contract.md` — higher-level behavioral contract
- `references/connector-integration.md` — connector-specific notes

## License

MIT — see [LICENSE](LICENSE).
