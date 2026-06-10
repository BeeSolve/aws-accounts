# Resource Cleanup & Destroy Plan

## Phase 1: Manual Cleanup — IMPLEMENTED ✓

All resources are tagged with `ManagedBy = beesolve-aws-accounts`. Explicit log group created with configurable retention. README has manual deletion guide with security implications.

---

## Phase 2: `destroy` command (future)

### Behavior

```
npx aws-accounts destroy [--keep-security-services] [--force]
```

Default: removes tool infrastructure only (Lambda, role, bucket, log group, StackSets).
With no flags: prompts for confirmation listing what will be deleted.
`--keep-security-services`: leaves Config/GuardDuty StackSets and their resources in place.
`--force`: skip confirmation prompt.

### Deletion order

1. Delete StackSet instances (all 3) — waits for completion
2. Delete StackSets themselves
3. Empty + delete Config delivery S3 bucket
4. Deregister delegated administrators
5. Detach + delete SCPs
6. Empty + delete state S3 bucket
7. Delete CloudWatch log group
8. Delete Lambda function
9. Delete Lambda execution role
10. Delete `aws.context.json` locally

### Considerations

- StackSet instance deletion is async (can take minutes per account)
- S3 buckets must be emptied before deletion (versioned buckets need DeleteObjectVersions)
- Delegated admin deregistration may fail if services still depend on it
- Some resources may have been manually modified — warn if tags don't match expected state
