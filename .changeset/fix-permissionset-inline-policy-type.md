---
"@beesolve/aws-accounts": patch
---

Fix `policies.permissionSet.*` helpers to use `IamPolicyDocument` type instead of `Record<string, unknown>` so they're compatible with the `AwsConfig` schema.
