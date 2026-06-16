---
"@beesolve/aws-accounts": patch
---

Fix false drift for permission sets with optional fields (inlinePolicy, sessionDuration, permissionsBoundary) by treating undefined values as absent keys.
