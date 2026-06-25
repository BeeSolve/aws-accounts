# Plan: Local Testing Playground + Onboarding for Fresh AWS Accounts

## Problem Statement

New users with a fresh AWS account hit a wall: `bootstrap` assumes an Organization and Identity Center already exist. The tool provides no guidance. Additionally, there's no easy way to test the CLI locally during development without publishing to npm.

## Requirements

1. A gitignored `playground/` folder inside the repo where you can run the locally-built CLI against a real AWS account without npm publish cycles.
2. `bootstrap` detects whether an AWS Organization exists; if not, offers to create one automatically.
3. `bootstrap` detects whether IAM Identity Center is enabled; if not, prints clear instructions with a Console URL and waits for the user to complete the manual step before continuing.
4. If a user doesn't want Identity Center with the AWS-managed identity source (or wants a different provider), print guidance/links but don't block — just exit gracefully with next-steps info.

## Background

- `CreateOrganization` API fully supports programmatic org creation with "all features."
- `CreateInstance` API only works for standalone (non-org) accounts. Organization-level Identity Center **must** be enabled via the AWS Console — there is no API.
- The existing `scanLogic.ts` already calls `ListInstances` and throws if empty. The existing `bootstrap` in `remote.ts` does not check for org or IdC prerequisites at all.

## Tasks

### Task 1: Playground folder

- Add `playground/` to `.gitignore`
- Create `playground/run.sh` — builds parent project, forwards args to `node ../dist/cli.js`
- Create `playground/.gitignore` for generated files
- Create `playground/README.md`

### Task 2: Organization detection and creation in bootstrap

- Add `OrganizationsClient` to `RemoteCommandInput` and `cli.ts`
- At start of `runRemoteBootstrap`, call `DescribeOrganization`
- Catch `AWSOrganizationsNotInUseException` → prompt → `CreateOrganization({ FeatureSet: "ALL" })`
- If `CONSOLIDATED_BILLING` feature set → error with docs link

### Task 3: Identity Center detection and guided setup

- After org check, call `ListInstances` via `input.ssoAdminClient`
- If empty: print Console URL, prompt user to enable manually, poll until detected
- Non-TTY: print instructions and exit with non-zero code
- If user declines: provide docs links and exit gracefully

### Task 4: Verify

- `npm run build` succeeds
- `npm test` passes
- `./playground/run.sh --help` works
