# Phase 5 Context: Client API & Display Feed

**Created:** 2026-08-11
**Requirements:** API-01, API-02, AUTH-03 (non-ingestion log surfaces only)
**Depends on:** Phase 4 (closed, verified)

---

<provenance>
**These decisions were made by Claude, not selected by the user.** The user was
offered the four gray areas below as an interactive question, declined to answer
them, and said "Ok tiếp tục đi" — the same explicit delegation given twice earlier
in this project ("Cái này bạn chọn cách nào tối ưu nhất giúp tôi" for Phase 2's
restart-recovery design, and "bạn cũng chọn sao cho tối ưu đặc biệt là trải nghiệm
người dùng" for Phase 3). Decisions here optimise for guest experience first,
consistent with that stated priority.

**All decisions below are reversible until planning starts.** The user may edit
this file directly. Downstream agents must treat them as locked, but must not
present them to the user as though the user chose them.
</provenance>

<domain>
Phase 5 delivers the two **read surfaces** of the system — the only two places a
human other than an operator ever sees its state:

1. **The guest's phone** — `GET /status/:jobId`. One guest, their own job.
2. **The room's big screen** — `WS /display` + `GET /display-screen`. Everyone present.

Plus AUTH-03's remaining non-ingestion log surfaces (the ingestion surface shipped
in Phase 1 as D-15/D-16).

**This is a hardening and completion pass over working code, not greenfield** — the
fourth such phase in a row. Both routes already exist and both tests already pass.
</domain>

<phase_boundary>
IN scope: the two read surfaces above, their access control, their failure
presentation, and the remaining log-masking surfaces.

OUT of scope (do not let these leak in): any change to queue dispatch policy
(Phase 2), the Agent link (Phase 3), or notification delivery (Phase 4). Phase 5
**reads** their state; it must not alter their behaviour.
</phase_boundary>

---

## Pre-existing code (verified, not assumed)

| Asset | Location | State |
|---|---|---|
| `GET /status/:jobId` | `src/index.ts:36-50` | Works. Returns position, queueLength, boothState, agentOnline, guestName. **No estimated wait.** |
| `WS /display` | `src/display/displayServer.ts:23-53` | Works. Broadcasts every 250ms unconditionally. No auth. |
| `GET /display-screen` | `src/index.ts:29` | Serves `renderDisplayPage()`. No auth. |
| `renderDisplayPage()` | `src/display/displayPage.ts` (60 lines) | Full HTML+CSS+JS screen, Vietnamese copy, countdown UI. |
| `DisplaySnapshot` | `src/types.ts:69-79` | 9 fields. |
| Tests | `test/phase5-display.test.ts` (78 lines, 2 tests) | Passing. Assertions are thin — see G-03. |

### Verified findings that shape the plans

**F-01 — API-01 is half-built.** ROADMAP M5 success criterion 1 reads "GET
/status/:jobId returns queue position **+ estimated wait**". The shipped response
(`src/index.ts:41-48`) has no wait estimate of any kind. This is the single largest
functional gap in the phase.

**F-02 — `currentJob` is a type lie, but NOT a PII leak.** `DisplaySnapshot.currentJob`
is typed `QueueJob | null`, and `QueueJob.registration` (`src/types.ts:15`) is a
required `Registration` carrying `email`, `phone`, and `qr_token`. This *looks* like
the public display feed broadcasting PII four times a second. **It does not.** The
`queue_job` table (`src/state/localStore.ts:34-47`) has no PII columns at all, and
`getNextQueuedJob()` (`:204-206`) is a bare `SELECT * FROM queue_job` cast
`as QueueJob`. At runtime `currentJob.registration` is `undefined` while TypeScript
believes it is a required object.

So: no leak today, but the type system is actively lying, and any future line that
writes `snapshot.currentJob.registration.name` compiles clean and crashes in
production. See D-15 — the fix is structural, not a null check.

**F-03 — `displayServer.ts:9` is `const store = getStore()` at module scope.** This is
exactly open ledger item 4 in `.planning/WINDOWS.md` (shared test DB via the
`getStore()` singleton across parallel vitest workers). Phase 5 is the natural place
to close it. See D-16.

**F-04 — jobId is a backend-minted UUID, not one this service controls.**
`src/ingestion/mirrorReceiver.ts:112,130` takes `id` straight from the inbound webhook
payload and uses it verbatim as the job id; `src/ingestion/dbPoller.ts:126` does the
same with `row.id`. Sampled ids are UUIDv4-shaped
(`000d3528-c10d-4d0f-94ba-d502c6202993`), ~122 bits of entropy. There is **no
`randomUUID` call anywhere in `src/`**. The unguessability that D-06 depends on is
therefore inherited from the upstream backend and is not enforced here. See D-07.

---

## Decisions

### Estimated wait (closes F-01)

**D-01 — The estimate is computed from real session durations, not a constant.**
A hardcoded "5 phút × vị trí" would be wrong on day one and stay wrong.

> **CORRECTED 2026-08-11 by 05-RESEARCH.md — the original wording named a dead column.**
> This decision first said the duration comes from `session_started_at` … `completed_at`.
> `session_started_at` is **declared but never written**: measured, it appears exactly 3
> times in `src/` — the type field (`types.ts:21`), the schema column
> (`localStore.ts:41`), and a column-name whitelist (`localStore.ts:189`) — and zero of
> those are writes. Both `updateJobStatus()` call sites write only `acknowledged_at`
> (`queueService.ts:167`) and `dispatched_at` (`queueService.ts:280`). A query built on
> `session_started_at` would return **zero samples forever**, silently.
>
> **The real pair is `completed_at - acknowledged_at` on `status='completed'` rows.**
> `acknowledged_at` is stamped when the booth confirms it started (`queueService.ts:167`);
> `completed_at` and `session_ended_at` are stamped together by one statement on the
> completion path (`localStore.ts:226`), so `session_ended_at` is redundant with
> `completed_at` — use `completed_at`.
>
> The planner must treat `session_started_at` as dead schema: either leave it strictly
> alone or, if it is touched at all, do so in a way that cannot be mistaken for a live
> field. Do not "fix" it by starting to write it — that is Phase 2's queue seam, which
> `<phase_boundary>` puts explicitly OUT of scope.

**D-02 — Use the median, and exclude poisoned samples.** Median, not mean: a single
session that hit Phase 2's 5-minute BUSY timeout would drag a mean upward for hours.
Sessions that ended via `TIMEOUT_RESET`, or whose job reached `failed`, must not enter
the sample — they measure the fault, not the booth.

> **Refinement from 05-RESEARCH.md:** with D-01 corrected, this exclusion is **structural
> rather than conditional**. Restricting the sample to `status = 'completed'` already
> excludes every failed and timeout-reset job, because those rows never reach that status.
> Express it that way — as a `WHERE` clause the query cannot run without — rather than as
> an additional filter a later edit could delete. This is the same omission-as-guarantee
> pattern Phase 4 used at `localStore.ts:435` and Phase 2 used in `requeueWithRetry`.

**D-03 — Present a range, rounded up; never a precise ticking number.** The guest sees
"khoảng 3–5 phút", not "4:12". A number that ticks down and then jumps back up when
the queue shifts destroys trust faster than a vague answer ever will. Round up: it is
always better for a guest to be called early than late.

**D-04 — Cold start has an explicit configured fallback.** Below a configured minimum
sample count, use a configured default duration rather than computing from one or two
sessions. Both the minimum and the default are config values, not literals.

**D-05 — When the booth cannot serve, suppress the estimate rather than lie.** If the
Agent is offline (Phase 3's heartbeat watchdog says so) or the booth is in
`TIMEOUT_RESET`, the response carries no wait estimate at all and the guest-facing
status says the booth is paused. An estimate computed while nothing can be dispatched
is a promise the system knows it cannot keep.

### Access control

**D-06 — `/status/:jobId` is a capability URL. No additional authentication.** The
UUID *is* the credential: the guest receives it by scanning their own QR code, and
122 bits is not enumerable. Adding a login to a photobooth status page would be worse
UX for zero real security gain.

**D-07 — Record the inherited-entropy assumption honestly.** Per F-04, this service
does not mint the id. The researcher must confirm the backend generates it with a CSPRNG
and not from a sequence or timestamp. If that cannot be confirmed, D-06 is unsound and
the phase must escalate rather than quietly ship a guessable capability URL. This is an
assumption to verify, not a detail to assume.

**D-08 — Unknown jobId returns a single generic 404.** Identical status and body shape
whether the job never existed, was purged, or belongs to someone else. No response may
let a caller distinguish those cases — that difference is an enumeration oracle, and it
is the same reasoning Phase 1 used to collapse its IP-allow-list rejections into one
generic 403.

**D-09 — `/display` and `/display-screen` are gated by IP allow-list, NOT by a Bearer
header.** This is a deliberate divergence from Phase 3's D-05, and the reason is a hard
browser constraint, not a preference: **the browser WebSocket API cannot set request
headers.** The `Authorization: Bearer` + `timingSafeEqual` + 401-at-upgrade pattern in
`src/agent/agentServer.ts:59-67` works for the Agent precisely because the Agent is a
Node process. It cannot transfer to a page running in a browser. Reuse Phase 1's
allow-list machinery (`config.PROXY_IP_WHITELIST` and the generic-403 posture in
`src/ingestion/mirrorReceiver.ts`) with its own separate config key.

**D-10 — Explicitly reject a shared token in the WebSocket URL.** Against an attacker
already inside the allow-listed network it adds nothing, and a browser forces it into
the query string — where it lands in access logs, browser history, and `Referer`
headers. That is the exact anti-pattern Phase 3 spent a whole cross-repo cutover
deleting (`?token=` → header). Do not reintroduce it one phase later on a different
endpoint.

### What the guest sees when things go wrong

**D-11 — Guest-facing status is a closed vocabulary, and internal words never cross the
boundary.** `dispatched`, `in_progress`, `stall_reason`, `retries`, `ack_error_message`,
`TIMEOUT_RESET` are operator language. None may appear in a `/status/:jobId` response.
The guest-facing set is small and complete: waiting, your turn now, session in progress,
finished (photo sent), finished (photo still sending), and please see staff.

**D-12 — Every terminal and fault state from Phases 2–4 maps to exactly one guest-facing
message.** This is the customer-facing surface of every failure the previous four phases
built. Specifically: a job that exhausted Phase 2's retry budget and reached `failed`
must not leave the guest polling a position forever — it resolves to "please see staff".
A booth with no Agent (Phase 3) resolves to paused. A session that completed but whose
notification is still retrying or terminally `failed` (Phase 4) resolves to finished,
with the photo state stated separately and honestly. The mapping must be exhaustive —
an unmapped internal state is a defect, not a default.

### The big screen

**D-13 — Broadcast on change, plus one tick per second while a countdown is running.**
The current unconditional 250ms interval sends four identical full snapshots per second
forever, whether or not anything moved. A seconds countdown needs at most 1 Hz for a
human reading a wall screen; everything else is change-driven.

**D-14 — Full name for the guest being called; given name only for the up-next list.**
The called guest must recognise themselves instantly, and their name is being announced
in the room anyway — full name on the hero. The queue list behind it is a different
matter: a room of strangers does not need a full roster of everyone's full name. In
Vietnamese naming the given name comes last, so "given name" means the trailing element
(`Nguyễn Văn A` → `A`), which is also how a person would actually be addressed.

**D-15 — PII cannot reach the display wire by construction.** Replace `currentJob:
QueueJob` in `DisplaySnapshot` with a purpose-built projection type carrying only the
fields the screen renders. The guarantee must live in the projection's shape — in what
the type does not have — not in a null check or a delete-the-PII step that a later edit
could remove. This is the same structural principle Phase 4 used for D-05 (terminal
states absent from the sweeper's queries rather than guarded by an `if`), and it fixes
F-02's type lie as a side effect rather than papering over it.

**D-16 — Inject the store into `DisplayServer`; delete the module-scope `getStore()`.**
Closes open ledger item 4 in `WINDOWS.md`, and follows the constructor-injection pattern
Phase 2 established for `queueService`. `/gsd-ship` blocks while that ledger entry is
open, so this is on the critical path to shipping, not a nicety.

### AUTH-03

**D-17 — Enumerate the remaining non-ingestion log surfaces before masking them.** Phase
1 delivered the ingestion surface (D-15/D-16) and AUTH-03 is already `[x]` in
REQUIREMENTS.md. The researcher must produce the actual list of remaining surfaces from
the code — display, status API, queue, agent, notification loggers — rather than
assuming Phase 1 covered everything. Note that `mask()`'s `PHONE_RE = /\+?\d{7,}/g`
over-matches: Phase 3's cross-repo smoke test found it asterisking the 13-digit
timestamp inside connection ids, degrading a diagnostic. That is open ledger item 5.

---

## Anti-patterns this project has already paid for

Downstream agents must apply these — each one has a real incident behind it:

1. **A 2xx proves nothing.** Established in Phase 4 against `web-slide/server.js`, which
   returns 200 unconditionally with silent per-field fallbacks. For Phase 5 the analogue
   is: a test asserting `res.status === 200` on `/status/:jobId` proves nothing about the
   body. Assert exact response shape — `Object.keys(body).sort()` — so a field silently
   disappearing or a PII field silently appearing both fail loudly.
2. **Counting arithmetic.** Six defects across four phases came from asserted counts that
   were never measured. Never state a count without running the command.
3. **Grep false positives.** Four times now a grep has hit a comment *explaining an
   absence* and looked like a finding — including twice while verifying Phase 4. Open the
   file and read the surrounding lines before reporting any grep-derived discrepancy.
4. **Persisted state vs in-memory timers.** Cost this project a 6.7-hour stuck booth in
   Phase 2 and recurred in Phase 4. Anything Phase 5 introduces with a timer must survive
   a restart or must be explicitly documented as ephemeral-by-design.
5. **The `gsd-tools` cwd trap.** Planning paths resolve from cwd. Always run `gsd-tools`
   from `/opt/mirror_request_dslrobooth`. `mirror-request/.planning/` and
   `dslrbooth-agent/.planning/` are stale, obsolete trees — never read or write them.

---

## Open gaps carried into this phase (not Phase 5 defects)

- **`.planning/WINDOWS.md` has 2 open ledger entries.** Item 4 (test DB singleton) is
  closed by D-16. Item 5 (connection-id masking) is touched by D-17. `/gsd-ship` blocks
  while `open_count > 0` — Phase 5 can clear both.
- **Phase 3's Agent-auth cutover is still undeployed.** Server and Agent must ship in the
  same maintenance window per `OPS-RUNBOOK.md` §7. This blocks any real end-to-end
  verification of Phase 5 too, since a live queue needs a live Agent.
- **`NOTIFY_WEBHOOK_URL` production reachability was never verified** — the sandbox denies
  all access to `.env*`. Operator's pre-deploy step. The same constraint will apply to any
  new Phase 5 config key.

---

## Deferred ideas (not this phase)

- **Idempotency key on the `web-slide` receiver.** Phase 4's verifier recorded that
  delivery is at-least-once in the narrow window where the process dies after the receiver
  accepts the POST but before the `delivered` commit; the lease then expires and the row
  re-delivers, so a guest could see their photo appear twice. Fixing it means changing the
  receiver, which is a different service and a different phase.
- **Historical/analytics views over `job_history`.** Not in M5.
- **Operator-facing dashboard.** `/display-screen` is a guest-facing room display; an
  operator console is a separate capability.

---

<canonical_refs>
Every path is relative to `/opt/mirror_request_dslrobooth`.

| Ref | Path | Why |
|---|---|---|
| Roadmap | `.planning/ROADMAP.md` (§ Phase 5, § M5) | Phase boundary and success criteria |
| Requirements | `.planning/REQUIREMENTS.md` (API-01:46, API-02:47, AUTH-03:14) | REQ-IDs this phase closes |
| State | `.planning/STATE.md` | Current focus, Known Issues, carry-forward |
| Window ledger | `.planning/WINDOWS.md` | 2 open entries; blocks `/gsd-ship` |
| Ops runbook | `mirror-request/docs/OPS-RUNBOOK.md` (§3 config :108, §7 Agent auth :285, §8 notification :425) | Config surface and deploy rules |
| Project hard rules | `mirror-request/CLAUDE.md` | Read-only backend DB; no direct dslrBooth API; logic lives server-side |
| Phase 4 verification | `.planning/phases/04-guest-notification/04-VERIFICATION.md` | The at-least-once note behind the deferred idea |
| Prior context | `.planning/phases/0{2,3,4}-*/0{2,3,4}-CONTEXT.md` | Decisions carried forward |

No external specs or ADRs exist for this project — the planning tree is the only
authority.
</canonical_refs>

<code_context>
**Reusable, follow these rather than inventing:**
- Constructor injection of the store and of timing config — `src/queue/queueService.ts`
  (Phase 2 pattern). D-16 applies it to `DisplayServer`.
- IP allow-list + single generic 403 — `src/ingestion/mirrorReceiver.ts` (Phase 1). D-09
  reuses this for the display endpoints.
- Constant-time credential compare with a length guard + 401 before the WS handshake —
  `src/agent/agentServer.ts:42,59-67` (Phase 3). Reference only: D-09 explains why it
  cannot transfer to a browser client.
- Structural guarantees expressed in the shape of a type or a SQL statement rather than a
  deletable `if` — `src/state/localStore.ts:435,446` (Phase 4 D-05). D-15 applies the same
  idea to `DisplaySnapshot`.
- Exact-key response assertions against a real ephemeral server —
  `test/notification-sweeper-restart.test.ts:96-135` (Phase 4). The model for Phase 5's
  API tests.
- Log masking — `mask()` and `PHONE_RE`, Phase 1. Note the over-match in D-17.

**Test config:** `mirror-request/vitest.config.ts:12` points `LOCAL_STORE_PATH` at
`./data/test-extension-service.sqlite`. Tests do not touch the production database.

**Baseline:** 27 test files / 182 tests green; typecheck and build clean at HEAD
`419763f`.
</code_context>
