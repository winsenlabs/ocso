## What and why

<!-- What this changes and why. Link the issue or ADR. -->

## How it was tested

<!-- Commands you ran, tests added, manual steps. Screenshots for UI changes. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes (source guards: file size, import boundaries, package cycles)
- [ ] Tests added or updated, and `pnpm test` / `pnpm test:int` pass
- [ ] Browser flows touched? The relevant `apps/web/e2e` spec passes
- [ ] Schema changed? Migration generated with drizzle-kit and committed with its `meta/` files; no committed migration edited
- [ ] Architectural change (contract, package boundary, data model, new core dependency)? ADR added to `PM/ARCHITECTURE-DECISIONS.md`
- [ ] No `switch`/`if` on a channel or provider kind in core code; new kinds go through their contract and registry
- [ ] Docs updated (`docs/operations/`, `docs/plugins/`, or the "Implementation notes (as built)" of the affected spec)
- [ ] No secrets, `.env` files or real customer data in code, tests, fixtures or logs
