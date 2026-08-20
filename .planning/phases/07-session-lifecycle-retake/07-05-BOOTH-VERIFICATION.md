# Phase 7 — Booth Verification Script (SC-6)

> **For a person standing at the booth. You do not need to have read any plan.**
> This is the blocking gate for plan 07-05, Task 4. It cannot be satisfied by tests —
> no harness can emit a retake trigger sequence, because nobody has ever measured one.

Status: **awaiting human verification**
Code state at time of writing: 42 test files / 443 tests green, typecheck 0, build 0, tree clean.

---

## Part 0 — Two prerequisites. Skipping either produces a misleading result.

### 0a. Deploy the Agent-auth cutover — server and Agent together, both-or-neither

See `docs/OPS-RUNBOOK.md` §7. Until this is done the Agent cannot connect at all and **nothing below will happen.**

### 0b. Kill the stale test ticket BEFORE any Agent connects

Ticket `3X818VEJ` is still queued with `retries=0` and has no upstream cancellation path. **The moment an Agent connects it will be dispatched for a real photo session with nobody present.**

```bash
cd /opt/mirror_request_dslrobooth/mirror-request
cp ./data/extension-service.sqlite ./data/extension-service.sqlite.bak   # back up first
sqlite3 ./data/extension-service.sqlite \
  "UPDATE queue_job SET status='failed', stall_reason='manual_operator_stop' WHERE id='3X818VEJ';"
sqlite3 ./data/extension-service.sqlite "SELECT id,status FROM queue_job WHERE id='3X818VEJ';"
```

**Pass:** prints `3X818VEJ|failed`. **Do not continue until it does.**

---

## Part 1 — Setup

You do **not** need to change the log level. Every line below is `info`, which is the default. Raising to `debug` only adds noise.

Optional — to exercise the new SIGHUP reload, edit `LOG_LEVEL` in the deployed `.env`, then:

```bash
pm2 sendSignal SIGHUP mirror-service
```

**Pass:** `Log level reload (SIGHUP): info -> debug`
**Fail:** no such line, or `Log level reload (SIGHUP) failed: ...`

Open a live tail in a second terminal and leave it running for the whole exercise:

```bash
cd /opt/mirror_request_dslrobooth/mirror-request
tail -f logs/extension-service-$(date +%Y-%m-%d).log
```

> **Gotcha before you grep.** The log masks any run of 7+ consecutive digits, so a job id containing one appears partly as `*******`. If a grep for a job id returns nothing, that is why — grep a distinctive non-digit fragment instead, and treat the database as authoritative.

---

## Part 2 — Register TWO guests

Register guest **A** and guest **B** so B is genuinely queued behind A.

> **A queue is the entire point.** Every test through Phase 6 ran with an empty queue, and that is the only reason this class of defect went unseen for six phases. **A single-guest run proves nothing here.**

```bash
sqlite3 ./data/extension-service.sqlite \
  "SELECT id,status,retries FROM queue_job WHERE status NOT IN ('completed','failed','no_photo');"
```

**Pass:** A is `dispatched` or `in_progress`; B is `queued`.

Record `<A>` and `<B>` — the two job ids.

---

## Part 3 — Guest A takes a photo, using RETAKE at least once

Guest A starts the session, uses dslrBooth's **RETAKE** at least once, then accepts a shot and lets the session finish normally.

### Check 3.1 — the retake completes nothing and frees nothing

*While the retake is happening*, in another terminal:

```bash
sqlite3 ./data/extension-service.sqlite "SELECT id,status FROM queue_job WHERE id IN ('<A>','<B>');"
sqlite3 ./data/extension-service.sqlite "SELECT state,current_job_id FROM booth_state WHERE id=1;"
```

- **Pass:** A is `in_progress`, B still `queued`, booth `BUSY` with `current_job_id` = A.
- **Fail:** A shows `completed` before the guest accepted a shot; or the booth went `IDLE`/`ANNOUNCING`; or B moved off `queued`. **That is the retake being mistaken for the end of the session — the exact defect this phase exists to prevent. Capture the log and stop.**

### Check 3.2 — every event is visible

Expected stream shape:

```
info [queue]: Agent event capture_start booth_job=<A>
info [queue]: Agent event countdown booth_job=<A>
info [queue]: Agent event processing_start booth_job=<A> composite=C:\dslrBooth\<event>\Prints\<timestamp>.jpg
info [queue]: Agent event file_upload booth_job=<A> upload_type=print
info [queue]: Agent event session_end booth_job=<A>
```

- **Pass:** every event type the booth emits produces exactly one such line. Before this plan, seven of the ten types were silent at this level.
- **Fail:** whole event types missing, **or any line containing a `https://fotoshare.co/...` URL.**

> **A fotoshare URL at `info` level is a privacy defect, not a cosmetic one.** That URL lets anyone reading the log open the guest's photo, and logs are kept 14 days. **Report immediately if you see one.**

### Check 3.3 — completion happens once, at the composite

```bash
grep "Completed job" logs/extension-service-$(date +%Y-%m-%d).log
```

- **Pass:** exactly one `Completed job <A> via processing_start composite ...` (or `via printing`), **regardless of how many retakes happened.**
- **Fail:** two or more `Completed job` lines for `<A>`, or one naming `<B>`.

### Check 3.4 — the guest's photo still arrives

Guest A receives their photo on phone/email as usual, and it appears on the slideshow.

- **Fail:** no photo, plus `Print upload for <A> dropped: no session was awaiting a print for it`.

### Check 3.5 — guest B is announced only after A's `session_end`

`Announcing next guest for job <B>` must appear **after** `Agent event session_end booth_job=<A>`, never before.

---

## Part 4 — The duplicate `session_end` test

This is criterion 2 at the real booth.

After guest A's session has finished and guest B has been dispatched: **go to the booth, browse the photo gallery, then exit — twice.** This deliberately forces extra `session_end` events; the booth emits one on every exit from the sharing screen (measured three times in 52 seconds for one session).

```bash
sqlite3 ./data/extension-service.sqlite "SELECT id,status FROM queue_job WHERE id='<B>';"
```

- **Pass:** `<B>` is still `in_progress`. Log shows `session_end received with no job bound to the booth; ignored`, or a `session_end` that releases nothing belonging to B.
- **Fail:** `<B>` flipped to `completed` while guest B is still standing at the camera. **That is the original production defect (job `BZWCWFN6`) reappearing. Capture the log and stop.**

---

## Part 5 — The summary line

This is the whole point of the phase.

```bash
grep "SESSION_SUMMARY job=<A>" logs/extension-service-$(date +%Y-%m-%d).log
```

Expected — exactly one line:

```
info [queue]: SESSION_SUMMARY job=<A> outcome=completed captures=5 print_composite=yes duration_ms=41230
```

- **Pass:** exactly one line; `outcome=completed`; `print_composite=yes`; `duration_ms` plausible for how long the session actually took.
- **Fail:** two or more lines for the same job, or `outcome=no_photo` for a session that clearly produced a photo.

### About `captures=` — read before reporting a failure

The plan expects a number greater than 1 because of the retake. **This number has never been measured**, and it depends on something nobody has established: whether dslrBooth emits `capture_start` once per *shot* or once per *session*. The one captured log we have starts too late to tell.

| What you see | What it means |
|---|---|
| `captures=` > shots taken without retaking | Retakes are being counted. **This is the phase's goal** — the first time this project can count a retake. |
| `captures=1` despite several shots | dslrBooth emits `capture_start` once per session. **A measurement finding about the booth, not a server bug.** Report the number; do not report a failure. |
| `captures=unknown` | The service restarted mid-session. Note it and move on. |

**Please report the raw number either way, plus how many shots you took and how many retakes. That number is the measurement.**

---

## Part 6 — Optional second run: the no-photo outcome

If a second run is cheap, do one where the guest walks away without accepting a shot.

> **Set expectations first: this does NOT resolve immediately.** The job stays `in_progress` for **15 minutes** after acknowledgement before a sweep closes it. Checking after two minutes and seeing `in_progress` is **correct behaviour, not a failure.**

Wait the full 15 minutes, then:

```bash
sqlite3 ./data/extension-service.sqlite "SELECT id,status,retries,stall_reason FROM queue_job WHERE id='<C>';"
grep "SESSION_SUMMARY job=<C>" logs/extension-service-$(date +%Y-%m-%d).log
```

- **Pass:** status `no_photo`; `retries` **unchanged** (the guest was not charged and not called back); `stall_reason` **empty** (deliberate, not missing data); one summary line with `outcome=no_photo print_composite=no`.
- **Fail:** `retries` incremented, or the guest was re-announced and called back to the camera.
- **Worth reporting specially:** `outcome=no_photo` together with `captures` > 0. That means a guest *was* photographed and the session was closed as having produced nothing — a known residual window this design narrowed to 15 minutes but did not eliminate. **It has never been seen; if you see it, it is the single most valuable thing to report.**

---

## Reporting back

Reply **"approved"** with what you observed — especially:

1. The `captures=` number, plus shots taken and retakes used.
2. The retake's trigger sequence, if you can see it in the tail.
3. Anything from Parts 3.2, 4, or 6 flagged as "report immediately" / "report specially".

**If the two prerequisites in Part 0 are not yet in place, `human_needed` is a correct outcome, not a failure.**
