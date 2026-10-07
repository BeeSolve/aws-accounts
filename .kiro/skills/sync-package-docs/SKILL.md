---
name: sync-package-docs
description: Keep this package's agentic documentation (DOCS.md + docs/how-to/ guides) in sync with the code. Use when changing the public API (CLI commands, library exports from ./security or ./scpCollection, option types), adding or renaming a how-to guide, or whenever you touch the package and want its published docs to stay accurate. Internal to @beesolve/aws-accounts.
---

## Overview

This is the `@beesolve/aws-accounts` binding for the generic `agentic-package-docs` skill. The method, the non-negotiable rules, the DOCS.md / how-to templates, and the sync procedure all live in that user-level skill - **read and follow it.** This file only supplies the concrete values for THIS repo. Where the two overlap, these repo-specific values win.

## Repo-Specific Bindings

Substitute these into the generic skill's placeholders:

- **Package:** `@beesolve/aws-accounts` (npm name == scope). Single published package; docs live at the repo ROOT.
- **Shape:** BOTH a CLI (`bin` `aws-accounts` -> `bin/cli.js`) AND a library with subpath exports `./security` and `./scpCollection`.
- **Repo URL / branch:** `https://github.com/BeeSolve/aws-accounts`, branch `main`. Mind the org casing: `BeeSolve`.
- **Package manager:** npm (volta pins node/npm).
- **Install command:**
  - CLI usage: `npm install -g @beesolve/aws-accounts` or `npx @beesolve/aws-accounts`.
  - Library usage: `npm install @beesolve/aws-accounts`.
- **Layout:** single-package repo. `DOCS.md` at root, `docs/how-to/*.md` guides at root. Source under `src/`.
- **Public library API (verify in source before writing):**
  - `./security` (`src/security.ts`): `toPolicies`, `toSecurityBaseline`, `SecurityBaselineOptions`.
  - `./scpCollection` (`src/scpCollection.ts`): `toScpCollection`, `buildExemptRolesCondition`, `buildPolicyDocument`, types `PolicyEntry` / `ScpCollection`, and the `*Options` interfaces.
- **CLI commands (verify in `src/cli.ts` and `src/commands/`):** `bootstrap`, `scan`, `init`, `regenerate`, `validate`, `graveyard` (+ `graveyard close`), `config reveal`, `profile`, `plan`, `apply`, `upgrade`, `drift`. The README is the comprehensive source - DOCS.md and the getting-started guide must NAVIGATE to it, not duplicate it.

## Publish Mechanism

The `files` array in `package.json` controls packaging (no `.npmignore`). It must include `"DOCS.md"` and `"docs/how-to"` (alongside `"bin"`, `"dist"`, `"!dist/**/*.test.js"`, `"dist-lambda"`, `"templates"`).

- Never add the whole `"docs"` folder. The ADRs under `docs/adr/` and other `docs/*.md` (e.g. `docs/scp-collection.md`, `docs/uninstall.md`, `docs/getting-started.md`, research/roadmap notes) must stay OUT of the tarball. Including only `"docs/how-to"` keeps them out automatically.
- The Further Reading ADR link points to the GitHub `docs/adr` path (GitHub only), never a relative link, since ADRs are not shipped.

## Verification Gates (this repo)

Run after any docs change:

```sh
npm run check       # oxfmt --check && oxlint .
npm run typecheck   # tsc --noEmit
npm test            # builds then runs node --test (slow but run it)

# tarball check
npm pack --dry-run
```

The pack output MUST include `DOCS.md` and `docs/how-to/*.md`, and MUST NOT include any `docs/adr/*`, `docs/scp-collection.md`, `docs/uninstall.md`, or other internal `docs/*.md`.

## Changesets

This repo USES changesets (`.changeset/config.json` present). A docs change is a `patch`. After editing docs, add a changeset:

```md
---
"@beesolve/aws-accounts": patch
---

Short summary of the docs change (e.g. ship agent-readable docs in the tarball).
```

Confirm with `npx changeset status`.

## Scope Note

Internal tooling for `@beesolve/aws-accounts`. Not published to npm, not referenced from the package README.
