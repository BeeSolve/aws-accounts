---
"@beesolve/aws-accounts": minor
---

Improve CLI user-facing messages and add progress feedback for long-running operations.

- `plan` and `apply` now explain why there are no changes and what to do next instead of printing bare "No changes."
- Cache age is shown when using cached state, with a hint to use `--refresh`
- Destructive operations are now blocked at the CLI level before invoking Lambda if `--allow-destructive` is not passed
- Unsupported diffs list now includes a note that manual AWS Console action is required
- Apply partial failure now suggests running `scan --refresh` before retrying
- Version mismatch warning is printed before command output instead of after
- Progress timers print elapsed time every 5 seconds during `apply`, `scan`, `init`, `drift`, and remote state fetch
- Redundant "State cache updated." after a successful `apply` is suppressed
