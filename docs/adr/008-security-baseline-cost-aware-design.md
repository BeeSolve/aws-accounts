# ADR 008: Security Baseline Cost-Aware Design

## Status

Accepted

## Context

The `withSecurityBaseline()` wrapper enables AWS security services across an organization. Initial implementation enabled services in an all-or-nothing fashion per feature, which meant adding a few lines of config could silently incur significant monthly costs:

- AWS Config: $12–90/mo (configuration item recording)
- GuardDuty: $42–100/mo (event analysis)
- CloudTrail org trail: $1–10/mo (S3 storage)

Users expected to understand costs before enabling features, and needed the ability to enable/disable each independently. Some features have free tiers (CloudTrail event history, delegated admin registration) that provide value without cost.

## Decision

### 1. Every feature is independently opt-in

Each section in `SecurityBaselineOptions` uses a discriminated union:

```ts
cloudTrail?: { enabled: false } | { enabled: true; delegatedAdminAccount: A; ... }
```

Setting `enabled: false` (or omitting the section) incurs zero cost and requires no other fields.

### 2. Separate free operations from paid resources

Features that have both free and paid components expose them separately:

- `cloudTrail.enabled: true` → registers delegated admin only (free)
- `cloudTrail.orgTrail: true` → creates S3 bucket + organization trail ($1–10/mo)
- `configRecorder.enabled: true` → deploys recorders ($12–90/mo, no free tier)
- `guardDuty.enabled: true` → deploys detectors ($42–100/mo after 30-day trial)

This prevents surprise costs from what appears to be a simple boolean toggle.

### 3. SCP protection is independent and selective

The `protectSecurityServices` SCP helper accepts a `protect` option:

```ts
policies.scp.protectSecurityServices({
  protect: { cloudTrail: true, config: true, guardDuty: false },
});
```

This allows disabling protection for a specific service before teardown without removing all protections. The SCP must protect at least one service (empty SCPs are rejected by AWS).

### 4. StackSet teardown is manual

Disabling a feature (`enabled: false`) stops the tool from deploying new StackSet instances and deregisters delegated admins, but does NOT automatically delete existing StackSet instances. This is intentional:

- Automatic deletion of security infrastructure is dangerous
- Some resources (detectors, recorders) may have data retention requirements
- The user should explicitly confirm resource removal

Documentation provides step-by-step teardown procedures per feature.

### 5. Cost table in documentation

The README and per-feature docs include cost estimates for a ~20-account organization so users can make informed decisions before enabling features.

## Consequences

- Users can start with zero-cost features (CloudTrail delegation, SCPs, root access management) and add paid features incrementally
- No surprise costs from enabling the security baseline
- Slightly more complex config schema (discriminated unions) but better IDE autocomplete (only shows relevant fields when `enabled: true`)
- Manual teardown required when disabling features — documented but not automated
