# How to: Compose Service Control Policies

> Full source: https://github.com/BeeSolve/aws-accounts/tree/main/src/scpCollection.ts

The `./scpCollection` subpath exports a factory of reusable, production-ready Service Control Policy builders organized by OU category. Each builder returns a `PolicyEntry<T>` you can place directly in your config's `serviceControlPolicies` array.

## Prerequisites

- `@beesolve/aws-accounts` installed as a dependency

## Steps

### 1. Install

```sh
npm install @beesolve/aws-accounts
```

### 2. Create the collection

`toScpCollection<T, A>()` is generic over your OU/account target names (`T`) and account names (`A`). In a managed project the generated `aws.config.types.ts` wires these for you via its `scps` export; outside one, parameterize them yourself.

```ts
import { toScpCollection } from "@beesolve/aws-accounts/scpCollection";

const scps = toScpCollection<string, string>();
```

### 3. Build policies

Builders are grouped into `foundation`, `security`, `production`, `development`, `sandbox`, `suspended`, `infrastructure`, and `modern`. All accept optional `targets` (defaults to `["root"]`) and `name`.

```ts
const policies = [
  scps.foundation.denyRootUser(),
  scps.foundation.denyUnsupportedRegions({
    allowedRegions: ["eu-central-1", "us-east-1"],
  }),
  scps.foundation.preventLeavingOrganization(),
  scps.production.enforceEncryption({ targets: ["Production"] }),
  scps.suspended.completeLockdown({
    exemptRoles: ["arn:aws:iam::*:role/OrganizationAdmin"],
    targets: ["Suspended"],
  }),
];
```

### 4. (Optional) Build a raw policy document

For custom statements, `buildPolicyDocument` and `buildExemptRolesCondition` are exported directly.

```ts
import {
  buildPolicyDocument,
  buildExemptRolesCondition,
} from "@beesolve/aws-accounts/scpCollection";

const condition = buildExemptRolesCondition(["arn:aws:iam::*:role/Admin"]);
const document = buildPolicyDocument([
  { Sid: "DenyLeave", Effect: "Deny", Action: "organizations:LeaveOrganization", Resource: "*" },
]);
```

## Common Pitfalls

- Several builders throw on empty required arrays - e.g. `denyUnsupportedRegions` (`allowedRegions`), `protectPasswordPolicy` and `completeLockdown` (`exemptRoles`), `enforceDataPerimeter` (`organizationId`).
- `buildExemptRolesCondition` returns `undefined` for an empty array; guard before spreading it into a statement.
- AWS caps SCP documents at 5,120 characters; verify generated JSON when passing large arrays.

## See Also

- `PolicyEntry` and `ScpCollection` types are exported from `./scpCollection`.
- [Getting Started](./getting-started.md) - wire policies into `aws.config.ts` and apply them.
