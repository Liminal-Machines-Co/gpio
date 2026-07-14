# Release CI without the double-run

A portable recipe for `npm version`–driven releases on GitHub Actions that fire
**one** workflow run per release. Nothing here is specific to this package — copy
it into any repo with the same `--follow-tags` double-run problem and adjust the
names.

## Root cause

`npm version` + `git push --follow-tags` pushes **two refs at once**: the version
commit (to `main`) and the tag `vX.Y.Z`. If one workflow triggers on both
`branches` and `tags`, it fires twice — once skipping publish, once publishing.

`[skip ci]` can't fix it: the tag points at the same commit, so skipping that
commit would skip the release run too.

## The fix — 3 parts

### 1. `.npmrc` — mark the release commit

`npm version` reads this automatically (no script, no `-m` flag):

```ini
message = "chore(release): %s"
```

`%s` is replaced with the new version. Any marker works; it just has to match the
guard in `ci.yml`. Verify with `npm config get message`.

### 2. `ci.yml` — trigger on branches + PRs + `workflow_call` (not tags)

Add a job-level `if:` guard to **every** job. It skips the release commit on a
branch push but passes in the tag/reuse context.

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_call: # lets release.yml reuse these jobs

jobs:
  test:
    if: ${{ startsWith(github.ref, 'refs/tags/') || !startsWith(github.event.head_commit.message, 'chore(release):') }}
    runs-on: ubuntu-latest
    steps: [] # ... your test steps ...

  build: # e.g. prebuilds / artifacts — same guard
    if: ${{ startsWith(github.ref, 'refs/tags/') || !startsWith(github.event.head_commit.message, 'chore(release):') }}
    runs-on: ubuntu-latest
    steps:
      # ...
      - uses: actions/upload-artifact@v6
        with:
          name: build-output
          path: <dir>/
```

Guard logic: run if the ref is a tag (release / reuse) **OR** the commit is not a
`chore(release):` one. So normal pushes run; PRs run (`head_commit` is null →
passes); the release commit's branch push is skipped.

### 3. `release.yml` — tag-only; reuse CI, then publish

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  ci:
    uses: ./.github/workflows/ci.yml # runs test + build (guard passes: ref is a tag)

  publish:
    needs: ci
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: "https://registry.npmjs.org"
      - uses: actions/download-artifact@v6
        with:
          name: build-output
          path: <dir>/
      - name: Verify tag matches package version
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          PKG="$(node -p "require('./package.json').version")"
          [ "$TAG" = "$PKG" ] || { echo "::error::tag v$TAG != package.json $PKG"; exit 1; }
      - run: npm ci
      - run: npm publish --provenance --access public
```

## Result

| Event                       | `ci.yml`   | `release.yml`            |
| --------------------------- | ---------- | ------------------------ |
| Push to `main` (normal)     | ✅ runs     | —                        |
| Pull request                | ✅ runs     | —                        |
| Release commit on `main`    | ⛔ skipped  | —                        |
| Tag `vX.Y.Z`                | —          | ✅ test + build + publish |

One workflow run per release, zero redundant compute, normal CI untouched. The
release flow is unchanged: still just `npm version patch`.

## Checklist when porting

- The marker in `.npmrc` **must** match the string in both
  `startsWith(..., 'chore(release):')` guards.
- Put the `if:` guard on **every** job in `ci.yml` — a job without it still runs
  on the release commit.
- The `upload-artifact` name (ci.yml) must match `download-artifact` (release.yml).
  Within a single run — including `workflow_call` — artifacts are shared.
- `uses: ./.github/workflows/ci.yml` requires that reusable workflow to declare
  the `workflow_call:` trigger.
- Keep a `preversion` gate (`lint && typecheck && test`) so a broken tag never
  gets pushed in the first place.
- Adjust `main` → your default branch, and the publish/verify steps to your
  artifact and binary names.

## How this repo applies it

See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml),
[`.github/workflows/release.yml`](../.github/workflows/release.yml),
[`.npmrc`](../.npmrc), and the release notes in [`RELEASING.md`](../RELEASING.md).
Here the reused `build` job is `prebuilds` (Zig cross-compiles every target and
uploads `gpio.node` binaries), and `publish` additionally checks that all five
prebuilds are present before publishing.
