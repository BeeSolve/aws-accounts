# aws.config.ts JS Object Output Plan

## Context

Today `aws.config.ts` generation renders the second argument of `v.parse(...)` using `JSON.stringify(...)`.  
This produces JSON-style output on first generation (quoted keys), while normal editor formatting can later convert it to JavaScript object style.

Goal: make generated `aws.config.ts` output JavaScript-object formatted from the start, so first-write output already matches typical human-edited style.

## Why this should be implemented

- Improves readability of freshly generated `aws.config.ts`.
- Reduces noisy diffs caused only by editor reformatting right after first edit/save.
- Keeps the file aligned with "human-editable config" intent.
- Does not require changing reconciliation logic; this is presentation/serialization only.

## Scope boundaries (important)

This change should be strictly scoped:

- Only affect `aws.config.ts` rendering in `src/awsConfig.ts`.
- Only replace the payload formatting used as the second argument to `v.parse(...)`.
- Keep all other behavior unchanged:
  - mapping (`mapStateToAwsConfig`, `mapAwsConfigToState`)
  - validation and schemas
  - diff/apply flow
  - `aws.config.types.ts` generation

No cross-module serialization refactor is required.

## Proposed implementation approach

1. In `renderAwsConfigTs(...)`, replace:
   - `JSON.stringify(props.config, null, 2)`
   with a local formatter that emits a TypeScript/JavaScript object literal string.

2. Formatter behavior:
   - Objects:
     - Use unquoted keys when key is a valid identifier (`^[A-Za-z_$][A-Za-z0-9_$]*$`).
     - Fallback to quoted keys when required for correctness.
   - Arrays: multiline with stable indentation.
   - Strings: still escape safely via `JSON.stringify(value)`.
   - Primitives (`null`, `boolean`, `number`): emit literal value.

3. Keep deterministic ordering exactly as produced by existing sorting logic.

4. Keep surrounding template unchanged:
   - imports
   - comments
   - `const awsConfig: AwsConfig = v.parse(awsConfigSchema, ... satisfies AwsConfig);`
   - `export default awsConfig;`

## Expected side effects and risks

- Runtime behavior should remain unchanged because TS object literal and JSON payload are semantically equivalent for this use case.
- Main risk is test harness assumptions:
  - Some tests currently parse extracted `v.parse(...payload...)` content using `JSON.parse(...)`.
  - JS-object output is no longer valid JSON text, so those helpers may need updates.

This is a test-layer adjustment, not a product-behavior risk.

## Validation checklist (when implementing later)

- `aws.config.ts` generated output uses JS-object style keys (where valid).
- No functional changes in plan/apply behavior.
- `npm run typecheck` passes.
- `npm test` passes (including any test helper updates needed for non-JSON payload extraction).

## Decision summary

Implementing JS-object output for generated `aws.config.ts` is low-risk and worthwhile for developer experience, provided the change remains narrowly scoped to output formatting in `renderAwsConfigTs(...)` and test helpers are adjusted if they rely on `JSON.parse` of embedded config payload text.
