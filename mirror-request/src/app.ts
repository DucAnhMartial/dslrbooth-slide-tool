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
import { createStatusRouter } from './status/statusRoute';
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
  app.use(
    '/cms/api/assets',
    express.json({ limit: Math.ceil(config.CMS_UPLOAD_MAX_BYTES * (4 / 3)) + 65_536 }),
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
  }, (_req, res) => res.type('html').send(renderDisplayPage()));

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
  app.use('/cms', createCmsIpGate(config.CMS_IP_WHITELIST), createCmsRouter(store, config, agentServer));

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
