# ADR 006: npm Version Check on CLI Start

## Status

Accepted

## Date

2026-05-19

## Context

The CLI already tracks `cliVersion` inside `aws.context.json` (under `deployment`) to detect Lambda/CLI drift and prompt the user to run `upgrade` + `init --update`. There is no equivalent check for whether a newer version of the package itself is available on npm. Users currently discover they are outdated only after encountering a problem — such as the `PermissionsBoundary` scan crash fixed in 1.3.0, which affected users still running 1.2.1.

A lightweight, TTL-gated npm registry poll on every CLI start would surface available upgrades proactively without adding latency on every invocation.

## Decision

On every CLI start, check the npm registry for a newer version of `@beesolve/aws-accounts`. Gate the check with a 24-hour TTL stored in `aws.context.json` to avoid a network call on every invocation. The check is entirely best-effort: any failure is silently swallowed so it can never block or crash a CLI run.

### 1. Extend `awsContextSchema` (`src/awsConfig.ts`)

Add `versionCheckLastRunAt` as an optional field to the existing `awsContextSchema`:

```ts
const awsContextSchema = v.strictObject({
  // ... existing fields ...
  versionCheckLastRunAt: v.optional(nonEmptyString),
});
```

Backwards-compatible: existing files without the field continue to pass strict-schema validation.

### 2. Add `checkForNewVersionIfNeeded()` (`src/awsConfig.ts`)

```ts
const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export async function checkForNewVersionIfNeeded(props: {
  contextPath: string;
  logger: Logger;
}): Promise<void> {
  try {
    let lastCheckedAt: string | undefined;
    let rawContext: Record<string, unknown> | undefined;
    try {
      const raw = await readFile(props.contextPath, "utf8");
      rawContext = JSON.parse(raw) as Record<string, unknown>;
      lastCheckedAt = typeof rawContext.versionCheckLastRunAt === "string"
        ? rawContext.versionCheckLastRunAt
        : undefined;
    } catch {
      // context file absent — proceed without TTL guard
    }

    if (lastCheckedAt != null) {
      const elapsed = Date.now() - new Date(lastCheckedAt).getTime();
      if (elapsed < VERSION_CHECK_TTL_MS) return;
    }

    const [currentVersion, latestVersion] = await Promise.all([
      readPackageVersion(),
      fetchLatestNpmVersion(),
    ]);

    if (rawContext != null) {
      await writeFile(
        props.contextPath,
        JSON.stringify({ ...rawContext, versionCheckLastRunAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    }

    if (latestVersion !== currentVersion) {
      props.logger.log("");
      props.logger.log(
        `A new version of aws-accounts is available: ${latestVersion} (you have ${currentVersion}). Run: npx @beesolve/aws-accounts@latest upgrade`,
      );
    }
  } catch {
    // version check is best-effort — never block or crash the CLI
  }
}

async function fetchLatestNpmVersion(): Promise<string> {
  const response = await fetch("https://registry.npmjs.org/@beesolve/aws-accounts/latest");
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const body = await response.json() as { version?: unknown };
  if (typeof body.version !== "string") throw new Error("Unexpected npm registry response.");
  return body.version;
}
```

Design notes:
- Uses Node's built-in `fetch` (available since Node 18; this project targets Node 24).
- `rawContext` spread preserves all existing fields when writing back, avoiding a round-trip through the strict valibot schema.
- `writeFile` is already imported from `node:fs/promises` in this file.
- No new dependencies introduced.

### 3. Call at startup (`src/cli.ts`)

Add after the profile/region resolution block, before the first `if (command === ...)` branch (~line 94):

```ts
await checkForNewVersionIfNeeded({ contextPath, logger });
```

Import `checkForNewVersionIfNeeded` from `./awsConfig.js`. The call fires on every command. Because all errors are swallowed inside the function, it cannot affect any command's execution.

## Rationale

- **Why store the timestamp in `aws.context.json`?** It is the single source of persistent local state this tool already owns. Introducing a separate file (e.g. `~/.aws-accounts-version-check.json`) would add scope without benefit.
- **Why 24 hours?** Frequent enough to catch newly published versions within a day; infrequent enough to avoid a network round-trip on every invocation.
- **Why best-effort (swallowed errors)?** Version checks are cosmetic. A transient network error, offline environment, or npm outage must never block `plan` or `apply`.
- **Why not persist the timestamp when the context file is absent?** The context file is owned by the `init`/`bootstrap` flow; writing it partially before bootstrap would corrupt subsequent schema validation. Until bootstrap runs, the check fires on every invocation — acceptable because pre-bootstrap runs are rare.
- **Why built-in `fetch` rather than an HTTP library?** No new dependency needed. `fetch` is stable and available on the Node version this project already requires.

## Consequences

- Users running an outdated CLI see a one-line upgrade notice at most once per 24 hours.
- `aws.context.json` gains one new optional field; existing files are unchanged on read.
- The timestamp write modifies `aws.context.json` outside the normal `init`/`upgrade` flow, but only touches a single additive field via a spread.
- No change to CI, tests, or the Lambda — this is CLI-only.
