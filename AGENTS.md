# MakerWorks Suite Assistant Guide

This repository is the operational hub for the MakerWorks suite. Treat this file as the first stop for Codex or any other coding assistant working in this workspace.

## Workspace Map

Primary local repositories on the Windows dev PC:

- `C:\Users\steph\OneDrive\Documents\GitHub\mkwV2` - MakerWorks storefront, quoting, admin, operations, and integration hub.
- `C:\Users\steph\OneDrive\Documents\GitHub\printlab` - PrintLab printer control, Bambu printer integration, and Works service bridge.
- `C:\Users\steph\OneDrive\Documents\GitHub\stockworks` - StockWorks material, inventory, merch, and job visibility app.
- `C:\Users\steph\OneDrive\Documents\GitHub\slicerworks` - SlicerWorks iPad slicer concept and SwiftUI app scaffold.
- `C:\Users\steph\OneDrive\Documents\GitHub\orderworks` - OrderWorks legacy/job orchestration context.

If the user says "StackWorks", confirm whether they mean `stockworks` unless a separate StackWorks repo appears.

## First References

Read these before making suite-level changes:

- `README.md` for MakerWorks product scope and current local caveats.
- `docs/wiki/Architecture.md` for MakerWorks boundaries.
- `docs/wiki/Developer-Guide.md` for repo conventions and commands.
- `docs/codex-suite-integration.md` for suite-wide assistant workflows, safety rules, and verification commands.
- `docs/production-ops.md` for production container access, GitOps deployment, rollback, and approval boundaries.

## MakerWorks Conventions

- Keep `app/api/` route handlers thin and move business rules into `lib/`.
- Prisma schema changes require a matching migration.
- Optional integrations must degrade gracefully when upstream services or env vars are missing.
- Treat `STORAGE_DIR` as the durable root for storage-backed features.
- Preserve the existing Next.js App Router, TypeScript, Prisma, Docker, and Node test-runner patterns.

## MATERIALIZE 3D – permanent requirement: responsive, mobile-first

This fork (`docs/PROGETTO.md`) is ONE responsive application that must work on desktop and on smartphones (iOS and Android): landing, STL/3MF upload, 3D viewer (touch gestures), configurator, quotes, cart, payments, customer area, order management. Every new feature ships with a `tests/e2e/<name>.responsive.spec.ts` that runs on the `chromium`, `mobile` and `mobile-small` projects of `playwright.config.ts` (no horizontal scroll, touch targets of at least 44 px, forms usable with the mobile keyboard). Emulated phones are NOT Safari and NOT a real device: checks on a real iPhone (Safari) and a real Android phone are mandatory before launch and are recorded in `docs/CHECKLIST-PRELANCIO.md`; never mark them passed from emulation alone.

## MATERIALIZE 3D – permanent requirement: initial printer and build limits

The first machine is a Bambu Lab A1 mini (nominal build volume 180 x 180 x 180 mm, 0.4 mm nozzle). Configurator, printability check and quoting must respect it, considering orientation, supports and technical margins; models outside the usable volume are NEVER accepted automatically and NEVER resized without the customer's consent (manual review, also for splitting into parts); machine parameters (volume, nozzle, margins, allowed materials and finishes) live in the `PrinterMachine` table (Admin -> Printer machines), not in code, so another machine can be added without code changes; the server checks every cart line against the ACTIVE machines (`lib/printability.ts`) and anything that does not clearly fit goes to manual review. Details and measured current state: `docs/PROGETTO.md` ("Requisito tecnico permanente: stampante iniziale").

## Safety Rules

- Do not print `.env`, secrets, API keys, printer access codes, session secrets, database URLs, or private tokens in final answers.
- Ask before destructive actions such as deleting data, resetting Git history, dropping databases, pruning Docker volumes, stopping production-like services, or sending real printer control commands.
- Treat printer operations as real-world actions. Inspect state freely; require explicit user approval before pause, resume, stop, temperature, fan, light, upload, or print-job submission actions.
- Do not revert user changes unless the user explicitly asks.
- Prefer targeted verification over broad commands when the change is small.

## Standard MakerWorks Verification

Use the smallest relevant set:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:api`
- `npm run test:contracts`
- `npm run e2e`
- `npm run build`

Known local caveat: backup tests may fail without PostgreSQL client tooling such as `pg_dump`.
