---
"@beesolve/aws-accounts": minor
---

Remove `aws.config.generated.ts` intermediary — `init` now writes directly to `aws.config.ts`. The `--update` flag is removed since the `drift` command replaces that workflow.
