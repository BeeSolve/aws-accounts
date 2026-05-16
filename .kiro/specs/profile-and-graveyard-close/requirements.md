# Requirements Document

## Introduction

This feature adds two new CLI commands to the `@beesolve/aws-accounts` tool:

1. **`profile`** — Generates AWS CLI profile blocks (`~/.aws/config` format) from account/permission-set assignments in the cached remote state. Phase 1 implements an interactive picker that lists all account/permission-set combinations, lets the user select one, and outputs the corresponding profile block to stdout.

2. **`graveyard close`** — Outputs AWS CLI commands (`aws organizations close-account`) for closing accounts that are parked in the Graveyard OU. This extends the existing `graveyard` command with a `close` subcommand.

## Glossary

- **CLI**: The `@beesolve/aws-accounts` command-line interface invoked via `aws-accounts` or `npm run cli`
- **State_Cache**: The local file `.remote-state-cache.json` containing the last-fetched remote state
- **Context_File**: The `aws.context.json` file containing organization and Identity Center metadata
- **Account_Assignment**: A record in state linking an account ID, permission set ARN, principal ID, and principal type
- **Permission_Set**: A named IAM Identity Center permission set with a unique ARN
- **Profile_Block**: An INI-formatted section for `~/.aws/config` defining an SSO-based AWS CLI profile
- **SSO_Session_Block**: An INI-formatted section for `~/.aws/config` defining the SSO session parameters (start URL, region, scopes)
- **Graveyard_OU**: The organizational unit designated for accounts pending closure, identified by `graveyardOuId` in the Context_File
- **Interactive_Picker**: A terminal-based selection interface that presents numbered options and accepts user input to choose one
- **Profile_Name**: A human-readable identifier for the generated profile, derived from the account name and permission set name

## Requirements

### Requirement 1: Profile Command — Read State and Context

**User Story:** As a developer, I want the `profile` command to load account assignments from the State_Cache and Identity Center metadata from the Context_File, so that it can present available profile combinations.

#### Acceptance Criteria

1. WHEN the `profile` command is invoked, THE CLI SHALL read the State_Cache from `.remote-state-cache.json`
2. WHEN the `profile` command is invoked, THE CLI SHALL read the Context_File from `aws.context.json`
3. IF the State_Cache does not exist, THEN THE CLI SHALL exit with an error message indicating the cache is missing and suggesting a scan or apply command
4. IF the Context_File does not exist, THEN THE CLI SHALL exit with an error message indicating the context file is missing

### Requirement 2: Profile Command — Build Profile Combinations

**User Story:** As a developer, I want the `profile` command to enumerate all account/permission-set combinations from state, so that I can see every available profile option.

#### Acceptance Criteria

1. WHEN the State_Cache is loaded, THE CLI SHALL resolve each Account_Assignment to its account name and permission set name using the state data
2. THE CLI SHALL exclude accounts that are parked in the Graveyard_OU from the profile combinations
3. THE CLI SHALL sort the profile combinations alphabetically by account name, then by permission set name
4. WHEN multiple assignments exist for the same account and permission set pair with different principals, THE CLI SHALL deduplicate them into a single profile combination

### Requirement 3: Profile Command — Interactive Picker

**User Story:** As a developer, I want to select a profile from a numbered list in the terminal, so that I can quickly generate the profile block I need.

#### Acceptance Criteria

1. WHEN profile combinations are available, THE Interactive_Picker SHALL display each combination as a numbered entry showing the account name and permission set name
2. WHEN the user enters a valid number, THE Interactive_Picker SHALL select the corresponding profile combination
3. IF the user enters an invalid number or non-numeric input, THEN THE Interactive_Picker SHALL display an error message and prompt again
4. IF no profile combinations are available, THEN THE CLI SHALL display a message indicating no assignments exist and exit without prompting
5. IF stdin is not a TTY, THEN THE CLI SHALL exit with an error message indicating interactive mode is required

### Requirement 4: Profile Command — Generate Profile Block

**User Story:** As a developer, I want the selected profile combination to produce a valid `~/.aws/config` profile block, so that I can copy it into my AWS configuration.

#### Acceptance Criteria

1. WHEN a profile combination is selected, THE CLI SHALL output a Profile_Block containing `sso_session`, `sso_account_id`, and `sso_role_name` fields
2. WHEN a profile combination is selected, THE CLI SHALL output an SSO_Session_Block containing `sso_start_url`, `sso_region`, and `sso_registration_scopes` fields
3. THE CLI SHALL derive the `sso_start_url` from the Identity Center instance ARN directory identifier in the format `https://<directory-id>.awsapps.com/start`
4. THE CLI SHALL derive the `sso_region` from the Identity Center instance ARN region segment
5. THE CLI SHALL set `sso_registration_scopes` to `sso:account:access`
6. THE CLI SHALL derive the Profile_Name by combining the account name and permission set name in kebab-case format
7. THE CLI SHALL derive the `sso_session` name from the organization context
8. THE CLI SHALL set `sso_role_name` to the permission set name
9. THE CLI SHALL output the profile block to stdout in valid INI format

### Requirement 5: Profile Block Formatting

**User Story:** As a developer, I want the generated profile block to be correctly formatted INI, so that I can paste it directly into `~/.aws/config` without manual editing.

#### Acceptance Criteria

1. THE CLI SHALL format the Profile_Block with the header `[profile <Profile_Name>]`
2. THE CLI SHALL format the SSO_Session_Block with the header `[sso-session <session-name>]`
3. THE CLI SHALL separate the Profile_Block and SSO_Session_Block with a blank line
4. THE CLI SHALL use `key = value` format with a single space around the equals sign for each field
5. THE CLI SHALL output a trailing newline after the final block

### Requirement 6: Profile Block Generation — Pure Function

**User Story:** As a developer, I want the profile block generation logic to be a pure function separate from I/O, so that it can be tested with property-based tests.

#### Acceptance Criteria

1. THE CLI SHALL implement profile block generation as a pure function that accepts an account ID, account name, permission set name, instance ARN, and session name, and returns the formatted profile string
2. FOR ALL valid inputs, generating a profile block SHALL produce output that contains the `[profile ...]` header, `sso_session`, `sso_account_id`, and `sso_role_name` fields
3. FOR ALL valid inputs, generating an SSO session block SHALL produce output that contains the `[sso-session ...]` header, `sso_start_url`, `sso_region`, and `sso_registration_scopes` fields

### Requirement 7: Graveyard Close Command — Output Closure Commands

**User Story:** As a developer, I want the `graveyard close` subcommand to output AWS CLI commands for closing all graveyarded accounts, so that I can execute them to complete the account lifecycle.

#### Acceptance Criteria

1. WHEN `graveyard close` is invoked, THE CLI SHALL read the State_Cache and Context_File
2. WHEN graveyarded accounts exist, THE CLI SHALL output one `aws organizations close-account --account-id <id>` command per graveyarded account
3. THE CLI SHALL sort the closure commands alphabetically by account name
4. IF no accounts are in the Graveyard_OU, THEN THE CLI SHALL display a message indicating no accounts are available for closure
5. IF the State_Cache does not exist, THEN THE CLI SHALL exit with an error message indicating the cache is missing

### Requirement 8: Graveyard Close Command — Filter by Account Status

**User Story:** As a developer, I want the `graveyard close` command to only output closure commands for accounts that are eligible for closure, so that I do not attempt to close already-suspended accounts.

#### Acceptance Criteria

1. THE CLI SHALL only output closure commands for graveyarded accounts with status `ACTIVE`
2. WHEN a graveyarded account has status `SUSPENDED`, THE CLI SHALL skip the account and not output a closure command for it
3. WHEN all graveyarded accounts are already suspended, THE CLI SHALL display a message indicating no accounts are eligible for closure

### Requirement 9: Graveyard Command — Subcommand Routing

**User Story:** As a developer, I want the existing `graveyard` command to support subcommands, so that `graveyard` (no args) lists accounts and `graveyard close` outputs closure commands.

#### Acceptance Criteria

1. WHEN `graveyard` is invoked without a subcommand, THE CLI SHALL behave identically to the current implementation (list graveyarded accounts)
2. WHEN `graveyard close` is invoked, THE CLI SHALL execute the closure command generation logic
3. IF an unknown subcommand is provided to `graveyard`, THEN THE CLI SHALL exit with an error message listing valid subcommands
