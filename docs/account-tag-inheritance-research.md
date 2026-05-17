# Account Tag Inheritance Research

**Status:** design research only; deferred — not yet scheduled (see `docs/roadmap.md`).

## Context

Current implementation supports per-account tags only:

- `aws.config.ts` account entries include required `tags` arrays.
- `scan` reads account tags from AWS Organizations.
- `plan` emits `updateAccountTags` when desired/current tags differ.
- `apply` reconciles tags with `TagResource` / `UntagResource`.

The next requested capability is "global tags" that are automatically applied to
all accounts, potentially scoped by OU.

## Problem Statement

We need a way to define default tags once and apply them consistently across many
accounts, while preserving:

- deterministic plans,
- predictable override behavior,
- explicit safety (no hidden mutations),
- compatibility with existing account-level tags.

## AWS Constraints and Reality

- AWS Organizations supports tagging accounts via `TagResource` / `UntagResource`.
- AWS Organizations Tag Policies help with governance/validation, but do not
  directly auto-apply missing tags in the same way this CLI can reconcile.
- Therefore, inheritance/default logic should live in this tool's desired-state
  model and be materialized into explicit account-level desired tags before diff.

## Candidate Designs

### Option A: Root-level global tags only

Add a single global tag set at config root, applied to all accounts.

Pros:

- simplest mental model,
- minimal schema changes.

Cons:

- no OU-specific defaults,
- weaker fit for environments with team/business-unit tags.

### Option B: OU-level inherited tags (recommended)

Allow each OU to define `defaultTags` inherited by descendant OUs/accounts.

Pros:

- natural organizational fit,
- supports both broad and targeted defaults,
- composes well with account-specific overrides.

Cons:

- requires inheritance resolution logic,
- needs conflict resolution rules.

### Option C: Both root global + OU-level defaults

Combine A and B.

Pros:

- most expressive.

Cons:

- largest schema/design surface,
- higher risk of confusion without strict precedence rules.

## Recommended Direction

Use **Option B** first (OU-level inherited defaults), with clear precedence:

1. Ancestor OU defaults (root-to-leaf order),
2. Child OU defaults override parent keys,
3. Account-level tags override inherited keys.

Then, if needed, add root-level global defaults as a small extension.

## Proposed Config Shape (draft, not implemented)

```ts
organizationalUnits: [
  {
    name: "root",
    parentName: null,
    defaultTags: [
      { key: "managed-by", value: "aws-accounts" },
    ],
    accounts: [],
  },
  {
    name: "Engineering",
    parentName: "root",
    defaultTags: [
      { key: "cost-center", value: "eng" },
      { key: "env", value: "dev" },
    ],
    accounts: [
      {
        name: "AppAccount",
        email: "app@example.com",
        tags: [{ key: "env", value: "prod" }], // overrides OU default
      },
    ],
  },
];
```

## Planning/Apply Model

1. Build effective desired tags per account by combining inherited OU defaults and
   account tags using precedence rules.
2. Compare effective desired tags to current state tags.
3. Emit explicit `updateAccountTags` ops per account as today.

No new apply operation type is required if inheritance is resolved before diff.

## Open Decisions

1. Should users be able to "remove" an inherited tag at account level?
   - If yes, we need a denylist/removal marker mechanism.
2. Should `Graveyard` accounts be excluded from inherited defaults?
   - Recommended yes, because they are intentionally out of authored config.
3. Should inheritance apply to newly created accounts in the same apply batch?
   - Recommended yes, by generating effective desired tags for those accounts too.

## Suggested Incremental Rollout

### Step 1

- Add OU `defaultTags` schema and config/type generation support.
- Implement inheritance flattening into account effective tags.
- Reuse existing `updateAccountTags` diff/apply path.

### Step 2

- Add tests for precedence and deterministic inheritance behavior.
- Add docs with examples and "how overrides work" guidance.

### Step 3 (optional)

- Add account-level explicit inherited-tag removal semantics (if needed).

## IAM Impact

No new IAM actions beyond tag reconciliation already required:

- `organizations:TagResource`
- `organizations:UntagResource`
- `organizations:ListTagsForResource`

## Risks

- Hidden complexity if inheritance is not visible in plan output.
- User confusion around override precedence.

Mitigations:

- include inherited/effective-tag context in human `plan` lines (future enhancement),
- document precedence with concrete examples,
- keep merge rules deterministic and simple.

