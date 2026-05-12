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
- make the metadata refreshable both on demand and automatically before publish
- keep a checked-in cache so normal CLI commands stay offline and deterministic
- teach `init` to emit helper-shaped code in `aws.config.ts` where possible

## Shipped action hinting design

The currently shipped implementation uses:

- upstream source: `https://awspolicygen.s3.amazonaws.com/js/policies.js`
- maintainer refresh command: `npm run update:iam-actions`
- checked-in cache file: `src/iamActionCatalog.ts`
- publish hook: `prepublishOnly`

The refresh script should:

1. download `policies.js`
2. extract `app.PolicyEditorConfig.serviceMap`
3. normalize to `{ [servicePrefix]: string[] }`
4. sort prefixes and action lists deterministically
5. persist source metadata (URL + SHA256)
6. skip rewriting the cache file when generated content is unchanged

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
2. Reuses the checked-in `iamActionCatalog` for helper rendering decisions.
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

## Future improvements

If AWS's newer Service Authorization Reference JSON becomes a better long-term
source than `policies.js`, the cache refresh script can switch inputs without
changing the user-facing helper API.
