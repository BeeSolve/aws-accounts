# Security Baseline UX Improvements

## Problem

1. `protectSecurityServices` SCP is all-or-nothing — you can't selectively protect only CloudTrail + Config while leaving GuardDuty unprotected (needed to tear it down cleanly).
2. `SecurityBaselineOptions` requires `delegatedAdminAccount` even when `enabled: false`, which is confusing and unnecessary.
3. No documentation on per-service cost breakdown or how to enable/disable each feature independently.

## Tasks

### Task 1: Add `protect` option to `protectSecurityServices` SCP

**File:** `src/security.ts`

Add an optional `protect` config to `ProtectSecurityServicesOptions`:

```ts
type ProtectSecurityServicesOptions<T extends string, A extends string> = {
  exemptAccounts?: A[];
  targets?: T[];
  name?: string;
  protect?: {
    cloudTrail?: boolean;
    config?: boolean;
    guardDuty?: boolean;
  };
};
```

- When `protect` is omitted, all three are protected (current default behavior).
- When provided, only include SCP statements for services set to `true`.
- Example: `policies.scp.protectSecurityServices({ protect: { cloudTrail: true, config: true, guardDuty: false } })` — generates SCP without the GuardDuty deny statements.

Implementation: filter the `statements` array based on `protect` values before constructing the policy. Default each to `true` when not specified.

Update existing tests to cover the new option.

### Task 2: Make `delegatedAdminAccount` conditional on `enabled: true` in `SecurityBaselineOptions`

**File:** `src/security.ts`

Change the type so `delegatedAdminAccount` (and other service-specific fields) are only required when `enabled: true`. Use discriminated unions:

```ts
guardDuty?:
  | { enabled: false }
  | {
      enabled: true;
      delegatedAdminAccount: A;
      targets?: T[];
      findingPublishingFrequency?: "FIFTEEN_MINUTES" | "ONE_HOUR" | "SIX_HOURS";
    };
```

Apply the same pattern to:

- `cloudTrail`: `delegatedAdminAccount` and `logArchiveAccount` only when `enabled: true`
- `configRecorder`: `delegatedAdminAccount`, `deliveryBucketAccount`, `targets` only when `enabled: true`
- `rootAccessManagement`: `delegatedAdminAccount` only when `enabled: true`

Update `toSecurityBaseline` to check `enabled` before accessing service-specific fields. Existing configs with `enabled: true` continue to work unchanged.

Update existing tests and add tests for `enabled: false` variants (should pass with no extra fields).

### Task 3: Add security baseline cost and configuration documentation to README

**File:** `README.md`

Add a new section "## Security Baseline Cost Estimate" after the existing Security Baseline section, covering:

**Cost breakdown table (~20 accounts, eu-central-1):**

| Service    | What drives cost                              | Idle accounts  | Active accounts  |
| ---------- | --------------------------------------------- | -------------- | ---------------- |
| AWS Config | $0.003/configuration item                     | ~$12/mo        | ~$30–90/mo       |
| GuardDuty  | CloudTrail events, VPC Flow Logs, DNS queries | ~$20–40/mo     | ~$50–100/mo      |
| CloudTrail | S3 storage (management trail free)            | ~$2–5/mo       | ~$10–30/mo       |
| S3 storage | Snapshots + logs                              | ~$1–3/mo       | ~$3–10/mo        |
| **Total**  |                                               | **~$35–50/mo** | **~$100–230/mo** |

Note: link to AWS Pricing Calculator for precise estimates.

**Per-service enable/disable guide:**

Document how to enable/disable each feature independently:

```ts
withSecurityBaseline(config, {
  cloudTrail: { enabled: false }, // disable CloudTrail delegation
  configRecorder: { enabled: false }, // disable Config recorders
  guardDuty: { enabled: false }, // disable GuardDuty
  rootAccessManagement: { enabled: false }, // disable root access mgmt
});
```

Document the teardown procedure for each service (what manual steps are needed after disabling):

- **GuardDuty**: remove `ProtectGuardDuty` from SCP (or set `protect.guardDuty: false`), apply, then delete StackSet instances + StackSet
- **Config**: remove `ProtectConfig` from SCP, apply, then delete StackSet instances + StackSet + delivery bucket
- **CloudTrail**: deregister delegated admin (done by apply), optionally delete org trail manually

Document that `--redeploy-stacksets` forces re-deployment when templates change.

Document the `protectSecurityServices` `protect` option for selective protection.

### Task 4: Update `protectSecurityServices` test coverage

**File:** `src/security.test.ts`

Add tests:

- Default behavior (all protected) still works
- `protect: { cloudTrail: true, config: true, guardDuty: false }` — only 2 statements
- `protect: { guardDuty: true }` — only GuardDuty statement
- `protect: {}` — all default to true (same as omitting)
- Empty `protect` with all false — no statements / empty policy (edge case: decide behavior)

### Task 5: Update generated types to use discriminated union schema

**File:** `src/awsConfig.ts`

The `withSecurityBaseline` function exported in the generated types file needs to accept the updated `SecurityBaselineOptions` type with discriminated unions. Since `SecurityBaselineOptions` is imported from `@beesolve/aws-accounts/security`, this should propagate automatically. Verify that `regenerate` produces correct autocomplete with the new types.

Test: run `regenerate` on a sample project and verify IDE autocomplete shows `delegatedAdminAccount` only when `enabled: true`.
