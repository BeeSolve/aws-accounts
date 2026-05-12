# Phase 6 Wave 4 Follow-up: IAM Action Hinting and Config Codegen Plan

This document captures the shipped IAM action hinting work for inline policies
plus the immediate follow-up to make freshly generated `aws.config.ts` files use
those helpers automatically.

Status:

- action-hint type generation: implemented in repository head
- `init` / config code generation with helper rendering: implemented in
  repository head

## Goal

Improve the authoring experience for IAM Identity Center permission set inline
policies without changing the runtime reconciliation model.

That means:

- generate service-scoped IAM action helpers in `aws.config.types.ts`
- source those helpers from upstream AWS policy metadata rather than manual lists
- consume that functionality through `@beesolve/iam-policy-ts` instead of
  keeping a second in-repo catalog/schema implementation
- teach `init` to emit helper-shaped code in `aws.config.ts` where possible

## Shipped action hinting design

The currently shipped implementation uses the published
`@beesolve/iam-policy-ts` package for:

- IAM policy schemas and guards
- the IAM action catalog
- `iamAction(service, action)` and `iam.<service>(action)` helpers
- source metadata about the upstream AWS action dataset

The generated `aws.config.types.ts` surface should expose:

- `iamAction(service, action)` for explicit service/action pairing
- `iam.<service>(action)` helpers for ergonomic inline-policy authoring
- bracket syntax compatibility for prefixes like `sso-directory`

Examples:

```ts
iam.s3("GetObject");
iam.identitystore("CreateGroupMembership");
iam["sso-directory"]("SearchUsers");
```

## Why helper rendering in `init` matters

Without a render step, users get autocomplete only after they manually rewrite
raw action strings into helper calls. That is still useful, but it leaves the
generated config less expressive than the supported authoring model.

Desired outcome:

- `scan` remains state-only and does not rewrite `aws.config.ts`
- `init` should write helper-based action expressions when it can recognize
  `servicePrefix:ActionName`
- unknown or unrecognized action strings must remain valid raw string literals

## Implemented `init` / config codegen behavior

Replace the current JSON-only inline policy rendering with a TS-aware renderer
for policy documents emitted into `aws.config.ts`.

Recommended rules:

1. Keep the overall config file structure deterministic and readable.
2. For inline policy `Action` and `NotAction` values:
   - render `iam.<service>(<action>)` when the service prefix is identifier-safe
   - render `iam["<service>"](<action>)` when the prefix contains `-` or other
     non-identifier characters
   - fall back to the raw string literal when the action is not present in the
     cached catalog
3. Leave all other policy fields as plain JSON-compatible literals.
4. Preserve scalar-vs-array shape exactly as modeled in the authored config.

Examples:

```ts
Action: iam.s3("GetObject")

Action: [
  iam.organizations("ListAccounts"),
  iam["sso-directory"]("SearchUsers"),
  "custom-service:DoThing",
]
```

## Implemented work

The repository head now:

1. Uses a policy-aware TypeScript renderer in `src/awsConfig.ts` instead of a
   raw `JSON.stringify()` dump for generated config files.
2. Reuses the installed `@beesolve/iam-policy-ts` action catalog for helper
   rendering decisions.
3. Renders helper calls only for recognized `Action` / `NotAction` strings and
   leaves the rest of the policy document in plain JSON-like TypeScript.
4. Covers the behavior with tests for:
   - `writeAwsConfigFromState()` generating helper calls for known actions
   - bracket syntax for prefixes like `sso-directory`
   - fallback to raw string literals for unknown actions
   - `loadAwsConfigModelFromTsFile()` round-tripping helper-generated config
   - `runInitCommand()` emitting helper-based inline policy code

## Guardrails

- normal CLI usage must not depend on network access
- `scan` must remain side-effect free with respect to `aws.config.ts`
- generated config must stay valid TypeScript and valid under `AwsConfig`
- the render step must be deterministic so repeated `init` / `regenerate`
  produce stable diffs
