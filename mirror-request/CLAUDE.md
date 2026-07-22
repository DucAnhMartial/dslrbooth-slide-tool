# Extension Service — CLAUDE.md

This is the "central brain" of a QR-code photo booth system.
See `.planning/PROJECT.md` for full context.

## Hard rules
- NEVER write (INSERT/UPDATE/DELETE) to the real backend DB. Read-only SELECT only.
- NEVER call dslrBooth Local API directly — all commands go through Agent via WS.
- All business logic lives HERE. Agent is a dumb relay only.

## Key files
- `.planning/PROJECT.md` — project context, constraints, milestones
- `.planning/REQUIREMENTS.md` — v1 requirements with REQ-IDs
- `.planning/ROADMAP.md` — phase breakdown and success criteria
- `.planning/STATE.md` — current phase focus

## Runtime
- Node.js 20 LTS, TypeScript
- Packages: express, ws, better-sqlite3, winston, dotenv
- Deployment: PM2 or Docker on server/cloud

## Next step
After repo init: `/gsd-discuss-phase 1` to plan Phase 1.
