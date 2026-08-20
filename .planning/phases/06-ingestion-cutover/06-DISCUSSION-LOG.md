# Phase 6: Ingestion Cutover - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-11
**Phase:** 06-ingestion-cutover
**Areas discussed:** Source of `registered_at`, Empty guest name, Historical rows at cutover, Broken-VIEW behaviour

---

## Source of `registered_at` (and whether `dbPoller` gets modified)

| Option | Description | Selected |
|--------|-------------|----------|
| Join via `event_manager_attendance` | Use `event_manager_attendance.created_at`. Measured distinct 9/9, and present for 9/9 `valid` tickets but 0/18 `cancelled`+`temporary` — so the INNER JOIN is both a per-ticket timestamp and the validity filter. Tie hazard disappears; `dbPoller` untouched. Cost: one more `ets_web` table in the dependency surface. | ✓ |
| Compound cursor in `dbPoller` | Keep `ticketing_order.created_at` + `WHERE t.status='valid' AND o.status='completed'`, change the poller to a `(registered_at, id)` key. Most universally correct and immune to any future tie source, but modifies extension code and the persisted SQLite cursor format. | |
| Microsecond offset inside the VIEW | Keep `order.created_at` but add a `t.id`-derived microsecond offset to break ties. No code change, but hides a correctness fix inside a SQL expression a later reader cannot account for. | |

**User's choice:** Join via `event_manager_attendance` (the recommended option).
**Notes:** The measurement that drove this was taken during the discussion, not
assumed. The two previously-tied tickets `A523ZC1W` and `WHD4Q2C0` share
`ticketing_order.created_at = 2026-07-27 10:38:01.701017` exactly, but separate
to `10:38:24.318053` / `10:38:24.366242` under the attendance timestamp. The
1:1 attendance-to-valid-ticket correspondence was stated to the user as
*observed on 27 rows, not a declared constraint*, and CONTEXT.md D-03 turns that
caveat into three explicit research questions rather than letting it pass as
settled.

---

## Empty guest name

| Option | Description | Selected |
|--------|-------------|----------|
| Never empty | `first+last` → `display_name` → `username` → synthetic label `Khách • <last 4 of ticket_code>`. Nobody is silently dropped by Phase 1's D-06. A `warn` fires whenever the chain falls past the real name. | ✓ |
| Stop at username | `first+last` → `display_name` → `username` → `email`. Always non-empty, but the room's big screen would display strings like `anh.nd31` or a guest's email address. | |
| Only first+last, else skip | Accept real names only; empty rows fall to D-06's skip with the log raised to `warn`. Clean display, but a guest standing at the booth may never be called with no visible reason. | |

**User's choice:** Never empty (the recommended option).
**Notes:** Grounded on a measurement — 4 of the 9 current valid rows have no
`first_name`/`last_name` at all. The deciding argument was the interaction with
Phase 1's D-06: a missing name does not produce an error, it produces silence,
and silence at a live event is the worst available failure mode. The `warn` in
D-05 exists so the safety net cannot quietly become the normal path.

---

## Historical rows at cutover

| Option | Description | Selected |
|--------|-------------|----------|
| Seed cursor to now | Skip all 9; prove the phase with a fresh registration made on the live landing page during cutover. Stronger evidence, because it exercises landing page → `ets_web` → VIEW → poller → queue → Agent → booth → slideshow rather than only the second half. | ✓ |
| Replay the most recent row | Seed just before `XACX2T63` (2026-08-07) for exactly one real-data run, then seed forward. | |
| Replay all 9 | Leave the cursor at its 1970 default for the first run. Most test data and forces FIFO behaviour into the open, but runs 9 booth sessions for people who are not present. | |

**User's choice:** Seed cursor to now (the recommended option).
**Notes:** `dbPoller.ts:98` defaults the cursor to `1970-01-01T00:00:00.000Z`,
so "do nothing" is not a neutral option here — it is the replay-all-9 option by
omission. CONTEXT.md D-06 therefore makes the seeding an explicit cutover step,
and D-07 records that the proof is a real new registration.

---

## Broken-VIEW behaviour

| Option | Description | Selected |
|--------|-------------|----------|
| Never block | Probe at startup and periodically; log `error` and alert through the existing `NOTIFY_WEBHOOK_URL`, always keep serving. Ingestion dies but queue, booth, display and notifications for already-queued guests survive. | ✓ |
| Refuse to start | Fail fast on a broken VIEW, matching `config.ts`'s production env fail-fast; log only when already running. Consistent with the existing pattern, but one restart mid-event would take down the whole service instead of ingestion alone. | |
| Log `error` only | No probe at all. Least work, but Phase 6 success criterion 6 — detect before an event, not during one — would not be met. | |

**User's choice:** Never block (the recommended option).
**Notes:** This is a deliberate departure from an established project pattern,
so CONTEXT.md D-09 records the departure and its reasoning explicitly rather
than leaving a future reader to assume the fail-fast convention was overlooked.

---

## Claude's Discretion

Taken without asking, and recorded in CONTEXT.md so they remain visible:

- **Capture mode = `'print'`** (D-08). `ets_web` has no concept of a photobooth
  capture mode, so the value is ours; `'print'` matches the Agent's own fallback
  at `dslrbooth-agent/src/index.ts:70`. Flagged in CONTEXT.md that the value is
  never validated anywhere — it reaches dslrBooth's `/start?mode=` verbatim, so
  a wrong string fails at the booth in front of a guest.
- Exact VIEW SQL text, `SECURITY INVOKER`/`DEFINER`, and the precise `GRANT`
  statement, bounded by: read-only grant, and output columns exactly the six
  `dbPoller.ts:101` selects.
- Probe mechanism, cadence and alert payload, bounded by D-09's never-block rule.
- Rate-limiter algorithm, window and threshold, bounded by not letting a
  throttled response confirm that an id exists.
- Where the `photobooth.registrations` rollback artefact is stored.

## Scope note raised during the discussion

Rate limiting `/status/:jobId` was part of the Phase 6 proposal the user
approved, but was omitted from the ROADMAP success-criteria list when the phase
was written up. It is recorded in CONTEXT.md as D-10 and treated as in scope,
with the omission stated plainly rather than resolved silently. D-10 also
settles `WINDOWS.md` item 6 factually: `ticket_code` is generated by
`secrets.choice` (a CSPRNG) over a 32-character Crockford alphabet, 8 characters
long — **40 bits**, which rules out the sequence/timestamp worst case that
blocked Phase 5 but sits well under the ≥128-bit capability-URL guidance.

## Deferred Ideas

- **Agent configuration UI** — raised by the user in the same conversation
  (*"agent đang config bằng tay điều này không tốt cho khâu vận hành"*), with a
  request for a UI and a connection test. A new capability with its own UI
  surface; belongs in its own phase.
- **Exposing `qrcode_url` in the guest notification** — the VIEW could carry it,
  but the payload shape was settled in Phase 4 and changing it touches
  `web-slide`'s receiver.
- **Keying the queue on check-in instead of registration** — `scanned_at` and
  `event_manager_attendance` would support it, but `scanned_at` is populated on
  0 of 9 valid tickets, so check-in is unused today.
