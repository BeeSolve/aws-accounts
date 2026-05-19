---
"@beesolve/aws-accounts": patch
---

Fix regenerate crashing when account or OU names have been renamed in aws.config.ts. The generated config file no longer validates itself against the stale types schema at load time; validation happens in the CLI command instead.
