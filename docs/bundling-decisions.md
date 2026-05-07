# Bundling Decisions (ESM + Import Extensions + Build Time Bench)

This document records the discussion and benchmark results for whether to switch the project from esbuild transpilation to bundling (with or without code splitting), mainly to avoid writing `.js` in source imports while keeping ESM output.

## ESM Import Extensions Research

### Goal

Keep ESM, avoid `.js` in source imports, and rely on build output to make runtime imports valid.

### Findings

- Node ESM requires explicit file extensions for relative imports at runtime.
- In transpile-only mode (`bundle: false`), esbuild preserves import specifiers and does not provide a built-in pass that appends `.js` to relative import paths in emitted files.
- `resolveExtensions` helps esbuild resolve source modules during build, but does not rewrite output import specifiers for Node runtime semantics.
- `outExtension` changes emitted file extensions but not the text of import specifiers.
- Bundling (`--bundle`) avoids most extension management pain because esbuild owns the graph and emits linked chunks.

### Option summary

1. **Keep transpilation (current):**
   - fastest builds
   - requires explicit `.js` in source imports for Node ESM compatibility

2. **Bundle (`--bundle`):**
   - no need to maintain extension-heavy source import graph in the same way
   - somewhat slower builds

3. **Bundle + splitting (`--bundle --splitting`):**
   - same as bundling with chunk splitting
   - slightly slower than bundled-only in this repo

4. **Unbundled + custom rewrite pass:**
   - keep extensionless source imports and rewrite emitted imports post-build
   - extra complexity/tooling to maintain

## Benchmark Method

- Commands measured:
  - `npm run build` (CLI build)
  - `npm run build:tests` (tests build)
- Runs per command per variant: 7
- Environment:
  - date: 2026-05-07
  - OS: darwin 25.4.0
  - repo: `@beesolve/aws-accounts`
- Measurement:
  - wall-clock timing via Python `time.perf_counter()`
  - `dist/` removed before every run for consistency

## Inlined Benchmark Data (from `bench.md`)

### Unbundled Baseline

Configuration:
- `build`: `esbuild src/cli.ts --platform=node --target=node24 --format=esm --outdir=dist --outbase=src`
- `build:tests`: `esbuild "src/**/*.test.ts" --platform=node --target=node24 --format=esm --outdir=dist --outbase=src`

#### `npm run build` (seconds)

Runs:
- 0.169164
- 0.108621
- 0.107959
- 0.107171
- 0.108331
- 0.104964
- 0.106208

Stats:
- avg: 0.116060
- median: 0.107959
- min: 0.104964
- max: 0.169164
- stdev: 0.021712

#### `npm run build:tests` (seconds)

Runs:
- 0.105820
- 0.105923
- 0.119199
- 0.106095
- 0.108600
- 0.107174
- 0.104531

Stats:
- avg: 0.108192
- median: 0.106095
- min: 0.104531
- max: 0.119199
- stdev: 0.004643

### Bundled Variant

Configuration change:
- Added `--bundle` to both `build` and `build:tests`.

#### `npm run build` (seconds)

Runs:
- 0.166438
- 0.137633
- 0.135406
- 0.133676
- 0.136170
- 0.131596
- 0.137774

Stats:
- avg: 0.139813
- median: 0.136170
- min: 0.131596
- max: 0.166438
- stdev: 0.011056

#### `npm run build:tests` (seconds)

Runs:
- 0.132470
- 0.134110
- 0.132832
- 0.131617
- 0.132285
- 0.132454
- 0.131901

Stats:
- avg: 0.132524
- median: 0.132454
- min: 0.131617
- max: 0.134110
- stdev: 0.000745

### Bundled + Code Splitting Variant

Configuration change:
- Added `--bundle --splitting` to both `build` and `build:tests`.

#### `npm run build` (seconds)

Runs:
- 0.140848
- 0.141101
- 0.142354
- 0.141522
- 0.142359
- 0.144193
- 0.148852

Stats:
- avg: 0.143033
- median: 0.142354
- min: 0.140848
- max: 0.148852
- stdev: 0.002589

#### `npm run build:tests` (seconds)

Runs:
- 0.136484
- 0.138756
- 0.133632
- 0.136081
- 0.135172
- 0.135840
- 0.136655

Stats:
- avg: 0.136089
- median: 0.136081
- min: 0.133632
- max: 0.138756
- stdev: 0.001441

## Comparison

Average deltas:

- Bundled vs Unbundled:
  - `build`: 0.116060s -> 0.139813s (+20.47%)
  - `build:tests`: 0.108192s -> 0.132524s (+22.49%)
  - combined mean-of-means: 0.112126s -> 0.136169s (+21.44%)

- Bundled + Splitting vs Unbundled:
  - `build`: 0.116060s -> 0.143033s (+23.24%)
  - `build:tests`: 0.108192s -> 0.136089s (+25.79%)
  - combined mean-of-means: 0.112126s -> 0.139561s (+24.47%)

- Bundled + Splitting vs Bundled:
  - `build`: 0.139813s -> 0.143033s (+2.30%)
  - `build:tests`: 0.132524s -> 0.136089s (+2.69%)
  - combined mean-of-means: 0.136169s -> 0.139561s (+2.49%)

## Decision Snapshot

- For this repo size, bundling introduces a clear relative build-time penalty (~20-22%), while absolute impact is still small (tens of milliseconds).
- Code splitting adds a small extra penalty on top of bundling (~2.5% combined).
- Current project configuration remains **transpilation-only** (no `--bundle`, no `--splitting`) pending a separate decision on source import style and runtime module strategy.
