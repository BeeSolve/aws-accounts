# Phase 6 Wave 6: IAM Identity Center metadata updates (shipped)

This wave adds **non-destructive** reconciliation for IdC metadata that can be
edited in `aws.config.ts` after entities already exist in AWS.

Execution model is unchanged from earlier v1 waves: local `plan`, direct SDK
`apply`, `state.json` as persisted actual state.

> **Note:** The local execution model described in this document was subsequently removed in favor of remote-only execution. See [docs/adr/001-remove-local-execution-model.md](adr/001-remove-local-execution-model.md).

## Supported updates

| Entity | Config fields | AWS API |
| --- | --- | --- |
| User | `displayName`, `email` | `identitystore:UpdateUser` |
| Group | `description` | `identitystore:UpdateGroup` |
| Permission set | `description` | `sso:UpdatePermissionSet` |

New groups may include an optional `description` on `createIdcGroup`; empty
strings omit `Description` on create (same pattern as permission sets).

## Diff and apply rules

- **Users:** `updateIdcUser` is emitted when `displayName` changes, or when
  `email` changes **and** the desired email is non-empty. Clearing email in
  config without a replacement does **not** produce an update operation (no
  dedicated “clear email” path in this increment).
- **Users (apply):** `UpdateUser` sends `displayName`, structured `name` (same
  helper as create), and a single primary Work `emails` entry when the email
  branch applies.
- **Groups:** description changes emit `updateIdcGroupDescription`.
- **Permission sets:** description changes emit `updateIdcPermissionSetDescription`.
  If the permission set has **desired** account assignments in config, the plan
  also includes `provisionIdcPermissionSet` (same gate as policy mutations).

## IAM permissions

Apply roles need `identitystore:UpdateUser`, `identitystore:UpdateGroup`, and
`sso:UpdatePermissionSet` in addition to existing IdC apply actions. See
`README.md` inline policy example.

## Verification

Runtime behavior of Identity Store `UpdateUser` attribute paths (`name`,
`emails`) should be validated in a real directory if anything diverges from
expectations; SDK typings are permissive.

## References

- Backlog after this wave: `docs/v1-backlog-priority.md`
- Prior removal wave: `docs/phase-6-wave-5-idc-removal-plan.md`
