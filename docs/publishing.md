# Publishing a New Version

Publishing is managed by [Changesets](https://github.com/changesets/changesets).

## Prerequisites

- Push access to `main` branch
- npm OIDC publishing configured (already set up — the workflow uses `id-token: write` permission and `--provenance` for tokenless publishing)

## Developer workflow

When your PR includes a user-visible change (feature, fix, breaking change), add a changeset before merging:

```bash
npx changeset
```

This prompts you to choose a semver bump type (`patch` / `minor` / `major`) and write a short summary. It creates a `.changeset/*.md` file — commit it alongside your code changes.

## How publishing works

1. **Merge your PR** (with the `.changeset/*.md` file) to `main`.
2. The GitHub Actions workflow detects the pending changeset and automatically creates or updates a **"Version Packages"** PR that bumps `package.json` and writes `CHANGELOG.md`.
3. **Merge the "Version Packages" PR** when ready to release.
4. The workflow publishes to npm with provenance (via OIDC, no token needed).

## Verify

Check the workflow run at: https://github.com/BeeSolve/aws-accounts/actions

Confirm the package is live: https://www.npmjs.com/package/@beesolve/aws-accounts

## Manual Publish (fallback)

If CI is broken and you need to publish directly, remove `--provenance` (it requires the GitHub Actions OIDC environment):

```bash
npm publish --access public --no-provenance
```

The `prepublishOnly` script runs typecheck, build, and lambda build automatically.
