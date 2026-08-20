import express from 'express';
import path from 'path';
import type { EnvConfig } from './types';
import type { LocalStore } from './state/localStore';
import type { QueueService } from './queue/queueService';
import type { AgentServer } from './agent/agentServer';
import { labelLogger } from './logging/logger';
import { createMirrorReceiver } from './ingestion/mirrorReceiver';
import { jsonWithRawBody } from './ingestion/webhookAuth';
import { readAgentConfigForAgent } from './agent/agentConfigContract';
import { renderDisplayPage } from './display/displayPage';
import { renderSlidesPage } from './display/slidesPage';
import { createStatusRouter } from './status/statusRoute';
import { createHealthRouter } from './ops/healthRoute';
import { createCmsIpGate } from './cms/cmsIpGate';
import { createCmsRouter } from './cms/cmsRouter';
import { serveUploadedAsset } from './cms/uploadHandler';
import { clientIp, isWhitelisted } from './security/ipAllowlist';

const log = labelLogger('server');

export interface ServiceDeps {
  config: EnvConfig;
  store: LocalStore;
  queue: QueueService;
  agentServer: AgentServer;
}

/**
 * Every HTTP route and middleware this service serves, in the ONE order that
 * makes them correct, plus the one non-HTTP wiring step (the Agent's
 * configuration answer) that used to sit inline beside them.
 *
 * WHY THIS IS A FUNCTION AND NOT THE TOP OF `index.ts` (plan 08-06):
 * `index.ts` builds its world at module load and calls `app.listen()` there,
 * so importing it from a test starts a real listener, a real database poller
 * and a real notification sweeper, and hands back no handle to stop any of
 * them. That made the shipped wiring untestable, and "untestable" here meant
 * something specific and dangerous: every Phase 8 suite hand-assembled its own
 * express app in the same order this file uses, so a mistake made HERE — the
 * CMS IP gate mounted after the router, the scoped upload parser mounted below
 * the global one, the display route missing its allow-list — would have been
 * invisible to all 653 of them. The cutover this phase ends with (D-06) has no
 * fast rollback, so "the modules work" was not a good enough thing to know.
 *
 * The move is a pure extraction: no route changed, no order changed, and no
 * comment was rewritten. `index.ts` still calls this unconditionally and still
 * listens unconditionally, so a mistake in the split cannot present as a
 * service that silently starts and serves nothing.
 *
 * Proved by `test/phase8-cutover-readiness.test.ts`, which drives this exact
 * function rather than a copy of it.
 */
export function createApp(deps: ServiceDeps): express.Express {
  const { config, store, queue, agentServer } = deps;
  const app = express();

  // D-15/T-08-07: the asset-upload body parser, mounted BEFORE the global one
  // below and scoped to exactly one path.
  //
  // Order is the whole mechanism. `jsonWithRawBody()` carries no explicit
  // `limit`, so body-parser's 100kb default applies to every route it handles.
  // A 5MB image arrives base64-encoded inside JSON (~4/3 inflation, plus the
  // envelope), so it must meet a parser with a larger limit FIRST. body-parser
  // marks a request once it has parsed a body and every later parser skips it,
  // which is what makes this work and what leaves the global 100kb default
  // fully in force for every other route — including /on-register, where a
  // generous limit would be a denial-of-service surface rather than a feature.
  //
  // MEASURED, not assumed: test/cms-access-control.test.ts posts a ~4MB body to
  // this path and asserts the response is not a 413. If that case ever goes
  // red, this mount has moved below the global parser.
  //
  // WR-05 (Phase 8 code review): the IP check below runs BEFORE the parser,
  // not after. Mounted the other way round, a non-whitelisted peer still had
  // its body read and buffered — up to the raised ~6.7MB ceiling — before the
  // CMS IP gate at the bottom of this function ever saw the request. The
  // final answer was correctly 403 either way, so D-13's access decision was
  // never in question; what was being spent for a peer with no business here
  // was memory and CPU. This is the same "route order is load-bearing"
  // reasoning the CMS mount below states, applied to the one middleware that
  // previously sat above everything.
  //
  // It duplicates the gate rather than moving the parser below it, because
  // the parser MUST still precede `jsonWithRawBody()` — that ordering is what
  // keeps the 100kb default in force everywhere else, and it is the property
  // the comment above describes.
  app.use(
    '/cms/api/assets',
    (req, res, next) => {
      const ip = clientIp(req);
      if (!isWhitelisted(ip, config.CMS_IP_WHITELIST)) {
        log.warn(`Blocked /cms/api/assets from non-whitelisted IP: ${ip}`);
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    },
    express.json({ limit: Math.ceil(config.CMS_UPLOAD_MAX_BYTES * (4 / 3)) + 65_536 }),
  );

  // WR-03: body-parser's own refusal, converted to the shape the rest of this
  // endpoint uses.
  //
  // A body over the limit above never reaches `handleAssetUpload`. Left
  // alone, body-parser threw `PayloadTooLargeError` and Express's DEFAULT
  // handler answered it — a 413, `Content-Type: text/html`, and a full stack
  // trace with absolute filesystem paths whenever NODE_ENV is not exactly
  // 'production' (which `config.ts` never requires). That broke
  // `uploadHandler.ts`'s stated invariant — "One refusal for every way an
  // upload can fail... Distinct messages here would tell a caller which of
  // its guesses was closer" — from outside the handler that promises it, and
  // it leaked paths while doing so. Same root cause as CR-01: there is no
  // JSON-aware error handler anywhere in this app, so every parser-level
  // throw fell through to the HTML page.
  //
  // Scoped to this path and this error type. Anything else is passed on
  // untouched, so this cannot silently swallow an unrelated fault.
  app.use(
    '/cms/api/assets',
    (err: Error & { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err?.type === 'entity.too.large') {
        res.status(400).json({ error: 'Invalid upload' });
        return;
      }
      next(err);
    },
  );

  app.use(jsonWithRawBody());

  const mirror = createMirrorReceiver(store, config.PROXY_IP_WHITELIST, {
    hmacSecret: config.WEBHOOK_HMAC_SECRET,
    timestampSkewMs: config.WEBHOOK_TIMESTAMP_SKEW_MS,
    dedupWindowMs: config.REGISTRATION_DEDUP_WINDOW_MS,
  });
  app.use(mirror);

  // D-09: gated by the same allow-list machinery the WS /display upgrade
  // handler uses (src/display/displayServer.ts), so the two surfaces can
  // never diverge on what counts as an allowed peer. A blocked peer gets the
  // identical generic 403 body Phase 1's blocked-IP response already uses
  // (D-08's "one indistinguishable refusal" posture, extended to this surface).
  app.get('/display-screen', (req, res, next) => {
    const ip = clientIp(req);
    if (!isWhitelisted(ip, config.DISPLAY_IP_WHITELIST)) {
      log.warn(`Blocked /display-screen from non-whitelisted IP: ${ip}`);
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }, (req, res) => {
    // D9-01/D9-03/T-09-02: the ONLY variant selection mechanism, and it lives
    // INSIDE this second handler, below the allow-list gate above — a
    // variant mounted as its own route would be a display surface with no
    // allow-list (T-09-01). The comparison is strict equality against one
    // literal, guarded by a `typeof` check so a repeated `?view=` (which
    // Express parses as an array) cannot pass it; the value is never
    // interpolated into markup, never used as a filename, never used as a
    // lookup key. Every other value — 'queue', '', 'SLIDES', a trailing
    // space, '__proto__', a repeated param — falls to the default page.
    const view = req.query.view;
    if (typeof view === 'string' && view === 'slides') {
      res.type('html').send(renderSlidesPage());
      return;
    }
    res.type('html').send(renderDisplayPage());
  });

  // The three curated Room Screen fonts (UI-SPEC Open Question 1, human-answered):
  // self-hosted, weights 400 and 700 only, served from this host so a venue with
  // no internet — or a compromised third-party font CDN — both fail closed
  // (T-08-SC). There is no <link> to fonts.googleapis.com anywhere.
  //
  // This is the ONE place plain static-file middleware is correct, and the
  // contrast with /uploads below is the reason: these four files are immutable,
  // trusted, and committed to this repository at build time. /uploads serves
  // request-supplied bytes, which is exactly why it sniffs magic bytes against a
  // hard-coded allow-list instead of using express.static.
  //
  // Ungated deliberately: a font carries no event data and no guest data, and a
  // TV that could not fetch it would render the whole screen in a fallback face.
  app.use(
    '/assets/fonts',
    express.static(path.join(__dirname, '..', 'assets', 'fonts'), {
      // Immutable by construction — the filename changes when the font does.
      maxAge: '30d',
      // No directory listing, and no fallthrough to a directory index.
      index: false,
      redirect: false,
      dotfiles: 'deny',
    }),
  );

  // UI-02 / D-17: the Agent PULLS its configuration. This is the whole of the
  // service's side of that round trip — the Agent asks on connect (and again
  // whenever a CMS save sends it a `reload_config`), and this callback answers
  // from `agent_config`, projected onto D-16's allow-list. It takes no argument
  // because there is nothing about the request worth reading: configuration
  // travels one way.
  //
  // Not an HTTP route, and deliberately here anyway: it is wiring, it lives at
  // the same seam as the routes below, and a service whose Agent link is
  // unwired looks exactly like a healthy one until a booth asks for its
  // configuration mid-event.
  agentServer.registerConfigRequestHandler(() => readAgentConfigForAgent(store));

  app.use(createStatusRouter(store, queue, agentServer, config));

  // GET /health — the service-level operational report. Distinct from
  // createStatusRouter above, which serves GET /status/:jobId, a per-guest
  // lookup: one answers "where is my photo", the other "is anything quietly
  // broken". They share no data and no audience, so they are not merged.
  //
  // Mounted here, above the CMS gate, because it carries its own gate (loopback
  // ∪ CMS list) — see src/ops/healthRoute.ts for why that union and not either
  // list alone. Mounting it under '/cms' instead would have inherited the
  // session requirement and made the loopback case unusable.
  app.use(createHealthRouter({ store, agent: agentServer, config }));

  // D-13's two layers, in the ONE order that makes them two layers: the IP
  // allow-list gate is mounted BEFORE the router, so a non-whitelisted peer is
  // refused without any session logic running at all. Swapping these two
  // arguments leaves a CMS that still demands a password and still passes every
  // happy-path test, while having silently deleted the network control — see
  // src/cms/cmsIpGate.ts, and test/cms-access-control.test.ts for the case that
  // proves the layers refuse independently.
  //
  // config.CMS_IP_WHITELIST, never config.DISPLAY_IP_WHITELIST: the operator's
  // laptop and the room's TVs are different audiences on different network
  // paths (RESEARCH Pitfall 2).
  app.use('/cms', createCmsIpGate(config.CMS_IP_WHITELIST), createCmsRouter(store, config, agentServer, queue));

  // D-15: uploaded branding assets. Gated by the UNION of the two allow-lists,
  // not by either alone — the room's TV has to fetch the event's logo and
  // background to render at all, and the operator has to preview what they just
  // uploaded. Both address sets are already trusted for their own surfaces, and
  // neither is a superset of the other.
  //
  // No session check here, deliberately: a TV has no session and cannot get
  // one (D-12 gives screens no identity). The network layer is the whole
  // control on this route, which is why the route can only ever emit one of
  // four image types from one directory — see src/cms/uploadHandler.ts.
  app.get(
    '/uploads/:filename',
    (req, res, next) => {
      const ip = clientIp(req);
      if (!isWhitelisted(ip, [...config.DISPLAY_IP_WHITELIST, ...config.CMS_IP_WHITELIST])) {
        log.warn(`Blocked /uploads from non-whitelisted IP: ${ip}`);
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    },
    serveUploadedAsset(config.CMS_UPLOAD_DIR),
  );

  return app;
}
