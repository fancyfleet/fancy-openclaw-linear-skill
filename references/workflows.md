# Common Workflows

## Handoff to reviewer

```bash
linear handoff-work AI-123 Astrid --comment-file /tmp/review.md
```

## Create issue and attach to project

```bash
linear create AI "Title" --description "..." --project <project-id>
```

## GitHub worktree lifecycle

```bash
ISSUE="AI-123"
BRANCH="feature/ai-123-short-slug"

# The base branch is repo-specific: some repos cut from main, others from
# develop. Read the repo's own contributing docs and set it — do not copy a
# base branch out of this example, and do not assume the one you used last.
BASE="<the base branch this repo actually uses>"

cd ~/Code/repo
git fetch origin
git worktree add .worktrees/${ISSUE,,} -b "$BRANCH" "origin/$BASE"
cd .worktrees/${ISSUE,,}
# implement

git add -A && git commit -m "feat: implement $ISSUE"
git push -u origin "$BRANCH"
gh pr create --title "$ISSUE: title" --body "Closes $ISSUE"

# after merge
cd ~/Code/repo
git worktree remove .worktrees/${ISSUE,,}
git branch -d "$BRANCH"
```
