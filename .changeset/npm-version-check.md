---
"@beesolve/aws-accounts": patch
---

Add TTL-gated npm registry version check on CLI start. When a newer version of @beesolve/aws-accounts is available, a one-line upgrade notice is printed at most once per 24 hours.
