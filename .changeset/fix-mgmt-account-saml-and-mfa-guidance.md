---
"@beesolve/aws-accounts": patch
---

Fix first-time permission-set assignment into the management account failing with `AccessDenied` on `iam:GetSAMLProvider`. The Lambda execution role policy now includes `iam:GetSAMLProvider` (plus the related `iam:GetRole`/`iam:ListRolePolicies`/`iam:ListAttachedRolePolicies`/`iam:ListRoleTags` reads) needed when Identity Center provisions the permission-set role in the management account. Run `upgrade` to reapply the policy on existing deployments.

Add Identity Center sign-in setup guidance to `bootstrap`. Two Console-only settings silently break users created via `aws.config.ts`: MFA enforcement defaults to blocking sign-in for users with no registered device, and API-created users receive no password or invitation email unless "Send email OTP" is enabled. Bootstrap now prints reminders to (1) allow MFA self-registration and enable authenticator apps, and (2) enable "Send email OTP" — neither has an API. Documented an up-front "Before you start: IAM Identity Center setup" prerequisites section and troubleshooting entries for both failure modes in the getting-started guide.
