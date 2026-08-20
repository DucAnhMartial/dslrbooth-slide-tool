# Phase 1: Foundation & Ingestion - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-10
**Phase:** 01-foundation-ingestion
**Areas discussed:** Duplicate registration handling, Database polling resilience, Registration endpoint security, Sensitive data and logging

---

## Duplicate registration handling

| Decision | Selected outcome |
| --- | --- |
| Rejection window | Configurable; 5 minutes by default |
| Same-person key | Source `id`, then email or phone when no ID exists |
| Duplicate response | HTTP 200 with original `jobId` |
| DB reconciliation | Skip duplicate record and write an informational log |

**Notes:** The source may submit the same person repeatedly; it must not create another photo session.

---

## Database polling resilience

| Decision | Selected outcome |
| --- | --- |
| Connection/query error | Warn and retry next cycle without stopping service |
| Missing `id` or `name` | Skip, audit/log, advance cursor |
| Error recording | Structured log files only in Phase 1 |
| Interval | Configurable; 3 seconds by default |

**Notes:** A malformed source row must not block later registrations.

---

## Registration endpoint security

| Decision | Selected outcome |
| --- | --- |
| Authentication | HMAC-SHA256 plus IP allow-list |
| Header contract | `X-Webhook-Signature`, `X-Webhook-Timestamp`, `X-Webhook-Id` |
| Replay tolerance | Configurable; 5 minutes by default |
| Failed authentication | HTTP 403 with general logging only |
| Environment policy | Production requires both HMAC and allow-list |

**Notes:** Secret stays in `mirror-request/.env` and is never logged.

---

## Sensitive data and logging

| Decision | Selected outcome |
| --- | --- |
| SQLite fields | Operational data, email, phone and raw payload |
| Retention | Manual deletion by operator |
| Runtime logging | Partially mask email/phone |
| Raw payload logging | Development with `DEBUG` only; never production |

---

## the agent's Discretion

- Exact HMAC signing-string format and replay-ID persistence mechanism, subject to the locked header contract.

## Deferred Ideas

- Queue behavior — later Queue & Booth State phase.
- Agent display/control — later Agent WebSocket phase.
- Slideshow delivery — later notification/display phase.
