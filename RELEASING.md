# Releasing

Releases are driven by git tags. You bump the version locally with one command;
CI does the rest — cross-compiling every prebuilt binary and publishing the
single bundled package to npm.

## One-time setup

1. **npm token** — create an npm [automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
   and add it to the GitHub repo as a secret named `NPM_TOKEN`
   (Settings → Secrets and variables → Actions).
2. **Public repo** — npm [provenance](https://docs.npmjs.com/generating-provenance-statements)
   requires the GitHub repository to be public and the `repository` field in
   `package.json` to match its URL. Both are already set; adjust the URL if you
   fork or rename.

## Cutting a release

From a clean `main` working tree:

```sh
npm version patch   # 0.1.0 -> 0.1.1   (bug fixes)
npm version minor   # 0.1.0 -> 0.2.0   (new features, backwards compatible)
npm version major   # 0.1.0 -> 1.0.0   (breaking changes)
```

That single command:

1. runs `preversion` — `lint`, `typecheck`, and the unit tests (aborts the
   release if anything fails);
2. writes the new version into `package.json`, commits it (message
   `chore(release): X.Y.Z`, set by `.npmrc`'s `message`), and creates a
   `vX.Y.Z` git tag;
3. runs `postversion` — `git push --follow-tags`, which pushes the commit and
   the tag.

Pushing the tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

- reuses `ci.yml`'s `test` and `prebuilds` jobs (via `workflow_call`) and waits
  for them to pass;
- verifies the tag matches `package.json` and that all five `gpio.node` prebuilds
  exist;
- publishes `@liminal-machines-co/gpio` to npm with provenance and public access.

The branch commit that `--follow-tags` also pushes does **not** run CI: its
`chore(release):` message trips a skip guard on `ci.yml`'s jobs. So a release
runs exactly one workflow (`release.yml`), not two.

No binaries are built on your machine for a release — the prebuilds job
cross-compiles all targets on one CI runner and bundles them into the package.

## Pre-releases

For a release candidate that installs only when explicitly requested:

```sh
npm version prerelease --preid rc   # 0.2.0 -> 0.2.1-rc.0
```

Then publish that tag under the `next` dist-tag by changing the publish step to
`npm publish --tag next --provenance --access public` (or publish manually).

## Verifying before you tag

```sh
npm run build:prebuilds   # cross-compile all targets locally
npm pack --dry-run        # inspect exactly what would be published
```

The tarball should contain `dist/`, `index.js`, `index.d.ts`, and
`prebuilds/<platform>-<arch>/gpio.node` for every target — and no test files.
