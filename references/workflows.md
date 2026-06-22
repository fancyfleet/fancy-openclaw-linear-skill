# Common Workflows

## Handoff to reviewer

```bash
linear handoff AI-123 Astrid --comment-file /tmp/review.md
```

## Create issue and attach to project

```bash
linear create AI "Title" --description "..." --project <project-id>
```

## GitHub worktree lifecycle

```bash
ISSUE="AI-123"
BRANCH="feature/ai-123-short-slug"
cd ~/Code/repo
git checkout develop && git pull origin develop
git worktree add .worktrees/${ISSUE,,} -b "$BRANCH" origin/develop
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
