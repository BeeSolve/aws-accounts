# Design Document

## Overview

This design adds two new CLI capabilities:

1. **`profile` command** — a new command that reads cached state and context, builds a list of account/permission-set combinations, presents an interactive picker, and outputs a valid `~/.aws/config` profile block to stdout.

2. **`graveyard close` subcommand** — extends the existing `graveyard` command with a `close` subcommand that outputs `aws organizations close-account` commands for eligible graveyarded accounts.

Both commands are local-only (no AWS API calls) and operate on the cached state file.

## Components and Interfaces

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                        CLI (cli.ts)                      │
│  parseArgs → route "profile" or "graveyard [close]"     │
└────────────┬──────────────────────────┬─────────────────┘
             │                          │
             ▼                          ▼
┌────────────────────────┐   ┌──────────────────────────┐
│  src/commands/profile.ts│   │ src/commands/graveyard.ts │
│                        │   │  (extended with close)    │
│  runProfileCommand()   │   │  runGraveyardCommand()    │
│                        │   │  runGraveyardCloseCommand()│
└────────┬───────────────┘   └──────────┬───────────────┘
         │                              │
         ▼                              ▼
┌────────────────────────────────────────────────────────┐
│              Shared Data Layer                          │
│  readStateCache() + readAwsContextFromFile()           │
│  .remote-state-cache.json + aws.context.json           │
└────────────────────────────────────────────────────────┘
```

### Data Flow — Profile Command

```
1. Read .remote-state-cache.json → StateFile
2. Read aws.context.json → AwsContextFile
3. Extract accountAssignments + accounts + permissionSets from state
4. Filter out graveyard accounts
5. Deduplicate by (accountId, permissionSetName)
6. Sort alphabetically
7. Display numbered list → user picks one
8. Generate profile block (pure function) → stdout
```

### Data Flow — Graveyard Close

```
1. Read .remote-state-cache.json → StateFile
2. Read aws.context.json → AwsContextFile
3. Filter accounts where parentId === graveyardOuId AND status === "ACTIVE"
4. Sort alphabetically by name
5. Output `aws organizations close-account --account-id <id>` per account
```

## Data Models

### ProfileCombination

```typescript
type ProfileCombination = {
  accountId: string;      // AWS account ID (12 digits)
  accountName: string;    // Human-readable account name from state
  permissionSetName: string; // Permission set name (used as sso_role_name)
};
```

### ProfileBlockInput

```typescript
type ProfileBlockInput = {
  accountId: string;
  accountName: string;
  permissionSetName: string;
  startUrl: string;       // Derived: https://<identityStoreId>.awsapps.com/start
  ssoRegion: string;      // From context.deployment.region
  sessionName: string;    // Derived: beesolve-<identityStoreId>
};
```

### ProfileCommandInput

```typescript
type ProfileCommandInput = {
  logger: Logger;
  cachePath: string;      // .remote-state-cache.json
  contextPath: string;    // aws.context.json
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  isTty: boolean | undefined;
};
```

### GraveyardCloseCommandInput

```typescript
type GraveyardCloseCommandInput = {
  logger: Logger;
  cachePath: string;
  contextPath: string;
};
```

## Detailed Design

### New File: `src/commands/profile.ts`

```typescript
import { createInterface } from "node:readline/promises";
import { readAwsContextFromFile, type AwsContextFile } from "../awsConfig.js";
import type { Logger } from "../logger.js";
import { readStateCache } from "../remoteStateCache.js";
import type { StateFile } from "../state.js";

// --- Types ---

type ProfileCommandInput = {
  logger: Logger;
  cachePath: string;
  contextPath: string;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  isTty: boolean | undefined;
};

type ProfileCombination = {
  accountId: string;
  accountName: string;
  permissionSetName: string;
};

type ProfileBlockInput = {
  accountId: string;
  accountName: string;
  permissionSetName: string;
  instanceArn: string;
  sessionName: string;
};

// --- Public API ---

export async function runProfileCommand(props: ProfileCommandInput): Promise<void>;

// Pure function — exported for testing
export function buildProfileCombinations(
  state: StateFile,
  graveyardOuId: string,
): ProfileCombination[];

// Pure function — exported for testing
export function generateProfileBlock(input: ProfileBlockInput): string;

// Pure function — exported for testing
export function deriveSessionName(instanceArn: string): string;

// Pure function — exported for testing
export function deriveStartUrl(instanceArn: string): string;

// Pure function — exported for testing
export function deriveSsoRegion(instanceArn: string): string;

// Pure function — exported for testing
export function toKebabCase(value: string): string;
```

### Pure Functions

#### `buildProfileCombinations`

```typescript
export function buildProfileCombinations(
  state: StateFile,
  graveyardOuId: string,
): ProfileCombination[] {
  const permissionSetByArn = new Map(
    state.identityCenter.permissionSets.map(ps => [ps.permissionSetArn, ps.name])
  );
  const accountById = new Map(
    state.organization.accounts.map(a => [a.id, a])
  );

  const seen = new Set<string>();
  const combinations: ProfileCombination[] = [];

  for (const assignment of state.identityCenter.accountAssignments) {
    const account = accountById.get(assignment.accountId);
    if (account == null || account.parentId === graveyardOuId) continue;

    const permissionSetName = permissionSetByArn.get(assignment.permissionSetArn);
    if (permissionSetName == null) continue;

    const key = `${assignment.accountId}|${permissionSetName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    combinations.push({
      accountId: assignment.accountId,
      accountName: account.name,
      permissionSetName,
    });
  }

  return combinations.sort((a, b) =>
    a.accountName.localeCompare(b.accountName) ||
    a.permissionSetName.localeCompare(b.permissionSetName)
  );
}
```

#### `generateProfileBlock`

```typescript
export function generateProfileBlock(input: ProfileBlockInput): string {
  const profileName = toKebabCase(`${input.accountName}-${input.permissionSetName}`);
  const sessionName = input.sessionName;
  const startUrl = deriveStartUrl(input.instanceArn);
  const ssoRegion = deriveSsoRegion(input.instanceArn);

  const profileBlock = [
    `[profile ${profileName}]`,
    `sso_session = ${sessionName}`,
    `sso_account_id = ${input.accountId}`,
    `sso_role_name = ${input.permissionSetName}`,
  ].join("\n");

  const sessionBlock = [
    `[sso-session ${sessionName}]`,
    `sso_start_url = ${startUrl}`,
    `sso_region = ${ssoRegion}`,
    `sso_registration_scopes = sso:account:access`,
  ].join("\n");

  return `${sessionBlock}\n\n${profileBlock}\n`;
}
```

#### `deriveStartUrl`

Extracts the directory ID from the instance ARN and constructs the start URL.

Instance ARN format: `arn:aws:sso:::instance/ssoins-XXXXXXXXXX`
The start URL uses the Identity Center directory ID (from `aws.context.json` identityStoreId or derived from the ARN region).

Actually, the start URL format is `https://d-XXXXXXXXXX.awsapps.com/start` where `d-XXXXXXXXXX` is the `identityStoreId` from context. We'll pass this through the input.

Revised approach — `ProfileBlockInput` includes `identityStoreId`:

```typescript
type ProfileBlockInput = {
  accountId: string;
  accountName: string;
  permissionSetName: string;
  instanceArn: string;
  identityStoreId: string;
  sessionName: string;
};

export function deriveStartUrl(identityStoreId: string): string {
  return `https://${identityStoreId}.awsapps.com/start`;
}

export function deriveSsoRegion(instanceArn: string): string {
  // arn:aws:sso:<region>:<account>:instance/<id>
  // But SSO instance ARNs have empty region: arn:aws:sso:::instance/ssoins-xxx
  // The region comes from the deployment context instead
  // We'll pass it explicitly
}
```

Final revised approach — since the SSO instance ARN has no region embedded (`arn:aws:sso:::instance/...`), we need the region from the deployment context. The `ProfileBlockInput` becomes:

```typescript
type ProfileBlockInput = {
  accountId: string;
  accountName: string;
  permissionSetName: string;
  startUrl: string;
  ssoRegion: string;
  sessionName: string;
};
```

And the caller derives `startUrl` and `ssoRegion` from context before calling the pure function.

### Modifications to `src/commands/graveyard.ts`

Add a new exported function alongside the existing one:

```typescript
type GraveyardCloseCommandInput = {
  logger: Logger;
  cachePath: string;
  contextPath: string;
};

export async function runGraveyardCloseCommand(
  props: GraveyardCloseCommandInput,
): Promise<void> {
  const [cache, context] = await Promise.all([
    readStateCache(props.cachePath),
    readAwsContextFromFile(props.contextPath),
  ]);
  if (cache == null) {
    throw new Error(
      `No remote state cache found at "${props.cachePath}". Run a scan or apply command first.`,
    );
  }

  const graveyardOuId = context.organization.graveyardOuId;
  const eligibleAccounts = cache.state.organization.accounts
    .filter(a => a.parentId === graveyardOuId && a.status === "ACTIVE")
    .sort((a, b) => a.name.localeCompare(b.name));

  if (eligibleAccounts.length === 0) {
    props.logger.log("No accounts eligible for closure in Graveyard.");
    return;
  }

  props.logger.log(`${eligibleAccounts.length} account(s) eligible for closure:\n`);
  for (const account of eligibleAccounts) {
    props.logger.log(`# ${account.name} (${account.id})`);
    props.logger.log(`aws organizations close-account --account-id ${account.id}`);
    props.logger.log("");
  }
}
```

### Modifications to `src/cli.ts`

1. Add `"profile"` to the `commands` array.
2. Import `runProfileCommand` from `./commands/profile.js`.
3. Import `runGraveyardCloseCommand` from `./commands/graveyard.js`.
4. Route `profile` command to `runProfileCommand`.
5. Parse the second positional arg for `graveyard` to detect `close` subcommand.

```typescript
// In the graveyard handler:
if (command === "graveyard") {
  const subcommand = args.positionals[1];
  if (subcommand === "close") {
    await runGraveyardCloseCommand({ logger, cachePath, contextPath });
    return;
  }
  if (subcommand != null) {
    throw toUsageError(`Unknown graveyard subcommand: "${subcommand}". Valid: close`);
  }
  await runGraveyardCommand({ logger, cachePath, contextPath });
  return;
}
```

### Session Name Derivation

The `sessionName` for the SSO session block is derived from the identity store ID to keep it stable and unique per organization. Format: `beesolve-<identityStoreId>` (e.g., `beesolve-d-1234567890`).

### Start URL Derivation

The start URL is `https://<identityStoreId>.awsapps.com/start`. This is the standard AWS Identity Center portal URL format.

### SSO Region Derivation

The SSO region comes from `context.deployment.region` since the Identity Center instance ARN doesn't embed the region.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| State cache missing | Throw error: "No remote state cache found. Run a scan or apply command first." |
| Context file missing | Throw error: "aws.context.json not found. Run bootstrap first." |
| No profile combinations available | Log message and exit cleanly (exit code 0) |
| stdin is not a TTY (profile) | Throw error: "Interactive mode required. Run in a terminal." |
| Invalid picker input | Re-prompt with error message |
| Unknown graveyard subcommand | Throw usage error listing valid subcommands |
| No eligible accounts for closure | Log message and exit cleanly (exit code 0) |

## Correctness Properties

### Property 1: Deterministic profile combinations
`buildProfileCombinations` is deterministic: same state input always produces same sorted output.
**Validates: Requirements 2.3, 2.4**

### Property 2: Pure profile block generation
`generateProfileBlock` is a pure function: no side effects, output depends only on input.
**Validates: Requirements 6.1, 6.2, 6.3**

### Property 3: Unique profile names
Profile names are unique per (accountName, permissionSetName) pair due to kebab-case derivation.
**Validates: Requirements 4.6, 5.1**

### Property 4: Graveyard close safety
Graveyard close only outputs commands for ACTIVE accounts — never SUSPENDED.
**Validates: Requirements 8.1, 8.2**

### Property 5: Backward compatibility
Existing `graveyard` command behavior is preserved when no subcommand is given.
**Validates: Requirements 9.1**

## Testing Strategy

### Unit Tests (profile.test.ts)

- `buildProfileCombinations`: test with various state fixtures (empty, single, multiple, graveyard filtering, deduplication)
- `generateProfileBlock`: test output format, field presence, kebab-case conversion
- `toKebabCase`: test edge cases (spaces, special chars, consecutive separators)
- `deriveStartUrl`: test with various identity store IDs

### Unit Tests (graveyard.test.ts)

- `runGraveyardCloseCommand`: test with ACTIVE accounts, SUSPENDED accounts, mixed, empty graveyard
- Subcommand routing: test unknown subcommand error

### Property-Based Tests

- `generateProfileBlock`: for all valid inputs, output contains required INI headers and fields
- `toKebabCase`: output never contains uppercase or spaces

## File Changes Summary

| File | Change |
|------|--------|
| `src/commands/profile.ts` | New file |
| `src/commands/profile.test.ts` | New file |
| `src/commands/graveyard.ts` | Add `runGraveyardCloseCommand` |
| `src/commands/graveyard.test.ts` | Add tests for `close` subcommand |
| `src/cli.ts` | Add `profile` command, add graveyard subcommand routing |
