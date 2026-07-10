# Incident: Clean clone build failure

Date: 2026-07-10
Severity: P1
Status: resolved

## Impact

The public repository could not build from a clean clone because the product frontend imported `apps/web/src/data/sample.ts`, while the broad `data` ignore rule prevented that file from being committed. The same ignore policy excluded `.env.example`, so documented runtime configuration was absent from the repository.

## Detection

An audit clone of `origin/main` reproduced `TS2307: Cannot find module './data/sample'` during `npm run build`.

## Root cause

Repository ignore rules matched directory names and all `.env.*` files globally instead of targeting runtime databases and secret environment files narrowly.

## Fix

The ignore rules now preserve `.env.example`, source fixtures, and examples while excluding SQLite runtime files and build output explicitly. CI installs from the lockfile and runs type checks, tests, production builds, dependency audit, and browser smoke tests from a clean checkout.

## Verification

- `npm ci` and `npm run build` from a fresh clone.
- GitHub Actions quality and browser-smoke jobs.
- `git check-ignore` confirms source fixtures and `.env.example` are tracked.

## Regression prevention

The clean-checkout CI workflow is the regression control. New source directories must not be ignored by generic names such as `data`, `lib`, or `build`.
