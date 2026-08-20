---
phase: 08-cms-event-display
reviewed: 2026-08-13T02:20:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - mirror-request/src/state/localStore.ts
  - mirror-request/src/types.ts
  - mirror-request/src/agent/agentConfigContract.ts
  - mirror-request/src/agent/agentServer.ts
  - mirror-request/src/cms/cmsAgentRoutes.ts
  - mirror-request/src/cms/cmsAgentPages.ts
  - mirror-request/src/queue/queueService.ts
  - dslrbooth-agent/src/liveConfig.ts
  - dslrbooth-agent/src/index.ts
  - dslrbooth-agent/src/agentMessages.ts
  - dslrbooth-agent/src/dslrbooth/client.ts
  - mirror-request/test/agent-config-message.test.ts
  - mirror-request/test/cms-agent-config.test.ts
  - mirror-request/test/local-store-persistence.test.ts
  - mirror-request/test/queue-event-photo.test.ts
  - mirror-request/test/queue-event-coverage.test.ts
  - dslrbooth-agent/test/config-reload.test.ts
findings:
  critical: 0
  warning: 2
  info: 2
  total: 4
status: issues_found
---

# Phase 8: Code Review Report — Data Layer & Agent Configuration Contract

**Reviewed:** 2026-08-13T02:20:00Z
**Depth:** standard
**Files Reviewed:** 17 (across two repositories: `mirror-request` and `dslrbooth-agent`)
**Status:** issues_found (no CRITICAL findings; 2 WARNING, 2 INFO)

## Summary

This review targeted the SQLite data layer (`LocalStore`) and the full D-16/D-17/D-18
Agent-configuration contract across both repositories: the allow-list constants
(`agentConfigContract.ts` / `liveConfig.ts`), the WS transport (`agentServer.ts` /
`agentMessages.ts` / `index.ts`), the CMS surface (`cmsAgentRoutes.ts` /
`cmsAgentPages.ts`), the credential-holding client (`dslrbooth/client.ts`), and the
Phase 1–7 queue service's photo-history integration point (`queueService.ts`).

**Locked-decision verification, all held:**

- **D-16** — the four safe fields (`logLevel`, `autoOpenDisplay`, `dslrBoothApiPort`,
  `dslrBoothPassword`) and the four read-only fields (`extensionServiceWsUrl`,
  `extensionServiceWsToken`, `triggerServerPort`, `logDir`) are byte-identical
  constant arrays in both repositories, cross-asserted by
  `test/agent-config-message.test.ts`. Enforcement is genuinely two-sided and
  fail-closed: the CMS route (`validateAgentConfigSubmission`) refuses a save
  carrying any of the four forbidden keys server-side (not merely omitted from the
  form — `dslrbooth-agent`'s `LiveConfig.apply()` independently drops any key not in
  its own allow-list, warning by name only. `dslrbooth-agent/src/config.ts`'s 8-field
  `Config` interface is fully partitioned by the two lists with no gap and no
  overlap — confirmed by direct inspection.
- **D-17** — confirmed a genuine pull: `agentServer.ts`'s `config_request` handler
  reads nothing off the inbound message (`AgentConfigRequestHandler` takes zero
  arguments), and `reload_config` sends no data, only a bare `{type:'reload_config'}`
  event that the Agent answers with its own `config_request`. The Agent never writes
  `.env` or restarts (asserted directly in `config-reload.test.ts`).
- **D-18** — `saveAgentConfig()`'s single UPSERT statement rotates old-current into
  previous atomically (no read-then-write gap), and `restorePreviousAgentConfig()`
  clears `previous_json` on restore, correctly limiting the feature to one step back
  (verified by both unit and integration tests).
- **D-01/D-10/D-11** — the four new Phase 8 tables (`event`, `active_event`,
  `event_photo`, `agent_config`) are all newly created via
  `CREATE TABLE IF NOT EXISTS`; no ALTER TABLE touches a pre-existing Phase 1–7
  table, so the "NOT NULL column with no default breaks an existing production
  database" failure mode this review specifically hunted for does not exist in this
  submission. `event_photo`/`active_event` deliberately carry no FK, and
  `deleteEvent()` explicitly, transactionally removes only that event's photos —
  matching the UI-SPEC's stated confirmation copy rather than contradicting D-11's
  "no automatic delete" (this is an operator-confirmed action, not a timer).
- Guest name and photo URL are captured/denormalized onto `event_photo` at the
  moment the print upload resolves (not re-joined later), so the row is immune to a
  later registration edit or deletion.
- No secret (`dslrBoothPassword`, the Agent WS bearer token) was found rendered into
  HTML, a JSON response, or a log line anywhere in the reviewed files; the CMS page
  never echoes the password into a `value` attribute, and every log call that
  touches a config patch logs field **names** only.
- Concurrency: every DB read-modify-write pair (`saveAgentConfig`, the CMS
  `/api/agent` route's merge-then-save, `deleteEvent`'s transaction) is fully
  synchronous with no `await` between the read and the write, and better-sqlite3
  itself is synchronous — so there is no interleaving window despite two separate
  statements in a few places (e.g. `restorePreviousAgentConfig`'s SELECT then
  UPDATE).

Two WARNING-level quality/robustness gaps were found; both are latent (not
exploitable against the code as currently shipped) but should be fixed before they
can silently regress.

## Warnings

### WR-01: `validateAgentConfigSubmission` has no exhaustiveness guard — an allow-listed field with no validation branch is silently dropped instead of refused

**File:** `mirror-request/src/cms/cmsAgentRoutes.ts:61-106`
**Issue:** The function's own docstring states the contract: "Validates one whole
submission, and refuses the WHOLE thing when any part of it is wrong." The
*first* check does exactly that — any key **outside** `SAFE_AGENT_CONFIG_FIELDS`
triggers an immediate `{ok: false}`. But a key that **passes**
`isSafeAgentConfigField(key)` and then matches none of the four
`if (key === '...')` branches falls through to the bottom of the `for` loop with no
`else`/`default` clause: nothing is added to `patch`, no error is raised, and the
loop simply continues to the next entry. `store.saveAgentConfig()` is then still
called with `result.ok === true`, and the route responds `200 saved: true` — even
though the field the operator believed they changed was silently discarded.

Today this is unreachable because `SAFE_AGENT_CONFIG_FIELDS` names exactly four
fields and all four have a branch. But `SAFE_AGENT_CONFIG_FIELDS` is a shared,
cross-repository contract (`liveConfig.ts` mirrors it) that this project's own
comments describe as something that will grow ("the safe field set is the Agent's
contract... pinning it into columns here would mean a schema migration every time
the Agent gains a tunable" — `localStore.ts:318-321`). The day a fifth field is
added to the allow-list array without a matching validation branch here, the CMS
will report success while quietly not saving the operator's change — the exact
"the operator finds out from a dead booth" failure class D-16's own design notes
warn about for `dslrBoothApiPort` clamping, reintroduced through a different door.

**Fix:** Make the fallthrough impossible rather than silent — e.g. restructure as a
`switch` with no `default` (TypeScript will then flag a non-exhaustive switch over
the `SafeAgentConfigField` union at compile time, exactly the protection
`dslrbooth-agent/src/liveConfig.ts`'s `assign()` method already has), or add an
explicit `else` that returns `{ ok: false }` and logs which safe-listed field has no
handler:

```ts
for (const [key, value] of Object.entries(raw)) {
  if (!isSafeAgentConfigField(key)) {
    log.warn(`Refused Agent configuration save carrying non-editable field "${key}"`);
    return { ok: false };
  }
  switch (key) {
    case 'logLevel': /* ... */ continue;
    case 'autoOpenDisplay': /* ... */ continue;
    case 'dslrBoothApiPort': /* ... */ continue;
    case 'dslrBoothPassword': /* ... */ continue;
    // no default — TypeScript errors here if SafeAgentConfigField grows
    // without this switch growing too.
  }
}
```

### WR-02: A corrupted `agent_config.current_json` row causes the last-known-good configuration to be silently discarded, and the corrupt value gets pushed into (now-unusable) `previous_json`

**File:** `mirror-request/src/agent/agentConfigContract.ts:130-139`,
`mirror-request/src/state/localStore.ts:1228-1260`
**Issue:** `LocalStore.getAgentConfig()` treats a JSON-parse failure on
`current_json` identically to "no row has ever been written" — it logs a warning
and returns `undefined` (`localStore.ts:1228-1240`). `readAgentConfigForAgent()`
then takes the "never configured" branch: it seeds `DEFAULT_AGENT_CONFIG` and calls
`store.saveAgentConfig(seeded)` (`agentConfigContract.ts:130-139`). Because a row
with `id = 1` still exists (just with unparsable `current_json`),
`saveAgentConfig()`'s `ON CONFLICT` branch fires — `previous_json =
agent_config.current_json` — which moves the **corrupt string itself** into
`previous_json`, then overwrites `current_json` with the shipped defaults.

Two compounding effects follow: (1) whatever the operator's real last-saved
configuration was (port, password, log level) is gone, replaced by defaults, with
no indication to the operator that this happened beyond one log line the operator
is unlikely to be watching in real time; and (2) the one-step "restore previous"
button is now poisoned — `restorePreviousAgentConfig()` will read back the same
unparsable string and hit its own `catch`, warn, and return `undefined`
(`localStore.ts:1272-1289`), so D-18's safety net is unavailable for the one
incident it exists to recover from.

This requires the `current_json` column to already hold invalid JSON, which cannot
happen through any writer in this codebase today (`saveAgentConfig` always calls
`JSON.stringify`) — it would need external tampering or a future bug elsewhere. It
is nonetheless untested and represents a real, if low-probability, data-loss path
that defeats D-18's stated purpose ("Keep the previous Agent config") at exactly the
moment it would matter most.

**Fix:** Have `readAgentConfigForAgent()` distinguish "row absent" from "row present
but corrupt" (e.g. by giving `LocalStore` a narrower `hasAgentConfigRow(): boolean`,
or by having `getAgentConfig()` throw a typed error on parse failure rather than
returning `undefined`), and only auto-seed defaults in the genuinely-absent case. On
a corrupt-but-present row, log at `error` (not `warn`) and leave the row untouched
rather than auto-writing over it, so an operator investigating a "booth suddenly
reset to defaults" report can still find the raw corrupt blob for diagnosis instead
of it having been silently relocated into an equally-unusable `previous_json`.

## Info

### IN-01: The "config-request seam takes no arguments" test does not exercise the production code it claims to pin

**File:** `mirror-request/test/agent-config-message.test.ts:214-221`
**Issue:**

```ts
it('the config-request seam takes no arguments, so there is nothing off the wire it could read', () => {
  const handler = (): Record<string, unknown> => ({});
  expect(handler.length).toBe(0);
  expect(AgentServer.prototype.registerConfigRequestHandler).toBeTypeOf('function');
  expect(AgentServer.prototype.registerConfigRequestHandler.length).toBe(1);
});
```

`handler` is a throwaway arrow function the test itself defines inline; asserting
`handler.length === 0` is tautological (any zero-parameter arrow function has
`.length === 0` regardless of what `AgentServer` actually does with a registered
handler) and proves nothing about production behaviour. The second assertion
(`registerConfigRequestHandler.length === 1`) checks the *registration* function's
arity, not that the handler is later *invoked* with zero arguments at the
`config_request` branch in `agentServer.ts`. If a future edit changed
`this.configRequestHandler()` to `this.configRequestHandler(msg)`, passing the raw
inbound message through, this test would keep passing. The actual guarantee (T-08-19:
a `config_request` cannot smuggle data in) is real and is correctly pinned — but by
a *different* test in the same file (`'ignores every field riding on the inbound
config_request...'`, line 138), which drives real WebSocket traffic and asserts the
stored row is unchanged. This test is redundant with, and weaker than, that one.

**Fix:** Either delete this case (the behavioural test already covers the claim), or
rewrite it to assert the real call site's arity, e.g. by parsing
`AgentServer`'s message-handling source for the literal call
`this.configRequestHandler()` with no arguments, or — more robustly — by having
`agentServer.ts` expose the arity of the stored callback it will actually invoke and
asserting on that instead of on a local dummy.

### IN-02: `DEFAULT_AGENT_CONFIG` is mutable, unlike its `event`-table sibling `DEFAULT_EVENT_CONFIG`

**File:** `mirror-request/src/agent/agentConfigContract.ts:69-73`
**Issue:** `localStore.ts`'s `DEFAULT_EVENT_CONFIG` is `Object.freeze`d specifically
so a future accidental mutation of the shipped-default object can't corrupt every
subsequent read (`localStore.ts:31`). `DEFAULT_AGENT_CONFIG` is the direct Agent-side
analogue — the same "shipped defaults, read many times, must never be
edited-in-place" role — but is a plain object. Every current call site
(`readAgentConfigForAgent`'s `{ ...DEFAULT_AGENT_CONFIG }`,
`cmsAgentRoutes.ts`'s `pickSafeAgentConfig(... ?? DEFAULT_AGENT_CONFIG)`) is careful
to spread/copy rather than mutate, so there is no live bug — but nothing at the type
level stops a future call site from writing `DEFAULT_AGENT_CONFIG.logLevel = x`
directly and silently changing the shipped default for the life of the process.

**Fix:** `export const DEFAULT_AGENT_CONFIG = Object.freeze({ ... }) as Record<string, unknown>;` for parity with `DEFAULT_EVENT_CONFIG` and to make an accidental in-place mutation throw (strict mode) or no-op (sloppy mode) instead of silently succeeding.

---

_Reviewed: 2026-08-13T02:20:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
