# Getting Started

This guide covers two paths to getting started with `@beesolve/aws-accounts`.

## Before you start: IAM Identity Center setup

`@beesolve/aws-accounts` manages users, groups, permission sets, and assignments
through the IAM Identity Center APIs. A few Identity Center settings are
**Console-only** — there is no public API (nor CloudFormation/Terraform resource)
to change them, so this tool cannot set them for you. Configure these **once**,
up front, or newly created users will be unable to sign in.

All three live in the management account under **IAM Identity Center → Settings**
(region-specific — use the region where Identity Center is enabled).

1. **Enable Identity Center with the built-in directory.**
   Under **Settings**, enable Identity Center and keep the default identity source
   ("Identity Center directory") unless you use an external IdP. `bootstrap` guides
   you through this and waits for you to finish.

2. **Let users self-register MFA (don't block them).**
   **Settings → Authentication → Multi-factor authentication → Configure** → set
   "If a user does not yet have a registered MFA device" to **"Require them to
   register an MFA device at sign-in"** (the default _blocks_ sign-in instead).
   Also confirm **Authenticator apps (TOTP)** is enabled under "Users can
   authenticate with these MFA types", otherwise a new user has no device type they
   are allowed to self-enroll.

3. **Email a one-time password to users created via API/CLI.**
   **Settings → Standard authentication → Configure** → check **"Send email OTP"** →
   **Save** (status flips from Disabled to Enabled). This tool creates users through
   the `CreateUser` API, which does **not** set a password or send an invitation on
   its own. With this setting on, every user the tool creates is automatically
   emailed a one-time password to onboard themselves — they set their password and,
   thanks to step 2, self-enroll their MFA device. No per-user admin action needed.

> Why these are manual: the same way Identity Center _enablement_ has no
> org-level API, the MFA-enforcement mode and the "Send email OTP" toggle are not
> exposed by the `sso-admin`/`identitystore` APIs. `bootstrap` prints reminders for
> all three rather than pretending to automate them.

## Path A: Starting from Scratch (New AWS Account)

If you don't have an AWS account yet:

1. **Create an AWS account** at https://portal.aws.amazon.com/billing/signup
2. **Set up credentials** — create an IAM user with admin access or configure SSO. See [AWS docs on configuring credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html).

Once you have an account with credentials configured:

### 1. Create your project

```bash
mkdir my-org && cd my-org
npm init -y
npm pkg set type=module
npm install @beesolve/aws-accounts typescript
```

### 2. Initialize git

```bash
git init
echo -e "node_modules/\n.remote-state-cache.json" > .gitignore
```

### 3. Bootstrap

```bash
npx aws-accounts bootstrap --region eu-central-1
```

The CLI will guide you through:

- **Organization creation** — detects no Organization exists and offers to create one with all features enabled. If you already have an Organization with only consolidated billing, it will tell you how to enable all features.
- **Identity Center setup** — detects Identity Center is not enabled and provides:
  - A direct Console URL for your region
  - Step-by-step instructions to click "Enable"
  - Guidance to keep the default "Identity Center directory" identity source
  - Reminders for the two Console-only sign-in settings (MFA self-registration
    and "Send email OTP") — see [Before you start](#before-you-start-iam-identity-center-setup)
  - A polling loop that waits for you to complete the Console action
- **Infrastructure deployment** — creates the S3 state bucket, IAM role, and Lambda function

> **Configure the Console-only sign-in settings first.** By default Identity
> Center _blocks_ sign-in for users with no MFA device, and API-created users get
> no password or invitation email — so a user added via `aws.config.ts` cannot log
> in until you enable MFA self-registration and "Send email OTP". These are
> Console-only and covered in
> [Before you start](#before-you-start-iam-identity-center-setup); `bootstrap`
> prints reminders but cannot set them for you.

### 4. Scan and generate config

```bash
npx aws-accounts init
```

This scans your (currently empty) org and generates:

- `aws.config.ts` — your editable source of truth
- `aws.config.types.ts` — generated types for IDE autocomplete

### 5. Define your desired state

Edit `aws.config.ts` to add organizational units, accounts, users, groups, and permission sets. Example:

```ts
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

const awsConfig: AwsConfig = {
  organizationalUnits: [
    { name: "Production", parentName: "root" },
    { name: "Development", parentName: "root" },
  ],
  accounts: [
    { name: "prod-app", email: "aws+prod@example.com", parentName: "Production" },
    { name: "dev-app", email: "aws+dev@example.com", parentName: "Development" },
  ],
  users: [{ userName: "admin", displayName: "Admin User", email: "admin@example.com" }],
  groups: [{ displayName: "Admins", description: "Full access", members: ["admin"] }],
  permissionSets: [
    {
      name: "AdminAccess",
      description: "Full administrator access",
      sessionDuration: "PT8H",
      awsManagedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"],
      customerManagedPolicies: [],
    },
  ],
  accountAssignments: [
    { target: "prod-app", permissionSet: "AdminAccess", group: "Admins" },
    { target: "dev-app", permissionSet: "AdminAccess", group: "Admins" },
  ],
};

export default awsConfig;
```

### 6. Preview and apply

```bash
npx aws-accounts plan      # see what will change
npx aws-accounts apply     # execute the changes
```

---

## Path B: Existing Organization

If you already have an AWS Organization with Identity Center enabled:

### Prerequisites

- AWS Organization with **all features** enabled
- IAM Identity Center enabled (any region)
- AWS credentials with access to the **management account**
- Node.js 24+

### 1. Create your project

```bash
mkdir my-org && cd my-org
npm init -y
npm pkg set type=module
npm install @beesolve/aws-accounts typescript
git init
echo -e "node_modules/\n.remote-state-cache.json" > .gitignore
```

### 2. Bootstrap

```bash
npx aws-accounts bootstrap --region us-east-1
```

This deploys the remote infrastructure (S3 bucket, IAM role, Lambda). It detects your existing Organization and Identity Center and skips the setup prompts.

### 3. Import your existing state

```bash
npx aws-accounts init
```

This scans your entire org — OUs, accounts, users, groups, permission sets, assignments, policies — and generates `aws.config.ts` reflecting your current state.

### 4. Make changes

Edit `aws.config.ts` to add, modify, or remove resources. Run `regenerate` after editing to refresh IDE autocomplete:

```bash
npx aws-accounts regenerate
```

### 5. Preview and apply

```bash
npx aws-accounts plan
npx aws-accounts apply
```

---

## Day-to-Day Workflow

Once set up, the workflow is:

1. Edit `aws.config.ts`
2. Run `validate` to catch mistakes locally
3. Run `plan` to preview changes
4. Run `apply` to execute
5. Commit your changes to git

### Useful commands

- `npx aws-accounts drift` — check if someone made changes in the Console
- `npx aws-accounts profile --sso-start-url <url>` — generate AWS CLI SSO profiles
- `npx aws-accounts validate` — local config validation (safe for CI)

---

## Troubleshooting

### "account concurrency quota too low"

New AWS accounts start with a Lambda concurrency quota of 10. The tool tries to reserve 1 concurrent execution for safety but this fails on fresh accounts. This is non-blocking — the tool works fine without it. AWS auto-raises the quota over time, or you can request an increase at:

https://console.aws.amazon.com/servicequotas/home/services/lambda/quotas/L-B99A9384

Run `upgrade` afterward to apply the reservation.

### "all features" not enabled

If your org only has consolidated billing, enable all features:
https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_org_support-all-features.html

### Identity Center in a different region

Identity Center is region-specific. Use `--region` to match the region where you enabled it.

### A user created via `aws.config.ts` never receives a password / cannot start sign-in

The tool creates users with the `CreateUser` API, which does **not** set a
password or send an invitation email. If **"Send email OTP"** is not enabled in
Identity Center, a config-created user lands in limbo — no password, no email, no
self-service path — and the "reset password" flow dead-ends.

Fix:

- Enable it once for the whole directory: **IAM Identity Center → Settings →
  Standard authentication → Configure → check "Send email OTP" → Save**. New users
  the tool creates from then on are automatically emailed a one-time password to
  onboard (and, with MFA self-registration on, self-enroll their MFA device). This
  is a Console-only setting — no API/CloudFormation/Terraform equivalent.
- For a user that was created **before** you enabled the setting: trigger the email
  manually via **Users → _user_ → Reset password → "Send an email to the user with
  instructions"**, or delete and recreate the user so the create-time email fires.

### New user cannot sign in: "You are required to provide multi-factor authentication (MFA) that you do not have"

Identity Center's default MFA mode _blocks_ sign-in for users who have no
registered MFA device. A newly created user then hits a chicken-and-egg: they
can't register a device without signing in, and can't sign in without a device.
The self-service "reset password" flow dead-ends on the same MFA gate.

Fix it as the administrator (this cannot be self-serviced by the affected user):

- **Recommended (one-time, fixes it for all future users):** In **IAM Identity
  Center → Settings → Authentication → Multi-factor authentication → Configure**,
  set "If a user does not yet have a registered MFA device" to **"Require them to
  register an MFA device at sign-in"**, and make sure **Authenticator apps (TOTP)**
  is enabled under "Users can authenticate with these MFA types". New users then
  enroll a device during first sign-in. These are Console-only settings — there is
  no API, CloudFormation, or Terraform resource for them.
- If a user only has the "block" behavior and TOTP is disabled, self-registration
  still fails with this exact error because there is no permitted device type to
  enroll — enabling authenticator apps resolves it.

Note: headless/automation identities (e.g. an LLM agent) cannot complete an
interactive MFA prompt. Don't rely on an interactive SSO human-login user for
automation — assume a dedicated role non-interactively instead.

### First management-account assignment fails: AccessDenied on `iam:GetSAMLProvider`

Granting a permission set to an account for the _first time_ makes Identity
Center provision an IAM role whose trust policy references the SSO SAML provider.
For the **management account** specifically, that provider lives in-account and
the tool's Lambda role must read it. If you bootstrapped with a version before
this permission was added, the first management-account assignment fails with:

```
... is not authorized to perform: iam:GetSAMLProvider on resource:
arn:aws:iam::<mgmt-account>:saml-provider/AWSSSO_..._DO_NOT_DELETE
```

and `apply` stops with partial state. Fix by running `upgrade` (which reapplies
the Lambda role policy, now including `iam:GetSAMLProvider`), then re-sync:

```bash
npx aws-accounts upgrade
npx aws-accounts scan --refresh
npx aws-accounts plan
npx aws-accounts apply
```

As a security best practice, keep the management account nearly empty: assign
only a break-glass admin permission set there (plus, optionally, a read-only
auditor). Never assign day-to-day developer or automation/agent permission sets
to the management account.
