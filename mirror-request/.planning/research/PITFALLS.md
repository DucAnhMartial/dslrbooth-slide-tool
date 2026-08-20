What goes wrong: The /on-register endpoint or WebSocket connection is made from an extension context. CORS preflight fails, but the failure is opaque — the browser produces only a TypeError with no actionable specifics in JavaScript. The endpoint silently never receives the actual request.

Why it happens: The most common cause is returning Access-Control-Allow-Origin: * while also returning Access-Control-Allow-Credentials: true — browsers block this combination contractually. Another is omitting Vary: Origin on dynamically-computed origins; downstream CDNs or proxy caches then serve a response with the wrong origin to a different requester. A third common cause is the reverse proxy returning a redirect on OPTIONS preflight requests — browsers are inconsistent about following cross-origin redirects after preflight (the spec was updated, but not all browsers implemented the update). A reverse proxy that strips or adds an Origin header during proxying breaks CORS entirely, since Origin is auto-injected by the browser and must not be tampered with. The /on-register endpoint secured by IP allowlisting is not a substitute for CORS origin validation — both must be configured independently.

Consequences: /on-register appears functional but receives nothing from extension callers. The system is broken for its primary ingestion path with no actionable error message. Because CORS failures are opaque in JavaScript (the browser deliberately hides specifics as a security feature), debugging requires checking browser DevTools Network tab or using curl with an explicit Origin header.

Prevention: When credentials are used, explicitly enumerate allowed origins (never *). Include Vary: Origin in every dynamically-originated CORS response. Test CORS preflight separately using curl -X OPTIONS -H "Origin: <origin>" -H "Access-Control-Request-Method: POST" http://host/on-register — a correct response has status 204 or 200 with the appropriate Access-Control-Allow-* headers and no redirect. Ensure the reverse proxy does not redirect OPTIONS requests on preflight paths.

Detection: - Server logs show OPTIONS arriving with no corresponding response (proxy handled it silently) - curl preflight test returns 302/301 (redirect) instead of 204 - JavaScript fetch() .catch receives a TypeError with unreadable body (opaque) - Extension background logs show network-active but /on-register never arrives at the service

---
### Pitfall 6: Idempotency Key Not Checked Before Queue Insert [SERVICE LOGIC / Phase 2]

What goes wrong: The same registration (same record ID from the database) arrives twice via /on-register — either because the mirror retried after a timeout, or because a previous ingest was replayed during a crash recovery. The duplicate is inserted into the queue and processed as a separate job.

Why it happens: The idempotency check (REQUIREMENTS ING-02, QUE-02) is implemented as a database UNIQUE constraint on record ID in the processed_ids table. But if the same request arrives twice in rapid succession before the first transaction commits, the uniqueness check sees no duplicate. Alternatively, if the processed_ids write is in a separate transaction from the queue insert, it is possible for the queue insert to succeed and the processed_ids insert to fail (or for the rollback to leave a queue entry without a corresponding processed_ids row). Under PM2 cluster mode with multiple processes, a race window opens between "check processed_ids" and "insert into queue" that is invisible to the application code.

Consequences: Duplicate jobs in the queue. Two guests with the same registration appear in the active queue. Booth serves one guest twice before the second is dequeued. Email/SMS goes to the same guest twice for two separate jobs they did not request.

Prevention: Use a single atomic transaction that checks processed_ids and inserts into queue in one db.transaction() call. better-sqlite3's synchronous API makes this straightforward. Define processed_ids.record_id as UNIQUE and rely on the constraint as the final arbiter; catch the constraint violation exception and return 200 (idempotent success) rather than 409. Log the duplicate attempt for observability.

Detection: - Queue contains two entries with the same source record_id - Two emails sent to the same guest for two distinct jobs on the same day - Duplicate registrations in Agent logs with different jobIds but same source data

---
### Pitfall 7: DB Polling Cursor Not Persisted — Double-Ingest After Restart [SQLITE / Phase 1]

What goes wrong: The service restarts (crash, deploy, PM2 restart). The in-memory polling cursor resets to the saved SQLite value. But any registrations that arrived between the last saved cursor and the crash — that were already processed by the in-flight queue — will be re-ingested. The DB polling interval replays registrations that /on-register already processed.

Why it happens: The DB polling cursor is correct, but there is a window between "registration arrives via /on-register" and "cursor advances past that registration" where the service can crash. After restart, the cursor has not yet advanced past that registration, so polling picks it up again. The processed_ids UNIQUE constraint will catch the duplicate, but only if the processed_ids write committed before the crash. If the crash happened during the transaction, the processed_ids entry may be absent — the UNIQUE check passes and the duplicate enters the queue.

Consequences: Double-ingest of registrations that straddled the crash window. Under heavy registration volume (e.g., a busy event day), the window is large enough that multiple registrations are replayed. Each replay attempt either hits the UNIQUE constraint (logged as duplicate, safe) or silently enters the queue (unsafe).

Prevention: Advance the cursor only after the processed_ids write succeeds within the same transaction. On service startup, log the cursor position and the most recent processed_ids entry so operators can quickly verify no registrations are missing. Consider adding a startup reconciliation scan: check for registrations between the saved cursor and the most recent DB record that are not in processed_ids, and ingest them explicitly.

Detection: - Logs on startup show cursor N but processed_ids contains entries beyond N - Duplicate idempotency violations logged immediately after every restart under load - Queue length spikes after PM2 restart during active registration periods

---
### Pitfall 8: Service Worker Has No DOM Access — State Display Logic Fails Unexpectedly [WEBSOCKET / Phase 3]

What goes wrong: State display logic (e.g., formatting the booth status feed for the display screen) is implemented in the WebSocket server or a state-updating callback that assumes DOM access. The service worker or Node.js backend has no DOM — code crashes silently or produces no output.

Why it happens: Chrome Extensions Manifest V3 service workers run in a WorkerGlobalScope, not a Window. They have no document, no fetch polyfills for complex DOM operations, and cannot access chrome.tabs DOM APIs. Code that was written assuming a browser-like global environment — such as template rendering, HTML generation for the display feed, or DOM-based state serialization — fails in the worker context without an obvious error boundary.

Consequences: The display feed (REQUIREMENTS API-02) returns malformed JSON, HTML fragments, or nothing at all. The booth display screen goes blank or shows stale state. The failure is silent — the WebSocket connection is open and the service believes it is sending valid data.

Prevention: Keep all formatting and serialization logic in the Node.js backend (this service) where DOM is irrelevant and JSON serialization is explicit. The display screen is a separate web page served by the frontend and rendered by a different application; this service provides only the raw state feed via SSE or WS. Audit any code that touches template literals or HTML for unintended DOM assumptions.

Detection: - Display screen shows translatable/interpolated raw JSON fields instead of formatted values - JSON.parse of the feed response throws a SyntaxError on the client - Server-side logs show ReferenceError: document is not defined

---
## Moderate Pitfalls

### Pitfall 9: Email/SMS Retry Without Backoff Creates Thundering Herd [NOTIFICATIONS / Phase 4]

What goes wrong: A batch of registrations all fail email/SMS delivery simultaneously (e.g., SMTP server temporarily unreachable). The retry logic fires all retries at a fixed interval. When SMTP recovers, all retries fire at once, overwhelming the delivery provider and triggering rate-limit responses.

Why it happens: Retry logic implemented with setInterval or a fixed retry count without exponential backoff and jitter. All failed notifications in the retry queue share the same retry timestamp. Under burst conditions (an event with 50+ simultaneous registrations), a single SMTP outage causes a synchronized retry blast.

Consequences: Delivery provider rate-limits or suspends the sending account. Guests never receive their photos. Manual intervention required to clear the backlog.

Prevention: Implement exponential backoff with jitter on retry. better-sqlite3 with a dedicated retry_queue table indexed by next_attempt_at allows the service to only attempt overdue retries each poll cycle naturally. Log every delivery attempt and outcome for observability.

Detection: - winston logs show burst of delivery attempts at the same timestamp after SMTP recovery - Delivery provider dashboard shows rate-limit spikes aligned with service restart or failure recovery - Guests report receipt delay of hours when registrations were processed within minutes

---
### Pitfall 10: Express Error Handler Swallows WS Errors Silently [WEBSOCKET / Phase 3]