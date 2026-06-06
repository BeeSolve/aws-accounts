---
"@beesolve/aws-accounts": minor
---

Add reusable SCP pattern builders via `@beesolve/aws-accounts/policies` sub-path export. First pattern: `scp.blockExpensiveResources()` — generates a deny-by-default SCP that blocks Bedrock, GPU/accelerator EC2 instances, SageMaker, ECS, and expensive purchases, with per-account exemptions.
