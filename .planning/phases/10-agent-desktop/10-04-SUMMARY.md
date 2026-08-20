---
phase: 10-agent-desktop
plan: 04
subsystem: infra
tags: [electron-builder, wine-docker, packaging, ops-runbook, human-gate]

# Dependency graph
requires:
  - phase: 10-agent-desktop
    provides: "10-01's createAgent() factory (D10-01 reversibility target), 10-02's Electron shell/IPC, 10-03's env import, log tail, tray, login item and the two icons this plan's packaging config points at"
provides:
  - "dslrbooth-agent/electron-builder.json — JSON packaging config: output dir (release/) kept off the compiler's (dist/), file set ships dist/**/* + renderer, excludes .env/logs/node-windows/.map/.d.ts, no signing key anywhere, three Windows targets, non-space artifact names"
  - "dslrbooth-agent/scripts/build-win.sh — host compile + packaging-only step inside electronuserland/builder:wine, run as the invoking user with in-repo caches, resolved image digest recorded to release/.builder-image-digest"
  - "dslrbooth-agent/test/packaging-config.test.ts — 36 cases pinning the invariants above plus the built dist/ tree"
  - "dslrbooth-agent/docs/OPS-RUNBOOK-AGENT.md — the Agent's own operator runbook (deviation from mirror-request/docs/OPS-RUNBOOK.md, deliberately, since this phase must not touch that repo)"
  - "Real build artifacts in dslrbooth-agent/release/ (gitignored): installer, portable exe, zip — produced once, for real, on this machine"
affects: []

# Actuals (#2632)
actuals:
  tokens: 58000
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: ["electron-builder@26.15.3 (devDependency, already present in the inherited working tree at session start)"]
  patterns:
    - "Packaging config as plain JSON, not YAML, so its own invariants test reads it with JSON.parse and no new parser dependency"
    - "Wine only for the packaging step, never the TypeScript compile — scripts/build-win.sh runs `npm run build` on the bare host, then only `electron-builder --win` inside electronuserland/builder:wine"
    - "Container run as the invoking user (-u \"$(id -u):$(id -g)\") with HOME/ELECTRON_CACHE/ELECTRON_BUILDER_CACHE all pointed inside the repository, created on the host before the container starts, so nothing lands root-owned"
    - "electron-builder.json carries literally zero keys matching /sign|certificate|csc/i — verified both by a recursive-key-scan test and by mutation (adding win.sign:false trips it)"

key-files:
  created:
    - dslrbooth-agent/electron-builder.json
    - dslrbooth-agent/scripts/build-win.sh
    - dslrbooth-agent/test/packaging-config.test.ts
    - dslrbooth-agent/docs/OPS-RUNBOOK-AGENT.md
  modified:
    - dslrbooth-agent/package.json
    - dslrbooth-agent/package-lock.json
    - dslrbooth-agent/.gitignore
    - dslrbooth-agent/README.md

key-decisions:
  - "Artifact filenames use a fixed literal prefix (dslrbooth-agent-...) rather than the ${productName} token, because productName is the human-facing \"dslrBooth Agent\" (with a space) and electron-builder's default artifactName template would have embedded that space into every shipped filename — the acceptance criterion is about filenames, not the display name, so the two were deliberately decoupled."
  - "electron-builder's per-file \"signing with signtool.exe\" info-level log line during the real build is misleading nomenclature, not evidence of an actual signature: read directly from node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js inside the Wine container, signFile() only invokes signtool when cscInfo resolves non-null (a real certificate is configured); with none configured anywhere in this repo, it logs 'no signing info identified, signing is skipped' at debug level and returns false. Verified by source read rather than assumed from the log wording alone."
  - "No comment field was added inside electron-builder.json to explain the no-signing gap (JSON has no comment syntax, and an unknown top-level key risks the exact 'unknown configuration key' validation error 10-RESEARCH Pitfall 1 warns about). The rationale instead lives in scripts/build-win.sh's header comment and the OPS-RUNBOOK's §2 — the plan's own acceptance criteria only requires the ABSENCE of a signing key, asserted by the test's recursive key scan."

verification:
  automated:
    - claim: "Whole suite green, above the inherited 205"
      ref: "npm test — 13 files / 241 tests passed (was 12 files / 205 at 10-03 close)"
      status: pass
    - claim: "Task 1's own verify command"
      ref: "npm run build && npx vitest run test/packaging-config.test.ts — 36/36 passed"
      status: pass
    - claim: "Task 2's own verify command"
      ref: "npx vitest run test/packaging-config.test.ts && grep -c 'Smart App Control' docs/OPS-RUNBOOK-AGENT.md — 36 passed, grep count 6"
      status: pass
    - claim: "Typecheck, build and the pkg binary all still green (D10-01 reversibility) — checked at BOTH task commits, not just once"
      ref: "npm run typecheck (0), npm run build (0), npm run build:exe (43.5MB dslrbooth-agent.exe) after Task 1 AND after Task 2"
      status: pass
    - claim: "A real Windows build was produced on this Linux machine, for real, not just configured"
      ref: "bash scripts/build-win.sh — dslrbooth-agent-Setup-1.0.0-x64.exe (100789921 bytes), dslrbooth-agent-Portable-1.0.0-x64.exe (100567547 bytes), dslrbooth-agent-1.0.0-x64.zip (141206336 bytes); `file` reports PE32 executable (Nullsoft installer) for both .exe; `find release -user root` → 0"
      status: pass
    - claim: "The packaged application archive contains no environment file, no log directory, no node-windows package"
      ref: "node_modules/.bin/asar list release/win-unpacked/resources/app.asar, greped for .env/logs//node-windows — zero real matches (one false-positive substring hit on an unrelated winston-transitive file literally named process.env.js, inspected and confirmed irrelevant)"
      status: pass
    - claim: "Sibling repository untouched (D10-03)"
      ref: "git -C mirror-request status --short — empty"
      status: pass
    - claim: "Every path/command quoted in the runbook exists in the repo or build output"
      ref: "test -f / grep -q checks run against electron-builder.json, release/.builder-image-digest, scripts/build-win.sh, package.json's service:install/service:uninstall/build:exe scripts, main.ts's setLoginItemSettings call site, safeStorageEncryptor.ts — all found"
      status: pass
  human_judgment: true
  human_judgment_note: "Task 3 (the blocking phase gate) requires a human on the real booth PC and was correctly NOT executed by this agent. See the checkpoint report returned alongside this summary."

# Metrics
completed: 2026-08-13
status: awaiting-human-gate
---

# Phase 10 Plan 04: Packaging and the Operator Runbook — Tasks 1-2 Summary

**A real Windows installer, portable executable and zip, produced on this Linux machine inside electron-builder's own Wine image, with a written-and-fact-checked operator runbook — Task 3 (the blocking human gate on the real booth PC) intentionally NOT executed.**

## Status

**Tasks 1 and 2 are complete and committed.** Task 3 — `type="checkpoint:human-verify" gate="blocking"` — requires a human physically at the real booth PC (Windows machine, real `.env`, real dslrBooth capture, real reboot). This is a headless Linux build machine with no display server and no booth PC attached. Nothing in Task 3 was executed, simulated, or approved. This summary is written now, ahead of that gate, so Tasks 1-2's work is on record; a second summary pass (or an amendment to this one) is expected once a human answers the gate.

## Accomplishments

**Task 1 — a Windows build, from this Linux machine, in electron-builder's own Wine image** (`fa01097`). `electron-builder.json` (JSON, not YAML, so its own test reads it with no new parser dependency): output directory `release/` kept off the compiler's own `dist/`; the file set ships `dist/**/*` and the copied renderer while excluding `.env`, the log directory, the Windows-service-only `node-windows` dependency, and the compiler's `.map`/`.d.ts` debris; **no signing key of any kind**, verified by a recursive key scan and confirmed non-vacuous by mutation (adding `win.sign: false` trips the test). `scripts/build-win.sh` compiles on the host, then runs only the packaging step inside `electronuserland/builder:wine` — rcedit's resource-embedding needs Wine for every Windows target including the zip, regardless of signing (10-RESEARCH R1) — as the invoking user, with every cache pointed inside the repository, recording the resolved image digest.

Then the build was run **for real**: a 96MB NSIS installer, a 96MB portable executable, and a 135MB zip, all in `release/`, all non-root-owned, both `.exe` files confirmed as real PE32 Windows executables by `file`. The packaged `app.asar` was extracted and searched: no `.env`, no `logs/` directory, no `node-windows` package inside it. Read electron-builder's own source directly (inside the Wine container) to confirm its per-file "signing with signtool.exe" log line — which appeared in the real build output and could easily be misread as "this got signed" — is unconditional boilerplate; the actual signing call is skipped internally because no certificate is configured anywhere.

**Task 2 — the Agent's own operations runbook** (`1d3bb5b`). `docs/OPS-RUNBOOK-AGENT.md`, written in `mirror-request/docs/OPS-RUNBOOK.md`'s voice, opens by naming its own deviation: the service-side runbook is the natural home for this but this phase must not touch `mirror-request/`, so the Agent's runbook lives in the Agent's own repo, with the service-side cross-reference deliberately deferred. Covers, in the order the plan specifies: which artifact and the resolved builder image digest (now filled in from the real build above); the unsigned-application warning and its exact click path; Smart App Control's silent-block signature and the fact that no build-side fix exists — flagged as the first thing to check, before anything else; the install order on a booth PC already running an Agent (stop it first — the trigger port is the constraint); where `config.json` and the log file live under `%APPDATA%` for every packaging format, and what "portable" does and does not carry; tray/close-to-tray/the two independent auto-start preferences; the rollback to today's `pkg` executable; and an explicit **verified-here vs. awaiting-the-gate** list, since every Windows-side claim in this document is aggregated from secondary sources per 10-RESEARCH and has not been reproduced on real Windows by anyone yet. Every path and command quoted in the document was checked against the repo/build output before committing. `README.md` now points at the runbook and no longer implies the terminal is the booth PC's way to run the Agent.

## Task Commits

| Task | Commit | What landed |
|------|--------|-------------|
| 1 | `fa01097` | electron-builder.json, scripts/build-win.sh, packaging-config test (36 cases), real build artifacts produced |
| 2 | `1d3bb5b` | docs/OPS-RUNBOOK-AGENT.md, README.md pointer |
| 3 | **NOT EXECUTED** | Blocking human gate — see checkpoint report |

## Files Created/Modified

Created: `electron-builder.json`, `scripts/build-win.sh`, `test/packaging-config.test.ts`, `docs/OPS-RUNBOOK-AGENT.md`.
Modified: `package.json`, `package-lock.json` (electron-builder devDependency was already present, uncommitted, in the working tree at session start — an inherited artifact from a prior interrupted session, verified installed and correct, not re-done), `.gitignore` (added `release/` and `.electron-builder-cache/`), `README.md`.

Not committed (gitignored, correctly): `release/*.exe`, `release/*.zip`, `release/win-unpacked/`, `.electron-builder-cache/`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - test bug, caught during authoring] Two vacuous substring-match assertions in the new test file, fixed before committing**
- **Found during:** Task 1, while writing `test/packaging-config.test.ts` itself.
- **Issue:** The "mounts the repository directly rather than reinstalling dependencies" case matched the bare substring `/npm install/` against the whole script file, which failed because the script's own rationale COMMENT legitimately contains the words "npm install" while explaining why a real install step is skipped. The "keeps the documented fallback recipe" case used `/# {2}docker run --rm/` (exactly two spaces), but the actual comment line has three.
- **Fix:** Stripped comment lines before matching for the first case (so a future real `npm install`/`npm ci` command line would still fail it); loosened the whitespace count for the second.
- **Verification:** Re-ran; 36/36 pass. Confirmed the first case is still non-vacuous by checking it would fail if the fallback prose were literally turned into an executed command.
- **Files modified:** `test/packaging-config.test.ts` (same commit as the rest of Task 1, `fa01097`).

No production-code deviations. Nothing else in scope or behavior differed from the plan.

**Total deviations:** 1 (test-authoring only, caught and fixed within Task 1, before commit).

## Issues Encountered

None blocking. The Docker image pull (`electronuserland/builder:wine`, 6.32GB) took several minutes on first run, as the plan's own action text anticipated ("Expect the first run to take a long time and several gigabytes... Do not treat a slow first build as a failure") — run in the background while Task 2's runbook was drafted, so it did not block progress.

## User Setup Required

**This is the plan's entire remaining scope.** Task 3 is a blocking `checkpoint:human-verify` gate requiring a human physically at the real booth PC. See the checkpoint report returned alongside this summary for the exact steps, quoted from the plan, and what artifact to transfer.

## Next Phase Readiness

Not applicable — this is the last plan in Phase 10, and the phase itself is not closeable until Task 3's gate is answered. `release/dslrbooth-agent-Setup-1.0.0-x64.exe` (or the portable/zip alternative) is ready to transfer to the booth PC over a trusted channel. `npm run build:exe` still produces the pkg fallback binary at both task commits, so the booth's rollback path stays real through the gate (D10-01).

---
*Phase: 10-agent-desktop*
*Tasks 1-2 completed: 2026-08-13*
*Task 3: awaiting human gate*

## Self-Check: PASSED

- Both task commits present in `git log`: `fa01097`, `1d3bb5b`
- All 4 created files present on disk: `electron-builder.json`, `scripts/build-win.sh`, `test/packaging-config.test.ts`, `docs/OPS-RUNBOOK-AGENT.md`
- `npm test` 13 files / 241 tests green; `npm run typecheck` 0; `npm run build` 0; `npm run build:exe` produces a 43.5MB `dslrbooth-agent.exe`
- `bash scripts/build-win.sh` produced three real, non-root-owned artifacts in `release/` (gitignored)
- `git -C mirror-request status --short` empty
- `git status --short` in `dslrbooth-agent/` clean (working tree has no uncommitted changes)
- Task 3 NOT executed, NOT simulated, NOT approved
