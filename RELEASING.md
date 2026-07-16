# Releasing

How a merged commit on `main` becomes a CLI that agents actually have.

Merging a PR **does not release anything**. Until a release is cut and installed, a
merged verb does not exist at any command line. This is the difference between
"landed" and "in agents' hands", and it is the distinction that AI-2454 exists to
make visible.

## Credentials — you do not need any

**Publishing requires no credential that agents do not already hold.** The release
workflow authenticates with the `GITHUB_TOKEN` that GitHub Actions mints for the run
(`permissions: contents: write`), which is the same mechanism the connector repo uses
to publish its image. There is no npm token, no PAT, and no org secret to provision.

This repo is **public**, so the published tarball is downloadable with **no
authentication at all**. Installing a release needs no credential either.

Cutting a release needs only the ability to push a tag, which the Developer App
already grants (`contents: write`). `main` is not a protected branch and there are no
tag protection rules.

> Deliberately **not** GitHub Packages (`npm.pkg.github.com`): that registry rejects
> both App tokens and fine-grained PATs, so consuming from it would force a classic
> `read:packages` PAT onto every host. Only a Beardbird one exists, and minting a
> fancyfleet one to install a public package would be inventing a credential
> requirement where none exists. Releases attached to a public repo need nothing.

## Release steps

### 1. Bump the version on `main`

Version bumps are standalone `chore:` commits made at release time. That convention
is preserved — it keeps the bump reviewable on its own and out of feature diffs.

```bash
# on a branch, as its own commit
npm version <major|minor|patch> --no-git-tag-version
git commit -am "chore: bump CLI to $(node -p "require('./package.json').version")"
```

Open a PR, get it reviewed, and merge it. **Do not tag before merging** — the release
gate rejects a tag that names a commit which is not on `main`.

### 2. Cut the tag

From a clean, up-to-date `main`:

```bash
git checkout main && git pull
npm run release:tag           # add -- --dry-run to see what it would do
```

The tag name is derived from `package.json`, not typed, so it cannot disagree with
what gets published. The script refuses to run from a non-`main` branch, with
uncommitted changes, when local `main` is behind the remote, or when the tag already
exists.

Pushing the `v*` tag is what triggers `.github/workflows/release.yml`.

### 3. What the workflow does

On any `v*` tag it verifies the tag matches `package.json` **and** names a commit on
`main` (`scripts/check-release-tag.js`), then builds, runs the full suite, `npm pack`s
a tarball, and publishes it as a GitHub Release with generated notes.

The tests run again at release time on purpose: a published artifact should be one
that passed its own tests, not one that passed on a green PR days earlier against a
different tree.

## Verifying a release landed

Three separate questions. Answer the one you actually have.

**"Was version X published?"**

```bash
gh release view v0.3.9 --repo fancyfleet/fancy-openclaw-linear-skill
# or, with no credential and no gh:
curl -s https://api.github.com/repos/fancyfleet/fancy-openclaw-linear-skill/releases/latest \
  | grep '"tag_name"'
```

**"What version is installed on *this* host?"**

```bash
linear --version
```

If that errors with `unknown option '--version'`, the host predates the first release
cut through this path and is definitively stale.

**"Is the verb I need actually here?"**

```bash
linear <verb> --help
```

A missing verb exits non-zero. Compare `linear --version` against the latest release
above — if they differ, the host is behind and the verb may exist upstream while being
genuinely absent here. **A verb missing from an out-of-date CLI is indistinguishable
from a gate refusal until you check the version**, which is why `--version` exists.

## Installing a release

```bash
VERSION=0.3.9
npm install -g "https://github.com/fancyfleet/fancy-openclaw-linear-skill/releases/download/v${VERSION}/fancy-openclaw-linear-skill-cli-${VERSION}.tgz"
linear --version    # must print $VERSION
```

No credential is required — the repo is public.

Rolling this out across every host and container is **not** part of this path; it is a
separate fleet operation (Grover's lane). Cutting a release makes the artifact exist
and makes drift detectable. It does not move any host by itself.

## Rollback

**A published version is never re-pointed.** Consumers may already have installed it,
and moving a tag means two hosts disagree about what `v0.3.9` contains while both
report the same version — the exact failure this repo already had, made harder to see.

To roll back, **release forward**:

```bash
git revert <bad commit>          # via PR, reviewed and merged as usual
# then bump to the next patch version and release it (steps 1–2)
```

Affected hosts install the new version with the command above.

If a release is caught before anyone has installed it, delete it and re-cut — this is
the only case where removing a release is safe, and it is only safe because nothing
consumed it yet:

```bash
gh release delete v0.3.9 --repo fancyfleet/fancy-openclaw-linear-skill --yes
git push origin :refs/tags/v0.3.9
```

If the workflow failed *before* publishing (a red gate, a red suite), nothing was
released. Delete the tag, fix `main`, and tag again.

## Known drift

At the time this path was written, `origin/main` was `0.3.9`, the newest tag was
`v0.3.8`, and hosts across the fleet ran a mix of the two — 0.3.9 was bumped on main
and never tagged, so nothing published and nothing detected it. Backfilling that drift
is tracked separately; this doc is the mechanism that stops it recurring.
