# OU Deletion Follow-up Plan

This document covers the remaining OU deletion work after the first safe milestone.

## Implemented now

- `plan` can emit `deleteOu` for an OU removed from config only when that OU is:
  - a leaf in the current scanned state,
  - empty in the current scanned state,
  - not part of a nested multi-OU delete.
- `apply` requires `--allow-destructive` for that operation.
- `apply` re-checks live AWS state before delete and refuses if the OU still contains:
  - any child OU,
  - any account.

## Remaining work

### 1. Same-batch move-then-delete

Goal:
- allow deleting an OU when its last accounts are moved out earlier in the same apply batch.

Required changes:
- extend diff logic to detect when all current child accounts are covered by planned `moveAccount` operations,
- model delete eligibility against projected post-operation organization state instead of only current state,
- keep ordering strict: all moves out of the OU must run before `deleteOu`,
- preserve refusal if any account remains unresolved or removed from config.

Tests:
- move last account out, then delete OU in same batch,
- partial move coverage still refuses,
- live preflight still blocks if AWS drift leaves an account behind.

### 2. Nested OU deletion

Goal:
- allow deleting parent/child OU trees when every OU in the removed subtree is empty and safe to delete.

Required changes:
- replace the current nested-delete refusal with subtree analysis,
- order `deleteOu` deepest-first,
- reject mixed cases where some descendants are safe and others are not,
- keep same live emptiness preflight on every OU before deletion.

Tests:
- delete child then parent,
- deeper multi-level delete ordering,
- refuse when any descendant still has accounts,
- refuse when only part of the subtree is removed.

### 3. Reserved OU policy

Goal:
- decide whether `Pending` and `Graveyard` should ever be deletable.

Options:
- allow when empty, same as any other OU,
- block permanently in diff,
- require a second explicit opt-in.

Recommended default:
- block them unless there is a strong product reason to allow deletion.

### 4. UX improvements

Potential improvements:
- mark destructive operations explicitly in human `plan` output,
- make the confirmation prompt mention destructive work when present,
- print the live preflight reason in a more structured way,
- add a dedicated JSON field later if plan consumers need to separate supported destructive operations from safe mutations.

### 5. Documentation cleanup

After the next deletion increment:
- update README examples with a concrete destructive apply example,
- document the exact current boundary for OU deletion,
- add recovery guidance for failed destructive apply runs.
