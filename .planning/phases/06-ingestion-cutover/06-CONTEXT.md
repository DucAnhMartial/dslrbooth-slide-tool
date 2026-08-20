# Phase 6: Ingestion Cutover - Context

**Gathered:** 2026-08-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Connect the live `ets_web` registration data to the Extension Service's
already-built ingestion path, read-only, so that a guest who registers on the
existing landing page reaches the booth queue.

Everything downstream of ingestion — queue, Agent link, booth session,
notification, display feed — is already built and verified across Phases 1-5
and is **not** re-opened here. This phase supplies the input those phases have
never had.

**Hard constraint, set by the human and not negotiable:** no change to
web-ticket's code and no write of any kind to `ets_web`'s data or schema. The
only writes anywhere are `DROP TABLE` / `CREATE VIEW` inside the `photobooth`
database — a zero-row table this project owns — plus a read-only `GRANT`.
`mirror-request/CLAUDE.md`'s "NEVER write to the real backend DB" rule holds:
`GRANT SELECT` confers no write capability.

**Out of scope:** the Agent configuration UI (raised by the human in the same
conversation, deferred below); any change to the queue, Agent, notification or
display subsystems; any change to how `/on-register` authenticates.

</domain>

<decisions>
## Implementation Decisions

### Source of `registered_at` and the tie hazard

- **D-01:** The VIEW derives `registered_at` from
  `event_manager_attendance.created_at`, reached by an INNER JOIN on
  `event_manager_attendance.ticket_id = ticketing_ticket.id`.
  **Measured 2026-08-11 on live data:** that column is distinct across all 9
  rows (`COUNT(*) = COUNT(DISTINCT created_at) = 9`), whereas
  `ticketing_order.created_at` — the obvious first choice — ties exactly when
  one order carries two tickets (`A523ZC1W` and `WHD4Q2C0`, both
  `2026-07-27 10:38:01.701017`). Since `dbPoller.ts:101` filters
  `registered_at > ?` and `dbPoller.ts:132` advances the cursor to the last row
  of the batch, a `LIMIT` boundary falling between two tied rows drops the
  second guest permanently and silently. Sourcing the timestamp per-ticket
  removes that failure mode at the source instead of compensating for it.
  — **Reversibility:** reversible — the VIEW can be redefined in one statement;
  no persisted state depends on which column it selected.

- **D-02:** `dbPoller.ts` is **not** modified. Its `registered_at > ?` cursor
  and the SQLite cursor format stay exactly as shipped. This was the explicit
  reason D-01 was chosen over a compound `(registered_at, id)` cursor: the
  compound key is the more universally correct fix, but it changes extension
  code and the persisted cursor format to solve a problem the data model can
  dissolve on its own.
  — **Reversibility:** reversible — if a future source does tie, the compound
  cursor remains available as a follow-up.

- **D-03:** The same INNER JOIN is the validity filter. **Measured:**
  `event_manager_attendance` rows exist for 9/9 `valid` tickets and 0/18
  `cancelled` + `temporary` tickets. A cancelled or unconfirmed ticket is
  therefore structurally incapable of producing a VIEW row — the guarantee
  lives in what the JOIN omits, not in a `WHERE` clause a later editor can
  delete. This is the same omission-as-guarantee discipline used in Phase 2's
  `requeueWithRetry` and Phase 4's `getDueNotifications`.

  **Research must confirm, not assume:** the 1:1 correspondence above is
  *observed over 27 rows*, not a declared constraint. `gsd-phase-researcher`
  must read `/opt/web-ticket/qrcode/ets_web/apps/` and establish (a) whether an
  attendance row is created for every confirmed registration, (b) whether
  cancelling a ticket deletes or retains its attendance row, and (c) whether
  more than one attendance row can ever exist for one ticket — which would
  duplicate a guest into the queue. If (c) is possible, the JOIN needs
  de-duplication and this decision must be revisited before planning completes.

### Guest name

- **D-04:** The name fallback chain never yields an empty value:
  `TRIM(CONCAT(first_name, ' ', last_name))` → `account_personalinfo.display_name`
  → `ticketing_customer.display_name` → `ticketing_customer.username` →
  a synthetic label of the form `Khách • <last 4 of ticket_code>`.
  **Why it must never be empty:** Phase 1's D-06 skips any source row missing
  `id` or `name`, and does so with a log line and no other signal. A guest
  standing at the booth would simply never be called, with nothing on any screen
  explaining why. **Measured:** 4 of the 9 current valid rows have no
  `first_name`/`last_name` at all.

- **D-05:** Every fall-through past `first_name`/`last_name` emits one `warn`
  log naming the ticket code and which rung of the chain supplied the name.
  The synthetic label is a safety net, not a normal outcome — if it fires in
  production it means the landing page is not capturing names the way the
  registration API's schema implies it does, and that must be visible.

### Cutover

- **D-06:** At cutover the `registrations` cursor is seeded to the current
  timestamp, so none of the 9 historical rows is dispatched. **Measured:**
  `dbPoller.ts:98` defaults the cursor to `1970-01-01T00:00:00.000Z`, so
  enabling ingestion unseeded would queue all 9 at once — sessions for people
  who registered in July and are not in the room.

- **D-07:** The end-to-end proof is a **real registration created on the live
  landing page during the cutover**, not a replay of historical data. Replaying
  an old row would exercise only VIEW → booth; a fresh registration exercises
  landing page → `ets_web` → VIEW → poller → queue → Agent → booth → slideshow,
  which is the claim Phase 6 actually makes.

### Capture mode

- **D-08:** The VIEW emits the literal `'print'` for `mode`. `ets_web` has no
  concept of a photobooth capture mode, so the value is ours to choose;
  `'print'` matches the Agent's own fallback at
  `dslrbooth-agent/src/index.ts:70`. **This value is never validated anywhere** —
  it flows verbatim from the source row through `queueService.ts:283` to the
  Agent and into dslrBooth's `/start?mode=` query string, so an unsupported
  string fails at the booth, at session time, in front of a guest. Planning must
  treat the VIEW's mode literal as a value dslrBooth is known to accept.

### VIEW health

- **D-09:** A broken VIEW never blocks the service. The probe runs at startup
  and periodically; on failure it logs `error` and emits an alert through the
  existing `NOTIFY_WEBHOOK_URL` channel, and the process continues serving.
  **Rationale:** if an upstream `ets_web` migration breaks the VIEW, ingestion
  is dead either way — but the queue, booth, display and guest notifications for
  everyone already queued keep working. Refusing to start converts an ingestion
  outage into a total outage, and the moment that matters most is a restart in
  the middle of a live event. This deliberately departs from `config.ts`'s
  production fail-fast pattern, and the departure is the decision.

### Capability-URL entropy — resolves a long-open blocker

- **D-10:** This phase settles the question that has blocked `/gsd-ship` since
  Phase 5 (`WINDOWS.md` item 6, and D-07 of `05-CONTEXT.md`): *does the backend
  mint `registrations.id` with a CSPRNG?* With this VIEW, `registrations.id` is
  `ticketing_ticket.ticket_code`. **Measured** in
  `/opt/web-ticket/qrcode/ets_web/apps/ticketing/short_code.py`: it is generated
  with `secrets.choice` — a CSPRNG, explicitly chosen over `random.choice` in a
  source comment — over a 32-character Crockford base32 alphabet, 8 characters
  long. **That is 40 bits of entropy**, well below the ≥128-bit guidance for a
  capability URL (ASVS V2).

  So the worst case behind D-06/D-07 of Phase 5 is ruled out — the id is not a
  sequence and not a timestamp, and enumeration by guessing the *pattern* is not
  possible. But 40 bits is brute-forceable by an unthrottled attacker, and
  `/status/:jobId` deliberately returns 200 for a valid foreign id, because
  holding the id *is* the authorisation. **Phase 6 therefore adds rate limiting
  to `/status/:jobId`**, which is the mitigation that makes the shipped design
  sound at this entropy level.

  Planning note: this item was named in the Phase 6 proposal the human approved,
  but was not carried into the ROADMAP success-criteria list. It is in scope.
  — **Reversibility:** reversible — the limiter is additive middleware on one
  route.

### Claude's Discretion

- The exact SQL text of the VIEW, the choice of `SECURITY INVOKER` vs
  `SECURITY DEFINER`, and the precise `GRANT` statement — provided the grant
  confers read access only and the VIEW's output columns are exactly
  `id, name, email, phone, mode, registered_at`, the six `dbPoller.ts:101`
  selects, with types assignable to `photobooth.registrations`'s current
  definition (`id varchar(255)` accommodates `ticket_code varchar(100)`).
- The probe's mechanism, cadence, and alert payload shape (D-09), provided it
  cannot block startup or terminate the process.
- The rate limiter's algorithm, window, and threshold (D-10), provided a
  throttled response is not distinguishable in a way that confirms an id exists.
- Where the `photobooth.registrations` rollback artefact lives — the current
  `CREATE TABLE` must be captured before the `DROP` so the pre-phase state can
  be restored in one statement.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Repository topology — read first, this project has three `.planning` trees

- `/opt/mirror_request_dslrobooth/.planning/` — **the only authoritative
  planning tree.** `mirror-request/.planning/` and
  `dslrbooth-agent/.planning/` are stale, git-tracked, and must never be read
  or written. A prior phase (03-03) wrote to the stale tree by accident because
  a tool resolved its cwd from inside `mirror-request/`; run planning tools from
  `/opt/mirror_request_dslrobooth`.

### Project scope and prior decisions

- `.planning/PROJECT.md` — service purpose and boundaries.
- `.planning/REQUIREMENTS.md` — ING-02, ING-03 are this phase's requirements.
- `.planning/ROADMAP.md` § "Phase 6: Ingestion Cutover" — goal and the six
  success criteria.
- `.planning/STATE.md` § Milestones, Phase 6 row — the full measured evidence
  behind this phase, and § "Accumulated Context / Roadmap Evolution" for why
  the nginx `mirror` approach was rejected.
- `.planning/phases/01-foundation-ingestion/01-CONTEXT.md` — **binding.** D-04
  (webhook/poller reconciliation), D-05 (DB failure warns and retries), D-06
  (rows missing `id`/`name` are skipped — the reason D-04 above exists), D-08
  (3-second poll interval). None of these are re-opened.
- `.planning/WINDOWS.md` items 4 and 6 — item 6 is resolved factually by D-10.

### Extension Service source — the consumer contract

- `mirror-request/CLAUDE.md` — the read-only-backend hard rule.
- `mirror-request/src/ingestion/dbPoller.ts` — lines 92-133 are the entire
  contract the VIEW must satisfy: the six selected columns, the strict `>`
  cursor filter, the batch `LIMIT`, the `id`/`name` skip, the `isProcessed`
  reconciliation, and the cursor advance.
- `mirror-request/src/config.ts` — `DB_*` keys, and the production fail-fast
  block D-09 deliberately does not follow.
- `mirror-request/src/status/statusRoute.ts` — the route D-10 rate-limits.
- `mirror-request/docs/OPS-RUNBOOK.md` — §3 (env keys) and §7 (deploy) need the
  VIEW, the GRANT, the cursor-seeding step and the rollback recorded.

### ets_web — read-only source of truth, never modified

- `/opt/web-ticket/qrcode/.env` — `DATABASE_URL=mysql://ets_web:***@127.0.0.1/ets_web`;
  the same MySQL instance as `photobooth`, which is what makes a cross-database
  VIEW possible at all.
- `/opt/web-ticket/qrcode/ets_web/apps/ticketing/models.py` — ticket, order,
  customer models; line ~704 assigns `ticket_code`.
- `/opt/web-ticket/qrcode/ets_web/apps/ticketing/short_code.py` — the
  `secrets.choice` / Crockford-base32 generator behind D-10's 40-bit finding.
- `/opt/web-ticket/qrcode/ets_web/apps/api_public/schemas.py` — the registration
  request/response schemas; `ticket_code` and `qrcode_url` appear only in the
  **response**, which is why an nginx `mirror` of the request could never have
  worked.
- The attendance model behind `event_manager_attendance` — **must be located
  and read** to discharge the three research questions in D-03.

### Codebase maps — treat as stale

- `.planning/codebase/INTEGRATIONS.md` — mapped 2026-08-10 and **now wrong in
  two places**: it says the Agent WS uses a query-string token (Phase 3 replaced
  this with an `Authorization: Bearer` header) and that `/display` is
  unauthenticated (Phase 5 put it behind an IP allow-list and refuses at the raw
  socket). Use it for orientation only; verify every claim against source.
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONVENTIONS.md` —
  topology and config/logging/error patterns.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `mirror-request/src/ingestion/dbPoller.ts` — **already complete.** The poller,
  its MySQL pool, its SQLite cursor and its reconciliation with the webhook path
  were built and tested in Phase 1. This phase writes no polling code; it
  supplies the table the poller has always been reading and has never found
  anything in.
- `mirror-request/src/state/localStore.ts` — `getCursor`/`setCursor` are the
  mechanism D-06's seeding uses; no new schema is needed.
- `mirror-request/src/notifications/notificationService.ts` — the outbound
  webhook D-09's alert should reuse rather than reinvent, including its timeout
  and retry handling.
- `mirror-request/src/security/ipAllowlist.ts` — the Phase 5 module showing this
  project's shape for route-level middleware, the closest analog for D-10's
  limiter.

### Established Patterns

- **Omission as guarantee.** Phases 2 and 4 express structural guarantees by
  what the SQL leaves out, not by an `if` a later editor can delete. D-03 is the
  same discipline applied to a JOIN.
- **Never crash on a network boundary.** D-05 of Phase 1 and D-10 of Phase 4
  both log and continue rather than terminate; D-09 follows them, not
  `config.ts`'s fail-fast.
- **Config injected through the constructor, not read from a singleton.** Every
  timing and threshold value since Phase 2 is injectable so tests can drive it.
- **Comment-matching greps have produced four false positives in this project.**
  Any count used to justify a decision must be verified by opening the files,
  not by `grep -c`.

### Integration Points

- `photobooth.registrations` — currently `BASE TABLE`, 0 rows. Becomes a VIEW.
  Its `CREATE TABLE` definition must be captured before the `DROP` as the
  rollback artefact.
- MySQL grants — the service's DB user's `SHOW DATABASES` currently returns only
  `information_schema`, `performance_schema`, `photobooth`. It cannot see
  `ets_web` at all, so the VIEW is unreadable by it until a `GRANT SELECT` is
  issued.
- `mirror-request/src/index.ts:52-63` — where `DBPoller` is constructed. It is
  wired unconditionally today; there is no enable/disable flag, so cursor
  seeding (D-06) must happen before the process starts, not after.
- `mirror-request/src/status/statusRoute.ts` — D-10's limiter mounts here.

</code_context>

<specifics>
## Specific Ideas

The human's framing, in their own words, is the constraint that shaped every
decision above: *"chủ trương ban đầu sẽ tận dụng lại api đăng ký
/api/v1/public/register/{event_code}/{slug} … nhưng tôi lại ko muốn sửa code"* —
reuse the existing registration API and its landing page, without modifying its
code. A VIEW satisfies this because it is DDL on the database, not application
code.

The originally intended mechanism was an nginx `mirror` of that endpoint. It was
analysed and rejected on two grounds that are properties of the directive
itself, not of its configuration:

1. `mirror` duplicates the **request**. The fields the booth needs — `ticket_code`,
   `qrcode_url` — exist only in the **response**.
2. The mirrored request fires before the response decides whether registration
   succeeded, so failed and `payment_required` registrations would reach the
   booth. The VIEW's join excludes them structurally.

Measured shape of the live source, for the researcher's orientation:

```
ticketing_ticket            27 rows   valid 9 / cancelled 16 / temporary 2
  ├─ ticket_holder_id  ──→  account_personalinfo   first_name, last_name, phone
  └─ order_detail_id   ──→  ticketing_orderdetail
                              └─ order_id ──→ ticketing_order   16 rows
                                                 (completed 7 / cancelled 8 / pending 1)
                                                   └─ customer_id ──→ ticketing_customer
                                                                        email, display_name
event_manager_attendance     9 rows   ticket_id ──→ ticketing_ticket.id
                                      created_at distinct 9/9   ← D-01's source
```

`ticketing_customer` has **no** phone column; phone comes only from
`account_personalinfo`, and is therefore absent whenever `ticket_holder_id` is
NULL. `scanned_at` is populated on **0 of 9** valid tickets — check-in has never
been used, which is why registration time, not check-in time, is the trigger.

</specifics>

<deferred>
## Deferred Ideas

- **Agent configuration UI.** The human raised this as a real operational
  problem in the same conversation: *"Hiện tại agent đang config bằng tay điều
  này không tốt cho khâu vận hành cho lắm"*, and asked for a UI to enter those
  variables, with a connection test. `dslrbooth-agent/src/config.ts` currently
  requires `DSLRBOOTH_PASSWORD`, `EXTENSION_SERVICE_WS_TOKEN` and
  `EXTENSION_SERVICE_WS_URL` to be hand-set per machine, and its
  `TRIGGER_SERVER_PORT` default of 3001 collides with `web-slide`. This is a new
  capability with its own UI surface — it belongs in its own phase, not here.
- **Backfilling `qrcode_url` into the guest notification.** The VIEW could
  expose it, but the notification payload shape was settled in Phase 4 and
  changing it touches `web-slide`'s receiver. Separate phase if wanted.
- **Keying the queue on check-in rather than registration.** `scanned_at` and
  `event_manager_attendance` would support it, but check-in is unused today
  (0/9 populated). Revisit only if an event actually uses check-in.

</deferred>

---

*Phase: 06-ingestion-cutover*
*Context gathered: 2026-08-11*
