# OU Deletion Follow-up Plan

This document covers the remaining OU deletion work after the current safe milestones.

## Implemented now

- `plan` can emit `deleteOu` for an OU removed from config only when that OU is:
  - part of a removed subtree where every current child OU is also safely deletable,
  - either empty in the current scanned state or fully emptied by same-batch direct account moves,
  - ordered deepest-first for nested deletes.
- `apply` requires `--allow-destructive` for that operation.
- `apply` re-checks live AWS state before delete and refuses if the OU still contains:
  - any child OU,
  - any account.

## Remaining work

### 1. Reserved OU policy

Decided:
- `Pending` and `Graveyard` must not be deleted by this tool.
- If config removal would imply deleting either reserved OU, `plan` / `apply` must fail and explain that deletion has to be done manually in AWS.

### 2. UX improvements

Potential improvements:
- mark destructive operations explicitly in human `plan` output,
- make the confirmation prompt mention destructive work when present,
- print the live preflight reason in a more structured way,
- add a dedicated JSON field later if plan consumers need to separate supported destructive operations from safe mutations.

### 3. Documentation cleanup

After the next deletion increment:
- update README examples with a concrete destructive apply example,
- document the exact current boundary for OU deletion,
- add recovery guidance for failed destructive apply runs.
