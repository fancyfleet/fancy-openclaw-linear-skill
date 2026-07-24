# Workflow Contract Reference

This skill includes both the Linear CLI and the workflow contract for how agents should behave when working from Linear tickets.

## Core principle

The CLI handles access and mutations.
The workflow contract handles judgment and discipline.
You need both.

## Full task lifecycle

### 1. Pick up work honestly

- Move to `In Progress` when you actually start
- Do not mark multiple tickets active just because they exist
- If you cannot start yet, leave the issue in `Todo`

### 2. Work with signal, not noise

- Comment when you have a deliverable, blocker, decision, or scope change
- Do not comment empty ceremony like "on it" or "making progress"
- Use the CLI to keep state honest

### 3. Hand off cleanly

Use the skill's `handoff` flow when work is review-ready:
- add a real comment
- assign the reviewer
- move to `Needs Review`

### 4. Close the loop correctly

- `Done` means complete and verified
- do not self-close technical work casually
- preserve enough context on the ticket that the next reader does not need to guess

## Anti-patterns

### Status theater
Marking lots of things `In Progress` that are not actually being worked.

### Comment spam
Comments that add no new information.

### Incomplete handoff
Comment without reassignment, or reassignment without state change.

### Silent drop
Task acknowledged, then no visible outcome.

## Good default commands

```bash
linear observe-issue AI-123
linear begin-work AI-123
linear handoff-work AI-123 Astrid --comment-file /tmp/review.md
```

## Relationship to the connector

If you also use `fancy-openclaw-linear-connector`, it delivers work into the agent environment.
This skill remains the agent-side tool and workflow layer.
The connector is helpful, but not required for this skill to be useful.
