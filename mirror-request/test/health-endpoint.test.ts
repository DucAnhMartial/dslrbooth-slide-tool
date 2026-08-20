import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildHealthReport, createHealthRouter, type HealthDeps } from '../src/ops/healthRoute';

// ---------------------------------------------------------------------------
// GET /health.
//
// The endpoint exists because of a specific failure mode, and that failure
// mode — not uptime — is what these cases pin. Three real defects were live on
// the production host simultaneously and NONE of them was visible anywhere
// except a rotating log file: the process running outside production mode with
// its own fail-fast therefore inert, six notifications dead after exhausting
// retries, and webhook signature verification silently off. The room screen
// looked perfect the whole time.
//
// So the assertions below are mostly about `warnings`: each condition that was
// silent must now produce a line an operator can read. A test that only
// checked `status === 'ok'` on a healthy service would have passed against the
// broken host too.
// ---------------------------------------------------------------------------

const CMS_IP = '192.168.12.40';
const OUTSIDE_IP = '119.17.222.65';

function makeDeps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    store: {
      getBoothState: () => 'IDLE',
      countQueueJobsByStatus: () => ({ completed: 11 }),
      countNotificationsByStatus: () => ({ delivered: 5 }),
      getOldestInFlightJob: () => undefined,
    },
    agent: { isAgentOnline: () => true },
    config: {
      CMS_IP_WHITELIST: [CMS_IP],
      WEBHOOK_HMAC_SECRET: 'a'.repeat(64),
      NOTIFY_WEBHOOK_URL: '',
    },
    nodeEnv: 'production',
    uptimeSeconds: () => 1234.9,
    ...over,
  };
}

function withFakeIp(app: express.Express, ip: string): express.Express {
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    next();
  });
  return app;
}

function appFor(deps: HealthDeps, ip: string): express.Express {
  const app = withFakeIp(express(), ip);
  app.use(createHealthRouter(deps));
  return app;
}

describe('the health report', () => {
  it('is quiet when nothing is wrong', () => {
    const report = buildHealthReport(makeDeps());
    expect(report.status).toBe('ok');
    expect(report.warnings).toEqual([]);
    expect(report.mode).toBe('production');
    expect(report.webhookAuth).toBe('enforced');
    expect(report.uptimeSeconds).toBe(1234);
  });

  it('names the consequence when the service is not in production mode', () => {
    // The exact condition found live: NODE_ENV=staging on the production host.
    const report = buildHealthReport(makeDeps({ nodeEnv: 'staging' }));
    expect(report.status).toBe('degraded');
    expect(report.warnings.join(' ')).toContain('staging');
    expect(report.warnings.join(' ')).toMatch(/signature verification/i);
  });

  it('reports permanently failed notifications at any count above zero', () => {
    const report = buildHealthReport(
      makeDeps({
        store: {
          getBoothState: () => 'IDLE',
          countQueueJobsByStatus: () => ({}),
          countNotificationsByStatus: () => ({ delivered: 5, failed: 6 }),
          getOldestInFlightJob: () => undefined,
        },
      }),
    );
    expect(report.status).toBe('degraded');
    expect(report.warnings.join(' ')).toContain('6 photo notification(s)');
    // No threshold: one is reported exactly as six is.
    const one = buildHealthReport(
      makeDeps({
        store: {
          getBoothState: () => 'IDLE',
          countQueueJobsByStatus: () => ({}),
          countNotificationsByStatus: () => ({ failed: 1 }),
          getOldestInFlightJob: () => undefined,
        },
      }),
    );
    expect(one.warnings.join(' ')).toContain('1 photo notification(s)');
  });

  it('reports a missing HMAC secret separately from the mode', () => {
    // Two independent conditions: production mode makes the secret mandatory
    // at startup, but a service can be in any mode with or without one, and
    // an operator reading this needs to know which is true.
    const report = buildHealthReport(
      makeDeps({ nodeEnv: 'production', config: { CMS_IP_WHITELIST: [], WEBHOOK_HMAC_SECRET: '', NOTIFY_WEBHOOK_URL: '' } }),
    );
    expect(report.webhookAuth).toBe('disabled');
    expect(report.warnings.join(' ')).toContain('WEBHOOK_HMAC_SECRET');
  });

  it('does not treat a deliberately disabled photo delivery as a fault', () => {
    // NOTIFY_WEBHOOK_URL is empty by decision after web-slide's retirement.
    // Reporting a choice as a fault is how a health page trains people to
    // ignore it, so this shows up as state and never as a warning.
    const report = buildHealthReport(makeDeps({ config: { CMS_IP_WHITELIST: [], WEBHOOK_HMAC_SECRET: 'x', NOTIFY_WEBHOOK_URL: '' } }));
    expect(report.photoDelivery).toBe('disabled');
    expect(report.warnings).toEqual([]);
    expect(report.status).toBe('ok');
  });

  it('carries no guest-identifying field of any kind', () => {
    // The whole reason the route can be widened to loopback without a session
    // check. Counts and enums only — assert on the serialised body, so a
    // nested field cannot slip past a key-by-key check.
    const body = JSON.stringify(
      buildHealthReport(
        makeDeps({
          store: {
            getBoothState: () => 'BUSY',
            countQueueJobsByStatus: () => ({ queued: 2, completed: 11 }),
            countNotificationsByStatus: () => ({ delivered: 5, failed: 6 }),
            getOldestInFlightJob: () => undefined,
          },
        }),
      ),
    );
    for (const forbidden of ['name', 'email', 'phone', 'jobId', 'photoUrl', 'guest']) {
      expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('a booth that is holding a job too long', () => {
  // The failure mode this exists for, found by a full-journey load test on
  // 2026-08-16: an Agent that connected, authenticated and answered every
  // heartbeat, but silently ignored a command action it did not recognise. The
  // job sat in 'dispatched' with the whole queue stopped behind it, while
  // isAgentOnline() reported true and nothing was logged for five minutes.
  //
  // These cases replace a `queue.stalled` check that could never fire — no
  // 'stalled' job status exists in this codebase, so the old branch was dead
  // code sitting exactly where the real check belonged.
  const NOW = 1_786_000_000_000;

  function withInFlight(ageMs: number, status = 'dispatched') {
    return makeDeps({
      now: () => NOW,
      store: {
        getBoothState: () => 'BUSY',
        countQueueJobsByStatus: () => ({ dispatched: 1, queued: 12 }),
        countNotificationsByStatus: () => ({ delivered: 4 }),
        getOldestInFlightJob: () => ({ id: 'ABC123', status, dispatchedAt: NOW - ageMs }),
      },
    });
  }

  it('says nothing while a session is merely running', () => {
    // A real session is 30-60 seconds. Ninety must not warn, or the warning
    // fires on ordinary guests and stops meaning anything.
    const report = buildHealthReport(withInFlight(90_000));
    expect(report.warnings).toEqual([]);
    expect(report.status).toBe('ok');
  });

  it('warns once the hold outlasts any real session', () => {
    const report = buildHealthReport(withInFlight(200_000));
    expect(report.status).toBe('degraded');
    const text = report.warnings.join(' ');
    expect(text).toContain('ABC123');
    expect(text).toContain('200s');
    expect(text).toMatch(/queue is not advancing/i);
  });

  it('warns before the service itself gives up, not at the same moment', () => {
    // SESSION_TIMEOUT_MS is 300_000 — when startBusyTimer() stalls the job. A
    // warning that arrived then would tell an operator something they were
    // about to be told anyway. The default threshold is half that, so there is
    // real time to act.
    const report = buildHealthReport(withInFlight(160_000));
    expect(report.warnings.length).toBe(1);
    expect(buildHealthReport(withInFlight(140_000)).warnings).toEqual([]);
  });

  it('covers in_progress as well as dispatched', () => {
    // Both statuses mean "the booth owns this job". A guard that watched only
    // one would miss an Agent that acknowledged the command and then died.
    expect(buildHealthReport(withInFlight(200_000, 'in_progress')).warnings.length).toBe(1);
  });

  it('says nothing at all when the booth holds no job', () => {
    expect(buildHealthReport(makeDeps()).warnings).toEqual([]);
  });
});

describe('who may read /health', () => {
  it('serves an address on the CMS allow-list', async () => {
    const res = await request(appFor(makeDeps(), CMS_IP)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('serves loopback even though loopback is not on the CMS list', async () => {
    // Deliberate: a monitoring check that must first be allow-listed from
    // off-box is a check nobody sets up. This is also the surface the same
    // audit found broken for /display-screen.
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const res = await request(appFor(makeDeps(), ip)).get('/health');
      expect(res.status).toBe(200);
    }
  });

  it('refuses an address on neither list', async () => {
    // The address that actually probed this host on 2026-08-14.
    const res = await request(appFor(makeDeps(), OUTSIDE_IP)).get('/health');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(JSON.stringify(res.body)).not.toContain('warnings');
  });

  it('an unset CMS allow-list narrows access to loopback rather than opening it', async () => {
    // isWhitelisted() treats an empty list as allow-everything — its
    // development escape hatch. Because this route unions the config list with
    // a non-empty loopback literal, the list it checks is never empty, so an
    // unset CMS_IP_WHITELIST cannot open this endpoint to the world.
    const deps = makeDeps({ config: { CMS_IP_WHITELIST: [], WEBHOOK_HMAC_SECRET: 'x', NOTIFY_WEBHOOK_URL: '' } });
    expect((await request(appFor(deps, OUTSIDE_IP)).get('/health')).status).toBe(403);
    expect((await request(appFor(deps, '127.0.0.1')).get('/health')).status).toBe(200);
  });

  it('answers 200 while degraded, so a naive uptime check does not read it as an outage', async () => {
    const deps = makeDeps({ nodeEnv: 'staging' });
    const res = await request(appFor(deps, CMS_IP)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.warnings.length).toBeGreaterThan(0);
  });
});
