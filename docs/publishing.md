# Publishing a New Version

## Prerequisites

- Push access to `main` branch
- `NPM_TOKEN` secret configured in GitHub repo settings (Settings → Secrets → Actions)

## Steps

1. **Bump the version:**

   ```bash
   npm version patch   # 1.0.1 → 1.0.2
   npm version minor   # 1.0.1 → 1.1.0
   npm version major   # 1.0.1 → 2.0.0
   ```

   This updates `package.json`, creates a commit, and tags it.

2. **Push to main:**

   ```bash
   git push && git push --tags
   ```

3. **Done.** The GitHub Actions workflow will:
   - Run typecheck and tests
   - Detect the new version isn't on npm yet
   - Build the CLI and Lambda
   - Publish to npm with provenance

## Verify

Check the workflow run at: https://github.com/BeeSolve/aws-accounts/actions

Confirm the package is live: https://www.npmjs.com/package/@beesolve/aws-accounts

## Manual Publish (fallback)

If CI is broken and you need to publish directly:

```bash
npm publish --access public
```

The `prepublishOnly` script runs typecheck, build, and lambda build automatically.

## NPM Token Setup

1. Go to https://www.npmjs.com/settings/tokens
2. Generate a new **Automation** token
3. Add it as `NPM_TOKEN` in GitHub repo settings (Settings → Secrets and variables → Actions)
