# Auto-create Org Trail + Fix CloudTrailAnalyst + Split Docs

## Design Decisions

### Org trail is optional

`cloudTrail.enabled: true` only registers the delegated admin (free). A new optional field `cloudTrail.orgTrail: true` triggers the actual S3 bucket + org trail creation ($1–10/mo). This way users get CloudTrail console access across accounts for free and only pay for long-term log storage if they explicitly opt in.

### Bucket location for CloudTrail logs

**Use LogArchive account** — same pattern as Config delivery bucket. The `logArchiveAccount` field already exists in the CloudTrail config. We'll create a `cloudtrail-logs-{orgId}-{region}` bucket in LogArchive with a policy allowing `cloudtrail.amazonaws.com` to deliver logs.

### Trail creation approach

The org trail is created from the **management account** Lambda directly (no assume-role needed). The Lambda already has org permissions. The bucket is in LogArchive (created via assume-role into `BeesolveSecuritySetupRole`).

### Doc structure

Split the Security Baseline section from README into `docs/security-baseline.md` with sub-sections per feature. Keep README concise with a link to the full guide.

## Tasks

### Task 1: Add `createCloudTrailBucket` Lambda handler

**File:** `src/lambda/handler.ts`

New handler that assumes into `BeesolveSecuritySetupRole` in LogArchive, creates bucket `cloudtrail-logs-{orgId}-{region}` with policy allowing `cloudtrail.amazonaws.com` PutObject.

Schema: `{ action: "createCloudTrailBucket", targetAccountId, bucketName, region, organizationId }`
Response: `{ action: "createCloudTrailBucket", success: true, bucketName, created: boolean }`

The bucket policy should allow:

- `cloudtrail.amazonaws.com` → `s3:GetBucketAcl` and `s3:PutObject`
- Condition: `aws:SourceOrgID` = org ID

### Task 2: Add `createOrgTrail` Lambda handler

**File:** `src/lambda/handler.ts`

New handler that creates an organization trail from the management account (Lambda's own identity). No assume-role needed.

Uses `CloudTrailClient` → `CreateTrailCommand` with:

- `Name`: `organization-trail`
- `S3BucketName`: the bucket created in Task 1
- `IsOrganizationTrail`: true
- `IsMultiRegionTrail`: true
- `EnableLogFileValidation`: true

Then calls `StartLoggingCommand` to activate it.

If trail already exists (`TrailAlreadyExistsException`), call `UpdateTrail` to ensure config matches, then return success.

Schema: `{ action: "createOrgTrail", bucketName, region }`
Response: `{ action: "createOrgTrail", success: true, trailArn: string, created: boolean }`

### Task 3: Add CloudTrail permissions to Lambda role

**File:** `src/commands/remote.ts` (in `applyLambdaRolePolicy`)

Add to the Lambda role policy:

- `cloudtrail:CreateTrail`
- `cloudtrail:UpdateTrail`
- `cloudtrail:StartLogging`
- `cloudtrail:DescribeTrails`
- `cloudtrail:GetTrailStatus`

### Task 4: Add CloudTrail bucket policy to `BeesolveSecuritySetupRole`

**File:** `templates/security-setup.yaml`

Add a statement allowing:

- `s3:CreateBucket`, `s3:PutBucketPolicy`, `s3:PutBucketPublicAccessBlock`, `s3:PutBucketTagging`
- Resource: `arn:aws:s3:::cloudtrail-logs-*`

Actually — the `ConfigBucket` statement already scopes to `${BucketName}`. We need a separate resource or to parameterize. Since the StackSet targets the Security OU (where LogArchive lives), we can add a new parameter for the CloudTrail bucket name, OR use a wildcard. Let's add a `CloudTrailBucketName` parameter.

Wait — actually the existing template already has a `BucketName` parameter for Config. The LogArchive account gets both Config and CloudTrail buckets. Simplest: widen the `ConfigBucket` Sid to allow both bucket names, or add a second parameter + statement.

**Better approach:** Add a `CloudTrailBucketName` parameter (optional, default empty string), and a conditional statement. Actually CloudFormation conditions with StackSets are complex. Simpler: just use a wildcard prefix for beesolve-managed buckets, or pass both bucket names.

**Simplest:** change `BucketName` parameter to a comma-separated list, or add a second parameter. Let's add `CloudTrailBucketName` parameter and a second S3 statement.

### Task 5: Wire up trail creation in `remote.ts` apply flow

**File:** `src/commands/remote.ts`

After bucket/aggregator creation (inside the StackSet operations block), add:

1. Create CloudTrail log bucket (if `cloudTrail.enabled` and LogArchive account exists)
2. Create org trail (if bucket created successfully)

### Task 6: Update `SecurityBaselineExtension` and `toSecurityBaseline`

**File:** `src/security.ts`

Add `orgTrail?: boolean` to the CloudTrail enabled variant:

```ts
cloudTrail?:
  | { enabled: false }
  | { enabled: true; delegatedAdminAccount: A; logArchiveAccount: A; orgTrail?: boolean };
```

Add to `SecurityBaselineExtension`:

```ts
cloudTrailBucket?: {
  accountName: string;
};
```

In `toSecurityBaseline`, when `cloudTrail.enabled && cloudTrail.orgTrail`, set `cloudTrailBucket: { accountName: cloudTrail.logArchiveAccount }`.

The delegated admin registration always happens when `enabled: true`. The bucket/trail only happen when `orgTrail: true`.

### Task 7: Fix CloudTrailAnalyst permission set

**File:** `src/security.ts`

Add `config:Describe*` to the CloudTrailAnalyst inline policy (the CloudTrail console needs it).

### Task 8: Split README — create `docs/security-baseline.md`

Move the Security Baseline section from README into `docs/security-baseline.md` with:

- Overview
- Per-feature setup guide (CloudTrail, Config, GuardDuty)
- Cost estimation
- Disabling features
- Troubleshooting

Keep a short summary + link in README.

### Task 9: Update `lambdaClient.ts` schemas

Add request/response schemas for `createCloudTrailBucket` and `createOrgTrail`.

### Task 10: Add `security-setup.yaml` CloudTrail bucket parameter

Add `CloudTrailBucketName` parameter and S3 permission statement.

Update `toSecurityBaseline` to pass the CloudTrail bucket name parameter to the security-setup StackSet when CloudTrail is enabled.
