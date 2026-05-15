# Phase 5.2 Handoff: `mapAwsConfigToState`

> **Note:** The local execution model described in this document was removed in favor of remote-only execution. See [docs/adr/001-remove-local-execution-model.md](adr/001-remove-local-execution-model.md).

This is an implementation + test checklist for step 5.2 only. It is written so any agent can continue without prior chat context.

## Scope

- Implement `mapAwsConfigToState` in `src/awsConfig.ts`.
- Do not implement diff/plan/apply logic here.
- Keep behavior aligned with `docs/phase-5-plan.md` and `docs/phase-5-decisions.md`.

## Locked decisions

- Use sentinel id constant:
  - `const pendingCreationId = "__pending_creation__" as const;`
- Sentinel values are for internal planning transforms only (not scan-produced real AWS state).
- Name matching is exact and case-sensitive.
- For new entities (present in config, absent in current state), emit sentinel ids/arns.
- `root` OU resolves to `context.organization.rootId`.
- `Graveyard` OU id resolves from context for stability.
- Preserve deterministic behavior in transform output (no fresh timestamp generation in transform).
- Keep Valibot schema-first patterns; validate returned state shape.
- Do not export internals only used in the same module.

## Implementation checklist (`src/awsConfig.ts`)

1. Add sentinel constant near other local module constants:
   - `const pendingCreationId = "__pending_creation__" as const;`
2. Add type directly above function:
   - `type MapAwsConfigToStateProps = { config: AwsConfigModel; currentState: StateFile; context: AwsContextFile };`
3. Add function near `mapStateToAwsConfig`:
   - `function mapAwsConfigToState(props: MapAwsConfigToStateProps): StateFile`
4. Build lookup maps from `currentState` by name:
   - OUs by `name`
   - accounts by `name`
   - users by `userName`
   - groups by `displayName`
   - permission sets by `name`
5. Map organizational units from config:
   - preserve existing id/arn on name match
   - emit sentinel id/arn when no match
   - resolve `root`/`Graveyard` ids from context
   - if non-root OU references parentName that does not exist in config OU names, throw invariant error
   - keep root only in `organization.rootId` (do not add a root row to `organization.organizationalUnits`)
6. Flatten accounts from config OUs into state account rows:
   - preserve existing id/arn/status on match
   - sentinel id/arn for new accounts
   - parentId from mapped OU id
7. Map identity center entities:
   - users/groups/permission sets preserve identifiers on name match; otherwise sentinel
8. Expand config assignments (`accounts[]`) into one assignment per account:
   - resolve principal as GROUP or USER
   - enforce principal invariant: exactly one of `group` or `user` must be set, otherwise throw
   - resolve permissionSetArn from mapped permission set
   - resolve accountId from mapped accounts
9. Rebuild `accessRoles` from assignments via existing helper.
10. Run uniqueness checks (defense in depth), validate final output state, and keep ordering deterministic (or normalize before compare in tests).

## Test-by-test checklist (`src/awsConfig.test.ts`)

Add focused tests for `mapAwsConfigToState` with minimal fixtures.

### Test 1 — Root/Graveyard resolution from context

**Given:**
- `context.organization.rootId = "r-root"`
- `context.organization.graveyardOuId = "ou-graveyard"`
- config includes OUs: `root`, `Graveyard`

**Expect:**
- mapped `root` OU id is `"r-root"`
- mapped `Graveyard` OU id is `"ou-graveyard"`

### Test 2 — Existing entities keep real identifiers

**Given:**
- current state has OU `"Engineering"` id `"ou-eng"`
- current state has account `"dev-sandbox"` id `"123456789012"`
- config contains same OU/account names

**Expect:**
- mapped OU/account rows preserve existing id/arn
- account parentId resolves to mapped OU id

### Test 3 — New account gets sentinel id

**Given:**
- config includes account `"new-sandbox"` not present in current state

**Expect:**
- mapped account has `id === "__pending_creation__"`
- mapped account has sentinel arn placeholder

### Test 4 — Assignment expansion to one row per account

**Given config assignment:**
- `{ permissionSet: "Admin", group: "Platform", accounts: ["dev", "prod"] }`

**Expect:**
- two `accountAssignments` rows are produced
- both share same principal + permission set
- each row has one of the resolved account ids

### Test 5 — Unknown assignment references stay representable

**Given:**
- assignment references account/group/permission set not found in current state

**Expect:**
- transform does not throw for this case
- emitted assignment uses sentinel-resolved ids/arns
- downstream diff can classify unsupported work

## Minimal fixture shape (copy/paste starter)

Use tiny but valid objects. Keep only fields required by current schemas.

```ts
const currentState: StateFile = {
  version: "1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  organization: {
    rootId: "r-root",
    organizationalUnits: [
      { id: "ou-eng", parentId: "r-root", arn: "arn:ou-eng", name: "Engineering" },
      { id: "ou-graveyard", parentId: "r-root", arn: "arn:ou-graveyard", name: "Graveyard" }
    ],
    accounts: [
      {
        id: "123456789012",
        arn: "arn:acct-dev",
        name: "dev-sandbox",
        email: "dev@example.com",
        status: "ACTIVE",
        parentId: "ou-eng"
      }
    ]
  },
  identityCenter: {
    instanceArn: "arn:sso-instance",
    identityStoreId: "d-123",
    users: [{ userId: "u-1", userName: "alice", displayName: "Alice", emails: ["alice@example.com"] }],
    groups: [{ groupId: "g-1", displayName: "Platform" }],
    permissionSets: [{ permissionSetArn: "arn:ps-admin", name: "Admin", description: "Admin access" }],
    accountAssignments: [],
    accessRoles: []
  }
};
```

## Validation commands

- `npm run typecheck`
- `npm test`

If tests are still being added incrementally, at minimum run `npm run typecheck` after each small change.
