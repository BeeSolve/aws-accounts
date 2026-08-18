---
"@beesolve/aws-accounts": patch
---

Fix scpCollection subpath export by generating .d.ts declarations. Wire `scps` export into the generated `aws.config.types.ts` template for typed OU/account autocompletion. Fix `logGroupArn` property access in `ensureLogGroup` (was incorrectly using `arn`).
