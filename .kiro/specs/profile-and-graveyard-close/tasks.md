# Implementation Plan: Profile and Graveyard Close

## Overview

Add two CLI capabilities: a `profile` command with interactive picker for generating AWS CLI profile blocks from cached state, and a `graveyard close` subcommand that outputs account closure commands for eligible graveyarded accounts. Both commands are local-only and operate on the cached state file.

## Tasks

- [x] 1. Create profile command module with types and pure functions
  - [x] 1.1 Create `src/commands/profile.ts` with types and pure functions
    - Define `ProfileCombination`, `ProfileBlockInput`, `ProfileCommandInput` types
    - Implement `toKebabCase` — converts account/permission-set names to kebab-case
    - Implement `deriveStartUrl` — constructs `https://<identityStoreId>.awsapps.com/start`
    - Implement `deriveSsoRegion` — extracts region from instance ARN or context
    - Implement `deriveSessionName` — produces `beesolve-<identityStoreId>` format
    - Implement `generateProfileBlock` — pure function producing INI-formatted profile + session blocks
    - Implement `buildProfileCombinations` — filters graveyard, deduplicates, sorts combinations
    - Export all pure functions for testability
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3_

  - [ ]* 1.2 Write property test for `buildProfileCombinations`
    - **Property 1: Deterministic profile combinations**
    - Generate arbitrary state with accounts, permission sets, and assignments
    - Assert same input always produces same sorted output
    - Assert no graveyard accounts appear in output
    - Assert no duplicate (accountId, permissionSetName) pairs in output
    - **Validates: Requirements 2.2, 2.3, 2.4**

  - [ ]* 1.3 Write property test for `generateProfileBlock`
    - **Property 2: Pure profile block generation**
    - For all valid `ProfileBlockInput`, output contains `[profile ...]` header, `sso_session`, `sso_account_id`, `sso_role_name`
    - For all valid inputs, output contains `[sso-session ...]` header, `sso_start_url`, `sso_region`, `sso_registration_scopes`
    - Output ends with trailing newline
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [ ]* 1.4 Write property test for profile name uniqueness
    - **Property 3: Unique profile names**
    - For distinct (accountName, permissionSetName) pairs, `toKebabCase` produces distinct profile names
    - Output never contains uppercase or whitespace
    - **Validates: Requirements 4.6, 5.1**

  - [ ]* 1.5 Write unit tests for profile pure functions
    - Test `toKebabCase` with spaces, special chars, consecutive separators, uppercase
    - Test `deriveStartUrl` with various identity store IDs
    - Test `generateProfileBlock` output format matches INI spec (key = value with spaces)
    - Test `buildProfileCombinations` with empty state, single assignment, multiple assignments, graveyard filtering, deduplication
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.6, 5.4, 6.1_

- [x] 2. Implement profile command interactive picker and I/O
  - [x] 2.1 Implement `runProfileCommand` in `src/commands/profile.ts`
    - Read state cache and context file
    - Handle missing cache/context errors
    - Check stdin is TTY, throw if not
    - Build profile combinations using pure function
    - Display numbered list of combinations
    - Accept user input via `readline/promises`
    - Validate input (re-prompt on invalid)
    - Generate and output profile block to stdout
    - Handle empty combinations case (log message, exit cleanly)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 2.2 Write unit tests for `runProfileCommand`
    - Test error when state cache is missing
    - Test error when context file is missing
    - Test error when stdin is not TTY
    - Test empty combinations message
    - Test valid selection outputs correct profile block
    - Test invalid input re-prompts
    - _Requirements: 1.3, 1.4, 3.3, 3.4, 3.5_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement graveyard close subcommand
  - [x] 4.1 Add `runGraveyardCloseCommand` to `src/commands/graveyard.ts`
    - Define `GraveyardCloseCommandInput` type
    - Read state cache and context file
    - Filter accounts: parentId === graveyardOuId AND status === "ACTIVE"
    - Sort eligible accounts alphabetically by name
    - Output `aws organizations close-account --account-id <id>` per account
    - Handle no eligible accounts (log message, exit cleanly)
    - Handle missing state cache error
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3_

  - [ ]* 4.2 Write property test for graveyard close safety
    - **Property 4: Graveyard close safety**
    - Generate arbitrary accounts with mixed statuses in graveyard OU
    - Assert only ACTIVE accounts produce closure commands
    - Assert SUSPENDED accounts never appear in output
    - **Validates: Requirements 8.1, 8.2**

  - [x]* 4.3 Write unit tests for `runGraveyardCloseCommand`
    - Test with ACTIVE accounts in graveyard — outputs closure commands
    - Test with SUSPENDED accounts — skipped
    - Test with mixed ACTIVE/SUSPENDED — only ACTIVE output
    - Test with empty graveyard — message, no commands
    - Test missing state cache — error thrown
    - Test output sorted alphabetically by account name
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3_

- [x] 5. Wire commands into CLI router
  - [x] 5.1 Update `src/cli.ts` to register `profile` command and graveyard subcommand routing
    - Add `"profile"` to the `commands` array
    - Import `runProfileCommand` from `./commands/profile.js`
    - Import `runGraveyardCloseCommand` from `./commands/graveyard.js`
    - Route `profile` command to `runProfileCommand` with stdin, stdout, isTty props
    - Modify graveyard handler to parse second positional arg
    - Route `graveyard close` to `runGraveyardCloseCommand`
    - Throw usage error for unknown graveyard subcommands
    - Update `printHelp` to include `profile` and `graveyard close`
    - _Requirements: 3.1, 9.1, 9.2, 9.3_

  - [ ]* 5.2 Write property test for backward compatibility
    - **Property 5: Backward compatibility**
    - Assert `graveyard` with no subcommand produces identical behavior to current implementation
    - Assert `graveyard close` routes to close logic
    - **Validates: Requirements 9.1**

  - [ ]* 5.3 Write unit tests for CLI routing
    - Test `graveyard` without subcommand calls existing `runGraveyardCommand`
    - Test `graveyard close` calls `runGraveyardCloseCommand`
    - Test `graveyard unknown` throws usage error with valid subcommand list
    - Test `profile` routes to `runProfileCommand`
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 6. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All pure functions are exported separately for direct testing
- The project uses `node:test` as the test runner and `fast-check` for property-based tests

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "4.1"] },
    { "id": 2, "tasks": ["2.1", "4.2", "4.3"] },
    { "id": 3, "tasks": ["2.2", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3"] }
  ]
}
```
