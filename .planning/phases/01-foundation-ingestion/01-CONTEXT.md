# Phase 1: Foundation & Ingestion - Context

**Gathered:** 2026-08-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the central-service ingestion foundation: securely accept registrations
from Mirror Request, persist the data and processing state locally, de-duplicate
repeated submissions, and use read-only database polling as a fallback. Queue
dispatch, Agent control, photobooth handling and slideshow delivery are outside
this phase.

</domain>

<decisions>
## Implementation Decisions

### Duplicate registration handling

- **D-01:** Reject a repeated registration inside a configurable time window;
  default `REGISTRATION_DEDUP_WINDOW_MS` is 5 minutes (300,000 ms).
- **D-02:** Identity comparison prioritizes source `id`; if it is absent, use
  email or phone number. — **Reversibility:** costly — changing identity rules
  changes which persisted registrations are considered the same person.
- **D-03:** For a duplicate, return HTTP 200 with the original `jobId`; never
  create a new queue job.
- **D-04:** If database polling finds a registration already received through
  Mirror Request, skip it and emit an informational reconciliation log.

### Database polling resilience

- **D-05:** A DB connection/query failure logs a warning and retries on the
  next cycle; it must not stop the service.
- **D-06:** A source record without `id` or `name` is skipped, logged for
  audit, and does not block cursor advancement.
- **D-07:** Phase 1 records polling warnings in structured log files only;
  there is no separate error table or operations webhook.
- **D-08:** Poll interval is configurable with a 3-second default.

### Registration endpoint security

- **D-09:** Protect `POST /on-register` with HMAC-SHA256 plus IP allow-list.
  Production requires both controls; other environments may configure them.
  — **Reversibility:** costly — this is a published integration contract with
  the form/Mirror Request system.
- **D-10:** Use `X-Webhook-Signature`, `X-Webhook-Timestamp`, and
  `X-Webhook-Id`; verify the signature against the raw request body.
- **D-11:** Timestamp acceptance is configurable, with a 5-minute default;
  reject replayed request IDs.
- **D-12:** Authentication failures return HTTP 403 and log only a general
  reason, never secrets or validation detail.

### Stored data and logging

- **D-13:** SQLite retains operational fields, email, phone number, and the
  raw Mirror Request payload for reconciliation and debugging.
- **D-14:** Retention is manual; the operator deletes data when appropriate.
  — **Reversibility:** costly — automatic retention would alter stored
  operational data and require a cleanup/migration policy.
- **D-15:** Runtime logs partially mask email and phone numbers and emphasize
  `id`, status, and error reason.
- **D-16:** Raw payloads are never logged in production; they may be emitted
  only with `DEBUG` enabled in development.

### the agent's Discretion

- Choose the exact HMAC canonical string and the persistent mechanism for
  replayed request IDs, provided the three agreed headers and raw-body HMAC
  validation remain compatible with the source system.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product scope

- `.planning/PROJECT.md` — central photobooth service purpose and boundaries.
- `.planning/REQUIREMENTS.md` — Phase 1 requirements ING-01..03, STO-01 and AUTH-02.
- `.planning/ROADMAP.md` — milestone success criteria and Phase 1 record.

### Codebase and integration context

- `.planning/codebase/ARCHITECTURE.md` — system topology and central data flow.
- `.planning/codebase/INTEGRATIONS.md` — registration inputs and current endpoints.
- `.planning/codebase/CONVENTIONS.md` — configuration, storage, error and logging patterns.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `mirror-request/src/ingestion/mirrorReceiver.ts`: existing `/on-register`
  Express route, IP matching and idempotent enqueue behavior.
- `mirror-request/src/ingestion/dbPoller.ts`: polling lifecycle, MySQL pool and
  local cursor integration.
- `mirror-request/src/state/localStore.ts`: SQLite WAL database, processed-ID
  tracking, registration persistence and cursors.
- `mirror-request/src/config.ts`: typed environment parsing and startup validation.
- `mirror-request/src/logging/logger.ts`: logging helpers to use for masked logs.

### Established Patterns

- Keep application composition in `mirror-request/src/index.ts`; keep feature
  behavior in focused modules.
- Use `LocalStore` prepared statements for all durable central state.
- Recover at network boundaries through logs and future retry, instead of
  taking down the process.

### Integration Points

- Add raw-body HMAC validation before JSON parsing for `/on-register`.
- Extend `EnvConfig` and `loadConfig()` for deduplication, polling and webhook
  security configuration.
- Extend `LocalStore` schema/methods only as necessary for time-window dedupe,
  invalid-record auditing and webhook replay protection.

</code_context>

<specifics>
## Specific Ideas

The end-to-end product flow is: form registration → source system/Mirror Request
→ central server → Agent displays guest and position → photobooth session →
`end_session` → name and photo posted to slideshow. This phase owns only the
ingestion segment.

</specifics>

<deferred>
## Deferred Ideas

- Queue behavior belongs in the later Queue & Booth State phase.
- Agent command/display behavior belongs in a later Agent WebSocket phase.
- Name-and-photo slideshow delivery belongs in a later notification/display phase.

</deferred>

---

*Phase: 01-foundation-ingestion*
*Context gathered: 2026-08-10*
