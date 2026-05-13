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
- `Graveyard` is hard-blocked from tool-driven deletion.
- Human-readable `plan` / `apply` output marks destructive deletes explicitly and the apply confirmation prompt warns when destructive work is present.
- README now documents the supported OU deletion boundary, a concrete `apply --allow-destructive` example, and the recovery flow after partial destructive failure.

## Remaining work

### 1. Machine-readable destructive metadata

Potential improvements:
- add a dedicated JSON field later if plan consumers need to separate supported destructive operations from safe mutations.
