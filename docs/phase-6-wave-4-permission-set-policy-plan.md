# Phase 6 Wave 4: IAM Identity Center Permission Set Policy Management Plan

This document captures the implemented Wave 4 follow-up after Wave 3 group
membership management.

Status: implemented in repository head. This document now serves as the design
record for the shipped permission set policy wave.

Cloud-backed execution (`Lambda` / `S3` / saved remote plans) remains **v2**.
This wave stays in the current local-first v1 model:

- `plan` remains local-only
- `apply` executes directly through AWS SDK clients in the CLI
- `state.json` remains the persisted source of actual state
- partial-failure persistence remains in place

## Goal

Support config-driven IAM Identity Center permission set policy reconciliation
for both newly created and already existing permission sets:

- scan current inline policy state into `state.json`
- scan current attached managed-policy state into `state.json`
- generate that policy state into `aws.config.ts`
- diff desired vs current policy state deterministically
- apply additive and subtractive policy mutations safely
- reprovision changed permission sets to already assigned accounts when needed

while preserving:

- schema-first operation modeling
- deterministic plan/apply output
- sequential apply execution
- partial-failure persistence to `state.json`
- existing unsupported deletion / metadata-update boundaries

## Scope

In scope for this wave:

- inline policy reconciliation
- AWS managed policy attachment reconciliation
- customer-managed policy reference attachment reconciliation
- reprovisioning changed permission sets to already assigned accounts

Out of scope for this wave:

- removing permission sets
- editing permission set metadata after creation (`description`, session
  duration, relay state)
- permissions boundary management
- application-assignment / portal settings
- user / group destructive lifecycle
- account removals
- account metadata reconciliation after creation

## Proposed config model

Extend `permissionSets` in [`src/awsConfig.ts`](../src/awsConfig.ts) from:

```ts
permissionSets: Array<{
  name: string;
  description: string;
}>
```

to:

```ts
permissionSets: Array<{
  name: string;
  description: string;
  inlinePolicy?: Record<string, unknown>;
  awsManagedPolicies: string[];
  customerManagedPolicies: Array<{
    name: string;
    path: string;
  }>;
}>
```

Design notes:

- `inlinePolicy` should be omitted when no inline policy is desired
- `awsManagedPolicies` should contain managed policy ARNs
- `customerManagedPolicies` should use explicit `{ name, path }` objects so the
  config matches the AWS API identity model
- both attachment lists must be deterministically sorted
- the authored config should stay readable and reviewable in plain TypeScript

## Proposed persisted state model

Extend `PermissionSetState` in [`src/state.ts`](../src/state.ts) with:

```ts
{
  permissionSetArn: string;
  name: string;
  description: string;
  inlinePolicy: string | null;
  awsManagedPolicies: string[];
  customerManagedPolicies: Array<{
    name: string;
    path: string;
  }>;
}
```

State should persist the inline policy as canonical JSON text rather than an
arbitrary object:

- scan receives the AWS API shape as a JSON string already
- diff equality becomes simple and deterministic
- apply can pass the exact canonical string back into AWS
- `mapStateToAwsConfig()` can parse that canonical JSON back into an authored
  object for `aws.config.ts`

## Scan changes

Extend [`src/commands/scan.ts`](../src/commands/scan.ts) so each scanned
permission set also captures its attached policy state.

Expected AWS SDK commands:

- `GetInlinePolicyForPermissionSetCommand`
- `ListManagedPoliciesInPermissionSetCommand`
- `ListCustomerManagedPolicyReferencesInPermissionSetCommand`

Recommended behavior:

1. keep the existing `ListPermissionSets` + `DescribePermissionSet` scan flow
2. for each permission set ARN:
   - fetch inline policy
   - list AWS managed policy attachments
   - list customer-managed policy references
3. normalize the returned attachment arrays deterministically
4. persist `inlinePolicy: null` when AWS reports no inline policy

## State -> config transform

Extend `mapStateToAwsConfig()` in [`src/awsConfig.ts`](../src/awsConfig.ts):

- parse `inlinePolicy` JSON text to a JS object when present
- emit empty `awsManagedPolicies` / `customerManagedPolicies` arrays when absent
- emit deterministically sorted attachment arrays

If stored inline-policy JSON cannot be parsed, fail fast with a clear error
rather than silently dropping policy state.

## Config -> state transform

Extend `mapAwsConfigToState()` in [`src/awsConfig.ts`](../src/awsConfig.ts):

- stable-stringify `inlinePolicy` objects to canonical JSON text
- map managed-policy attachments directly
- preserve current permission set ARN by `name` match
- keep policy-bearing permission sets name-based at diff time

Recommended canonicalization rule for `inlinePolicy`:

- `undefined` in config -> `null` in state
- otherwise stable-stringify the object with sorted keys before storing it in
  state / operation payloads

## Operation model

Add these operations in [`src/operations.ts`](../src/operations.ts):

- `putIdcPermissionSetInlinePolicy`
- `deleteIdcPermissionSetInlinePolicy`
- `attachIdcManagedPolicyToPermissionSet`
- `detachIdcManagedPolicyFromPermissionSet`
- `attachIdcCustomerManagedPolicyReferenceToPermissionSet`
- `detachIdcCustomerManagedPolicyReferenceFromPermissionSet`
- `provisionIdcPermissionSet`

Recommended payloads:

```ts
{
  kind: "putIdcPermissionSetInlinePolicy";
  permissionSetName: string;
  inlinePolicy: string;
}

{
  kind: "deleteIdcPermissionSetInlinePolicy";
  permissionSetName: string;
}

{
  kind:
    | "attachIdcManagedPolicyToPermissionSet"
    | "detachIdcManagedPolicyFromPermissionSet";
  permissionSetName: string;
  managedPolicyArn: string;
}

{
  kind:
    | "attachIdcCustomerManagedPolicyReferenceToPermissionSet"
    | "detachIdcCustomerManagedPolicyReferenceFromPermissionSet";
  permissionSetName: string;
  customerManagedPolicyName: string;
  customerManagedPolicyPath: string;
}

{
  kind: "provisionIdcPermissionSet";
  permissionSetName: string;
  targetScope: "ALL_PROVISIONED_ACCOUNTS";
}
```

Notes:

- permission set identity stays name-based in the public plan model
- `provisionIdcPermissionSet` is worth modeling explicitly because it is a real
  AWS mutation with visible runtime cost and failure behavior
- resolved ARNs remain apply-time concerns

## Diff strategy

Extend [`src/diff.ts`](../src/diff.ts) with a normalized permission set policy
view keyed by `permissionSetName`.

For each permission set present in both current and next:

- `inlinePolicy: null -> string` or changed string ->
  `putIdcPermissionSetInlinePolicy`
- `inlinePolicy: string -> null` -> `deleteIdcPermissionSetInlinePolicy`
- desired AWS managed policy missing in current ->
  `attachIdcManagedPolicyToPermissionSet`
- current AWS managed policy missing in desired ->
  `detachIdcManagedPolicyFromPermissionSet`
- desired customer-managed reference missing in current ->
  `attachIdcCustomerManagedPolicyReferenceToPermissionSet`
- current customer-managed reference missing in desired ->
  `detachIdcCustomerManagedPolicyReferenceFromPermissionSet`

### Provisioning rule

If any of the above policy operations are emitted for a permission set, also
emit exactly one trailing `provisionIdcPermissionSet` when that permission set
is already provisioned to at least one account.

Recommended detection rule:

- if current state contains at least one account assignment referencing the
  permission set ARN, emit `provisionIdcPermissionSet`
- otherwise skip provisioning and let later assignment grants handle initial
  provisioning naturally

This avoids redundant provisioning noise for new permission sets that are being
created and assigned in the same batch.

## Execution ordering

Extend the internal execution priority in [`src/diff.ts`](../src/diff.ts).

Recommended order:

1. `createOu`
2. `renameOu`
3. `createAccount`
4. `moveAccount`
5. `createIdcUser`
6. `createIdcGroup`
7. `addIdcGroupMembership`
8. `createIdcPermissionSet`
9. `putIdcPermissionSetInlinePolicy`
10. `deleteIdcPermissionSetInlinePolicy`
11. `attachIdcManagedPolicyToPermissionSet`
12. `detachIdcManagedPolicyFromPermissionSet`
13. `attachIdcCustomerManagedPolicyReferenceToPermissionSet`
14. `detachIdcCustomerManagedPolicyReferenceFromPermissionSet`
15. `provisionIdcPermissionSet`
16. `grantIdcAccountAssignment`
17. `removeIdcGroupMembership`
18. `revokeIdcAccountAssignment`
19. `deleteOu`

Why this order:

- new permission sets must exist before policy mutations target them
- policy mutations should complete before same-batch assignment grants
- reprovisioning should happen after the policy mutations for that permission set
- grants still stay ahead of revokes to minimize temporary access loss

## Apply changes

Extend [`src/commands/apply.ts`](../src/commands/apply.ts):

- resolve `permissionSetName` -> `permissionSetArn` from working state
- call the correct SSO Admin policy mutation command
- treat provisioning as part of the planned batch, not as an unplanned side
  effect

Expected AWS SDK commands:

- `PutInlinePolicyToPermissionSetCommand`
- `DeleteInlinePolicyFromPermissionSetCommand`
- `AttachManagedPolicyToPermissionSetCommand`
- `DetachManagedPolicyFromPermissionSetCommand`
- `AttachCustomerManagedPolicyReferenceToPermissionSetCommand`
- `DetachCustomerManagedPolicyReferenceFromPermissionSetCommand`
- `ProvisionPermissionSetCommand`
- `DescribePermissionSetProvisioningStatusCommand`

### Provisioning contract

For `provisionIdcPermissionSet`:

- call `ProvisionPermissionSetCommand`
- use `TargetType: "ALL_PROVISIONED_ACCOUNTS"`
- omit `TargetId`
- poll `DescribePermissionSetProvisioningStatusCommand` until terminal success

The operation should not update working state because provisioning changes live
account-side realization rather than the modeled permission set definition.
Success still matters for batch correctness and partial-failure handling.

## Human-readable output

Extend:

- [`src/commands/plan.ts`](../src/commands/plan.ts)
- [`src/commands/apply.ts`](../src/commands/apply.ts)

Expected example lines:

- `put inline policy on IdC permission set "AdminAccess"`
- `delete inline policy from IdC permission set "AdminAccess"`
- `attach managed policy "arn:aws:iam::aws:policy/ReadOnlyAccess" to IdC permission set "ReadOnly"`
- `detach managed policy "arn:aws:iam::aws:policy/ReadOnlyAccess" from IdC permission set "ReadOnly"`
- `attach customer-managed policy "/beesolve/SupportReadOnly" to IdC permission set "Support"`
- `detach customer-managed policy "/beesolve/SupportReadOnly" from IdC permission set "Support"`
- `provision IdC permission set "Support" to all provisioned accounts`

## Tests

Add focused coverage in:

- [`src/operations.test.ts`](../src/operations.test.ts)
- [`src/awsConfig.test.ts`](../src/awsConfig.test.ts)
- [`src/diff.test.ts`](../src/diff.test.ts)
- [`src/commands/scan.test.ts`](../src/commands/scan.test.ts)
- [`src/commands/plan.test.ts`](../src/commands/plan.test.ts)
- [`src/commands/apply.test.ts`](../src/commands/apply.test.ts)

Recommended scenarios:

1. scan captures inline policy and both attachment kinds
2. state -> config parses inline policy and emits sorted attachments
3. config -> state canonicalizes inline policy JSON deterministically
4. diff emits inline-policy put
5. diff emits inline-policy delete
6. diff emits managed-policy attach/detach
7. diff emits customer-managed attach/detach
8. diff emits exactly one trailing `provisionIdcPermissionSet` per changed,
   already-provisioned permission set
9. apply issues the right AWS commands for each policy mutation
10. apply polls permission set provisioning to terminal success
11. mixed batch: create permission set -> attach policies -> grant assignment
12. partial failure persists successful earlier mutations before a later
    provisioning failure

## Docs and permissions

Update after implementation:

- [`README.md`](../README.md)
- [`docs/phase-6-wave-3-group-membership-plan.md`](./phase-6-wave-3-group-membership-plan.md)
- [`docs/phase-6-wave-5-idc-removal-plan.md`](./phase-6-wave-5-idc-removal-plan.md) as the next planned follow-up
- the remaining v1 backlog doc

Expected IAM permissions:

- scan / init:
  - `sso:GetInlinePolicyForPermissionSet`
  - `sso:ListManagedPoliciesInPermissionSet`
  - `sso:ListCustomerManagedPolicyReferencesInPermissionSet`
- apply:
  - `sso:PutInlinePolicyToPermissionSet`
  - `sso:DeleteInlinePolicyFromPermissionSet`
  - `sso:AttachManagedPolicyToPermissionSet`
  - `sso:DetachManagedPolicyFromPermissionSet`
  - `sso:AttachCustomerManagedPolicyReferenceToPermissionSet`
  - `sso:DetachCustomerManagedPolicyReferenceFromPermissionSet`
  - `sso:ProvisionPermissionSet`
  - `sso:DescribePermissionSetProvisioningStatus`

## Why this should be next

This is the highest-value remaining v1 feature because permission sets are still
only partially useful today:

- the tool can already scan them
- the tool can already author them
- the tool can already create them
- the tool can already assign them
- but it still cannot define what access they actually grant

Compared with the remaining v1 work, this wave:

- closes the biggest functional gap in IAM Identity Center support
- composes directly with the recently shipped group-membership work
- keeps the existing local-first workflow intact
- is safer and narrower than destructive entity removal

## Suggested implementation order

1. Extend the config/state schema for permission set policy state.
2. Add scan support and state/config round-trip coverage.
3. Add operation schemas and diff emission.
4. Add apply execution for policy mutation commands.
5. Add explicit provisioning operation + polling.
6. Update README permissions and supported-scope docs.
