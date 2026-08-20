---
schema_version: 1
open_count: 1
waived_count: 1
fixed_count: 8
total_count: 10
last_updated: 2026-08-12T14:58:53.321Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 01 | deviation | mirror-request/src/state/localStore.ts | 122 | Pre-existing duplicate getJobRegistration() implementation (lines 122, 238) from baseline WIP commit 5519364 blocks npm run build/typecheck/dev; out of scope for 01-01, belongs to M4 cleanup | fixed |  | 2026-08-10T07:57:13.361Z | 2026-08-10T08:01:49.184Z |
| 2 | 01 | deviation | mirror-request/src/ingestion/mirrorReceiver.ts |  | Acceptance-criteria grep for dedupWindowMs (expected count 1) unsatisfiable literally: plan 01-01 already declared dedupWindowMs on MirrorReceiverOptions before this plan started; implementing the required windowStartMs computation necessarily raises the count to 2. Behavioral intent satisfied; documented in 01-04-SUMMARY.md. | waived | Grep criterion is literally unsatisfiable by construction, not a code defect: 01-01 legitimately declared dedupWindowMs on MirrorReceiverOptions, so the required usage line necessarily makes the count 2 rather than 1. Behavioral intent verified by the dedup test suite (14 cases). No code change would satisfy the literal count without deleting the interface field. | 2026-08-10T08:40:54.223Z | 2026-08-10T08:46:36.646Z |
| 3 | 01 | deviation | mirror-request/test/on-register-auth.test.ts | 270 | Pre-existing flaky assertion (from plan 01-02): countWebhookIds() snapshot-then-delta check races against concurrent vitest worker writes to the shared LocalStore singleton (single fixed LOCAL_STORE_PATH across all test files). Observed ~2/16 full-suite runs during 01-04 verification. Out of scope for 01-04 (pre-existing architecture, not caused by dedup logic); not fixed here. | fixed |  | 2026-08-10T08:41:03.529Z | 2026-08-10T08:46:36.337Z |
| 4 | 01 | deviation | mirror-request/test/on-register-auth.test.ts |  | CORRECTED 2026-08-10: an earlier wording of this entry claimed the suite hits the production DB. It does not — vitest.config.ts:12 sets LOCAL_STORE_PATH=./data/test-extension-service.sqlite, and the production file is untouched (test DB has 1457 webhook_replay rows, production 0). The real defect is narrower but still open: ALL test files share that ONE test DB through the getStore() singleton rather than the constructor(dbPath?) seam added by 01-02, and vitest runs files in parallel workers, so tests interfere across files. Measured 3 failures in 10 full-suite runs before e54e22e removed the one assertion that depended on cross-file isolation. The coupling itself remains and will breed similar races — especially in Phase 2, where booth_state is a single global row. Follow-up: give each test file its own temp DB via the constructor seam. | open |  | 2026-08-10T08:46:45.241Z |  |
| 5 | 3 | deviation | mirror-request/src/agent/agentServer.ts | 83 | Connection ids (agent-${Date.now()}-${++connSeq}) contain a 13-digit timestamp that mask()'s PHONE_RE (7+ digit run) asterisks in logs, degrading the displaced-Agent diagnostic (OPS-RUNBOOK §7) to sequence-number-only; ids repeat across process restarts since connSeq resets to 1. Minor: diagnostics only, no functional impact. Found during 03-05's cross-repo smoke check. | fixed |  | 2026-08-10T13:57:07.268Z | 2026-08-11T04:14:32.762Z |
| 6 | 5 | unmet-truth | mirror-request/src/status/statusRoute.ts |  | THE FACTUAL QUESTION IS NOW ANSWERED (2026-08-11, Phase 6 discussion, recorded as 06-CONTEXT.md D-10) — the entry stays open because the mitigation is not built yet, not because the entropy is still unknown. Phase 6 makes registrations.id = ticketing_ticket.ticket_code, generated in /opt/web-ticket/qrcode/ets_web/apps/ticketing/short_code.py by secrets.choice — a CSPRNG, chosen over random.choice in an explicit source comment — over a 32-char Crockford base32 alphabet, 8 chars long. So the worst case that blocked Phase 5 is RULED OUT: the id is neither a sequence nor a timestamp, and the separate server-minted status token contemplated in the prior wording is NOT needed. But 8 chars x 32 = 40 bits, far under the >=128-bit ASVS V2 capability-URL guidance, and /status/:jobId deliberately returns 200 for a valid foreign id (holding the id IS the authorisation, D-06/D-08). Mitigation = rate-limit /status/:jobId; owned by Phase 6 D-10 and ROADMAP Phase 6 success criterion 7. Close this entry when that limiter ships. Prior wording, now superseded: entropy UNVERIFIED, 0 randomUUID call sites in src/, all 6 production ids hand-typed and 2 trivially enumerable — those measurements were of this repo's seed data, which never had any bearing on how the backend mints ids. Human had authorized dev-only (not-confirmed-accept-risk). | fixed |  | 2026-08-11T03:20:16.750Z | 2026-08-11T15:15:12.909Z |
| 7 | 6 | deviation | mirror-request/data/extension-service.sqlite |  | Standing D-07 test registration 3X818VEJ (queue_job status=queued, retries=0) has no ets_web-side cancellation path and must be marked failed by hand (OPS-RUNBOOK §6/§10) before an Agent ever connects, or it will be dispatched for a real photo session with nobody present | fixed |  | 2026-08-12T03:32:30.949Z | 2026-08-12T04:43:33.708Z |
| 8 | 6 | unmet-truth | mirror-request/src/queue/queueService.ts | 164 | MEASURED LIVE 2026-08-12 on job BZWCWFN6, single-process pm2 run (NOT the dual-server incident): dslrBooth emits session_start AND session_end TWICE per photo session, 47s apart (session_end at 07:09:26 and again at 07:10:13, both logged 'Completed job BZWCWFN6'). sessionAcked() writes status='in_progress' WHERE id=? with no status guard (localStore.ts:193), so the stray second session_start RESURRECTS the already-completed job; completeInProgressJob() (localStore.ts:220) then re-completes it because it selects WHERE status='in_progress' ORDER BY acknowledged_at DESC LIMIT 1 and is NOT scoped to a jobId. Harmless with an empty queue - both completions land on the same job, which is the only reason every test so far passed. With a queue it is not: session_end #1 completes guest A, sets IDLE and tick() dispatches guest B; B's session_start makes B in_progress; then A's stray session_end #2 completes B, freeing the booth and calling guest C while B is still at the camera. Every guest after the first can be cut short, and B's slideshow photo is attributed to a session that never ran. Fix: scope completion to the jobId the event carries, and guard sessionAcked against a job already in a terminal state. CLOSED (item 8) by plan 07-01: completeInProgressJob() is gone, replaced by the jobId-scoped completeJob(jobId, completedAt) called only from the print-composite anchor, and sessionAcked() gained a terminal-state guard covering completed/failed/no_photo. Regression cover: test/queue-dual-completion.test.ts drives two real guests through the dispatch path and asserts guest B stays in_progress across guest A's stray duplicate session_end, alongside a prototype invariant asserting LocalStore.prototype.completeInProgressJob is undefined, which goes red the instant the positional assumption is reintroduced. | fixed |  | 2026-08-12T07:18:04.208Z | 2026-08-12T14:05:03.770Z |
| 9 | 6 | unmet-truth | mirror-request/src/queue/queueService.ts | 174 | The 'No print upload seen for <job> at session_end' warn fires on EVERY successful session, not on the failure it was written for. Measured 2026-08-12 on BZWCWFN6: session_end 07:09:26, warn 07:09:26, 'Notification sent' 07:09:27 - dslrBooth delivers the print composite about one second AFTER session_end, so printUploadSeen is empty at the moment the check runs, always. An operator grepping warn lines therefore sees one per guest and learns nothing; the real no-print case is indistinguishable from the normal case. This was previously attributed to the dual-server incident and deliberately left unpatched on that basis - that attribution was wrong, the ordering is intrinsic. Fix: evaluate the check on a short delay after session_end, or drop it in favour of asserting on the notification record. CLOSED (item 9) by plan 07-03: the 'No print upload seen' warn moved off session_end onto pending-print registry expiry (sweepPendingPrints), the only anchor whose ordering relative to the upload is not intrinsic; the slot is opened at the composite anchor and expired rows are marked rather than deleted, so a print that was never produced stays distinguishable from one that arrived late. Regression cover: test/queue-file-upload-print.test.ts asserts session_end emits no print-related warn in both measured orderings (print already arrived, and print not yet arrived), and the registry expiry tests assert at most one warn per slot. | fixed |  | 2026-08-12T07:18:15.654Z | 2026-08-12T14:05:04.053Z |
| 10 | 7 | unmet-truth | mirror-request/src/queue/queueService.ts | 328 | WINDOWS-8 WAS ONLY HALF-CLOSED, and this entry records the other half plus its fix. Item 8's closure text (plan 07-01) claims sessionAcked() was made safe by a terminal-state guard. That guard only blocks RESURRECTING a job already in completed/failed/no_photo. It does NOT stop a stray session_start naming a DIFFERENT, still-live job: sessionAcked() rebound booth_state.current_job_id unconditionally, so the event stole the booth from the guest actually standing at it. That guest stayed in_progress but UNBOUND, which (a) made them eligible for 07-04's no-photo sweep and (b) made their own print composite fail onPrintComposite()'s D-06 current_job_id cross-check — so a guest who was genuinely photographed was closed as no_photo and shown see_staff. The theft itself was instantaneous; only the sweep close was delayed by NO_PHOTO_CLOSE_DELAY_MS, so this is NOT the documented 15-minute residual window. The premise is stated in the code itself: 'the Agent stamps a stale activeJobId on every forwarded event and never clears it'. 07-EVIDENCE-dslrbooth-triggers.md:71-79 records exactly this as the untested hypothesis behind the unexplained BZWCWFN6 incident; the phase-7 code review (07-REVIEW.md CR-01) confirmed it at code level and reproduced it against the real QueueService. FIXED by commits 721939c (failing tests) and f8412d2 (fix): session_start now routes through sessionAckedFromEvent(), which drops the event when its jobId disagrees with current_job_id and warns naming both ids. onAgentAck()'s direct call to sessionAcked() is deliberately left UNGUARDED — its jobId is server-dispatched and is the one caller that may legitimately establish a new binding — and an unbound booth still accepts the event, which is the real first session_start of a dispatched session. Regression cover: test/queue-session-start-hijack.test.ts, five cases, including one that pins the normal binding path and passed BEFORE the fix so the guard cannot earn its green by rejecting everything. Operator-facing line documented in OPS-RUNBOOK section 5 (commit 697380b). | fixed |  | 2026-08-12T14:58:46.485Z | 2026-08-12T14:58:53.321Z |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "01",
    "file": "mirror-request/src/state/localStore.ts",
    "line": 122,
    "description": "Pre-existing duplicate getJobRegistration() implementation (lines 122, 238) from baseline WIP commit 5519364 blocks npm run build/typecheck/dev; out of scope for 01-01, belongs to M4 cleanup",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-10T07:57:13.361Z",
    "resolved_at": "2026-08-10T08:01:49.184Z"
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "01",
    "file": "mirror-request/src/ingestion/mirrorReceiver.ts",
    "line": null,
    "description": "Acceptance-criteria grep for dedupWindowMs (expected count 1) unsatisfiable literally: plan 01-01 already declared dedupWindowMs on MirrorReceiverOptions before this plan started; implementing the required windowStartMs computation necessarily raises the count to 2. Behavioral intent satisfied; documented in 01-04-SUMMARY.md.",
    "status": "waived",
    "reason": "Grep criterion is literally unsatisfiable by construction, not a code defect: 01-01 legitimately declared dedupWindowMs on MirrorReceiverOptions, so the required usage line necessarily makes the count 2 rather than 1. Behavioral intent verified by the dedup test suite (14 cases). No code change would satisfy the literal count without deleting the interface field.",
    "recorded_at": "2026-08-10T08:40:54.223Z",
    "resolved_at": "2026-08-10T08:46:36.646Z"
  },
  {
    "id": 3,
    "kind": "deviation",
    "phase": "01",
    "file": "mirror-request/test/on-register-auth.test.ts",
    "line": 270,
    "description": "Pre-existing flaky assertion (from plan 01-02): countWebhookIds() snapshot-then-delta check races against concurrent vitest worker writes to the shared LocalStore singleton (single fixed LOCAL_STORE_PATH across all test files). Observed ~2/16 full-suite runs during 01-04 verification. Out of scope for 01-04 (pre-existing architecture, not caused by dedup logic); not fixed here.",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-10T08:41:03.529Z",
    "resolved_at": "2026-08-10T08:46:36.337Z"
  },
  {
    "id": 4,
    "kind": "deviation",
    "phase": "01",
    "file": "mirror-request/test/on-register-auth.test.ts",
    "line": null,
    "description": "CORRECTED 2026-08-10: an earlier wording of this entry claimed the suite hits the production DB. It does not — vitest.config.ts:12 sets LOCAL_STORE_PATH=./data/test-extension-service.sqlite, and the production file is untouched (test DB has 1457 webhook_replay rows, production 0). The real defect is narrower but still open: ALL test files share that ONE test DB through the getStore() singleton rather than the constructor(dbPath?) seam added by 01-02, and vitest runs files in parallel workers, so tests interfere across files. Measured 3 failures in 10 full-suite runs before e54e22e removed the one assertion that depended on cross-file isolation. The coupling itself remains and will breed similar races — especially in Phase 2, where booth_state is a single global row. Follow-up: give each test file its own temp DB via the constructor seam.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-10T08:46:45.241Z",
    "resolved_at": null
  },
  {
    "id": 5,
    "kind": "deviation",
    "phase": "3",
    "file": "mirror-request/src/agent/agentServer.ts",
    "line": 83,
    "description": "Connection ids (agent-${Date.now()}-${++connSeq}) contain a 13-digit timestamp that mask()'s PHONE_RE (7+ digit run) asterisks in logs, degrading the displaced-Agent diagnostic (OPS-RUNBOOK §7) to sequence-number-only; ids repeat across process restarts since connSeq resets to 1. Minor: diagnostics only, no functional impact. Found during 03-05's cross-repo smoke check.",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-10T13:57:07.268Z",
    "resolved_at": "2026-08-11T04:14:32.762Z"
  },
  {
    "id": 6,
    "kind": "unmet-truth",
    "phase": "5",
    "file": "mirror-request/src/status/statusRoute.ts",
    "line": null,
    "description": "THE FACTUAL QUESTION IS NOW ANSWERED (2026-08-11, Phase 6 discussion, recorded as 06-CONTEXT.md D-10) — the entry stays open because the mitigation is not built yet, not because the entropy is still unknown. Phase 6 makes registrations.id = ticketing_ticket.ticket_code, generated in /opt/web-ticket/qrcode/ets_web/apps/ticketing/short_code.py by secrets.choice — a CSPRNG, chosen over random.choice in an explicit source comment — over a 32-char Crockford base32 alphabet, 8 chars long. So the worst case that blocked Phase 5 is RULED OUT: the id is neither a sequence nor a timestamp, and the separate server-minted status token contemplated in the prior wording is NOT needed. But 8 chars x 32 = 40 bits, far under the >=128-bit ASVS V2 capability-URL guidance, and /status/:jobId deliberately returns 200 for a valid foreign id (holding the id IS the authorisation, D-06/D-08). Mitigation = rate-limit /status/:jobId; owned by Phase 6 D-10 and ROADMAP Phase 6 success criterion 7. Close this entry when that limiter ships. Prior wording, now superseded: entropy UNVERIFIED, 0 randomUUID call sites in src/, all 6 production ids hand-typed and 2 trivially enumerable — those measurements were of this repo's seed data, which never had any bearing on how the backend mints ids. Human had authorized dev-only (not-confirmed-accept-risk).",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-11T03:20:16.750Z",
    "resolved_at": "2026-08-11T15:15:12.909Z"
  },
  {
    "id": 7,
    "kind": "deviation",
    "phase": "6",
    "file": "mirror-request/data/extension-service.sqlite",
    "line": null,
    "description": "Standing D-07 test registration 3X818VEJ (queue_job status=queued, retries=0) has no ets_web-side cancellation path and must be marked failed by hand (OPS-RUNBOOK §6/§10) before an Agent ever connects, or it will be dispatched for a real photo session with nobody present",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-12T03:32:30.949Z",
    "resolved_at": "2026-08-12T04:43:33.708Z"
  },
  {
    "id": 8,
    "kind": "unmet-truth",
    "phase": "6",
    "file": "mirror-request/src/queue/queueService.ts",
    "line": 164,
    "description": "MEASURED LIVE 2026-08-12 on job BZWCWFN6, single-process pm2 run (NOT the dual-server incident): dslrBooth emits session_start AND session_end TWICE per photo session, 47s apart (session_end at 07:09:26 and again at 07:10:13, both logged 'Completed job BZWCWFN6'). sessionAcked() writes status='in_progress' WHERE id=? with no status guard (localStore.ts:193), so the stray second session_start RESURRECTS the already-completed job; completeInProgressJob() (localStore.ts:220) then re-completes it because it selects WHERE status='in_progress' ORDER BY acknowledged_at DESC LIMIT 1 and is NOT scoped to a jobId. Harmless with an empty queue - both completions land on the same job, which is the only reason every test so far passed. With a queue it is not: session_end #1 completes guest A, sets IDLE and tick() dispatches guest B; B's session_start makes B in_progress; then A's stray session_end #2 completes B, freeing the booth and calling guest C while B is still at the camera. Every guest after the first can be cut short, and B's slideshow photo is attributed to a session that never ran. Fix: scope completion to the jobId the event carries, and guard sessionAcked against a job already in a terminal state. CLOSED (item 8) by plan 07-01: completeInProgressJob() is gone, replaced by the jobId-scoped completeJob(jobId, completedAt) called only from the print-composite anchor, and sessionAcked() gained a terminal-state guard covering completed/failed/no_photo. Regression cover: test/queue-dual-completion.test.ts drives two real guests through the dispatch path and asserts guest B stays in_progress across guest A's stray duplicate session_end, alongside a prototype invariant asserting LocalStore.prototype.completeInProgressJob is undefined, which goes red the instant the positional assumption is reintroduced.",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-12T07:18:04.208Z",
    "resolved_at": "2026-08-12T14:05:03.770Z"
  },
  {
    "id": 9,
    "kind": "unmet-truth",
    "phase": "6",
    "file": "mirror-request/src/queue/queueService.ts",
    "line": 174,
    "description": "The 'No print upload seen for <job> at session_end' warn fires on EVERY successful session, not on the failure it was written for. Measured 2026-08-12 on BZWCWFN6: session_end 07:09:26, warn 07:09:26, 'Notification sent' 07:09:27 - dslrBooth delivers the print composite about one second AFTER session_end, so printUploadSeen is empty at the moment the check runs, always. An operator grepping warn lines therefore sees one per guest and learns nothing; the real no-print case is indistinguishable from the normal case. This was previously attributed to the dual-server incident and deliberately left unpatched on that basis - that attribution was wrong, the ordering is intrinsic. Fix: evaluate the check on a short delay after session_end, or drop it in favour of asserting on the notification record. CLOSED (item 9) by plan 07-03: the 'No print upload seen' warn moved off session_end onto pending-print registry expiry (sweepPendingPrints), the only anchor whose ordering relative to the upload is not intrinsic; the slot is opened at the composite anchor and expired rows are marked rather than deleted, so a print that was never produced stays distinguishable from one that arrived late. Regression cover: test/queue-file-upload-print.test.ts asserts session_end emits no print-related warn in both measured orderings (print already arrived, and print not yet arrived), and the registry expiry tests assert at most one warn per slot.",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-12T07:18:15.654Z",
    "resolved_at": "2026-08-12T14:05:04.053Z"
  },
  {
    "id": 10,
    "kind": "unmet-truth",
    "phase": "7",
    "file": "mirror-request/src/queue/queueService.ts",
    "line": 328,
    "description": "WINDOWS-8 WAS ONLY HALF-CLOSED, and this entry records the other half plus its fix. Item 8's closure text (plan 07-01) claims sessionAcked() was made safe by a terminal-state guard. That guard only blocks RESURRECTING a job already in completed/failed/no_photo. It does NOT stop a stray session_start naming a DIFFERENT, still-live job: sessionAcked() rebound booth_state.current_job_id unconditionally, so the event stole the booth from the guest actually standing at it. That guest stayed in_progress but UNBOUND, which (a) made them eligible for 07-04's no-photo sweep and (b) made their own print composite fail onPrintComposite()'s D-06 current_job_id cross-check — so a guest who was genuinely photographed was closed as no_photo and shown see_staff. The theft itself was instantaneous; only the sweep close was delayed by NO_PHOTO_CLOSE_DELAY_MS, so this is NOT the documented 15-minute residual window. The premise is stated in the code itself: 'the Agent stamps a stale activeJobId on every forwarded event and never clears it'. 07-EVIDENCE-dslrbooth-triggers.md:71-79 records exactly this as the untested hypothesis behind the unexplained BZWCWFN6 incident; the phase-7 code review (07-REVIEW.md CR-01) confirmed it at code level and reproduced it against the real QueueService. FIXED by commits 721939c (failing tests) and f8412d2 (fix): session_start now routes through sessionAckedFromEvent(), which drops the event when its jobId disagrees with current_job_id and warns naming both ids. onAgentAck()'s direct call to sessionAcked() is deliberately left UNGUARDED — its jobId is server-dispatched and is the one caller that may legitimately establish a new binding — and an unbound booth still accepts the event, which is the real first session_start of a dispatched session. Regression cover: test/queue-session-start-hijack.test.ts, five cases, including one that pins the normal binding path and passed BEFORE the fix so the guard cannot earn its green by rejecting everything. Operator-facing line documented in OPS-RUNBOOK section 5 (commit 697380b).",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-12T14:58:46.485Z",
    "resolved_at": "2026-08-12T14:58:53.321Z"
  }
]
````
