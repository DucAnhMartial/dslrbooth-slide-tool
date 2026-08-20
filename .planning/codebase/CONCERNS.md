# Concerns and Technical Debt

*Mapped: 2026-08-10. These are source observations, not confirmed incidents.*

## Security and privacy

- `web-slide/server.js` enables global CORS and exposes customer/clear APIs without authentication; it also accepts 50 MB bodies. Restrict it to a trusted network or add auth before public exposure.
- `web-slide/server.js` writes every JSON webhook body to `webhook-json.log`. Payloads may contain guest contact data and photo references; disable, redact, or rotate this production debug log.
- `mirror-request/src/ingestion/mirrorReceiver.ts` relies on IP allow-listing, not signed webhooks. Ensure proxy/IP handling is intentional.
- `dslrbooth-agent/src/dslrbooth/client.ts` and `src/websocket/connection.ts` place passwords/tokens in query strings due to existing protocols. Keep traffic loopback/trusted-LAN and protect logs; evolve the protocol if possible.

## Correctness and maintenance

- `mirror-request/src/state/localStore.ts` defines `getJobRegistration` twice; the later class method overrides the earlier one at runtime. Remove the duplicate and retain one typed contract.
- `mirror-request/src/types.ts` declares `QueueJob.registration` as required although several store queries return only queue fields.
- `mirror-request/src/config.ts` defaults the DB port to 5432, while `src/ingestion/dbPoller.ts` defaults to 3306 and uses MySQL. Centralize this setting.
- PostgreSQL/email/SMS-related dependencies and config fields remain even though active code uses MySQL, SQLite and a webhook.

## Reliability and scale

- The central and agent displays refresh/broadcast every 250 ms; this is fine for a single booth but creates avoidable traffic at larger scale.
- `web-slide` keeps customer state only in memory, so it is lost on restart; uploads have no cleanup policy.
- `web-slide` and the hardware-facing agent lack automated tests; the slideshow has no explicit graceful-shutdown lifecycle.
- Source, credentials, SQLite data, logs, generated output and executable artifacts coexist in this workspace. Verify ignore and deployment rules before copying/publishing it.
