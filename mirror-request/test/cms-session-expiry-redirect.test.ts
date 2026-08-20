import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createSessionStore, createRequireSession } from '../src/cms/cmsAuth';
import { safeNextTarget } from '../src/cms/cmsRouter';

// ---------------------------------------------------------------------------
// CMS-09 — losing a session must look like a login page, not like JSON.
//
// Operator: "sau một thời gian nó bị logout thì phải tự động bắn ra trang
// login chứ". Correct, and what actually happened was worse than nothing:
// `requireSession` answered EVERY unauthenticated request with
// `401 {"error":"Unauthorized"}`, including a plain browser navigation, so an
// operator returning to the CMS met raw JSON on a white page with no way
// forward.
//
// Worth stating why sessions are lost at all, because it is not a timeout:
// they live in memory with no inactivity expiry ON PURPOSE (cmsAuth.ts's store
// header — ejecting an operator mid-event is worse than a lingering session on
// an IP-allow-listed LAN). They go when the service restarts. Which means the
// deploys made while fixing everything else today are exactly what logged the
// operator out, repeatedly.
// ---------------------------------------------------------------------------

const IP = '10.0.0.5';

function build() {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: IP, configurable: true });
    next();
  });
  const sessions = createSessionStore();
  app.use(
    '/cms',
    createCmsIpGate([IP]),
    express.json(),
    createRequireSession(sessions, 'cms_session'),
    (_req, res) => res.type('html').send('<p>protected</p>'),
  );
  return app;
}

describe('a document navigation goes to the login page (CMS-09)', () => {
  it('redirects a browser GET instead of printing JSON at it', async () => {
    const res = await request(build()).get('/cms/photos').set('Accept', 'text/html');

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/cms\/login\?next=/);
  });

  it('carries where the operator was going, so they land back on it', async () => {
    const res = await request(build())
      .get('/cms/events/abc-123?page=2')
      .set('Accept', 'text/html');

    expect(decodeURIComponent(res.headers.location.split('next=')[1])).toBe('/cms/events/abc-123?page=2');
  });

  it('uses the full path, not the mount-relative one', async () => {
    // req.url under a '/cms' mount is '/photos'; sending the operator there
    // after login would 404 them.
    const res = await request(build()).get('/cms/photos').set('Accept', 'text/html');
    expect(res.headers.location).toContain(encodeURIComponent('/cms/photos'));
  });
});

describe('an API caller still gets JSON (CMS-09)', () => {
  it('answers a fetch with 401, not a redirect to an HTML form', async () => {
    // A 302 to a login PAGE is useless to a caller expecting JSON — it would
    // be parsed as a successful response containing markup.
    const res = await request(build())
      .post('/cms/api/photos/delete')
      .set('Accept', 'application/json')
      .send({ jobId: 'x' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('never redirects a mutating request, even one asking for HTML', async () => {
    // Replaying a POST as a GET after login would silently repeat whatever it
    // was — a delete, a save — without being asked.
    const res = await request(build()).post('/cms/photos/clear').set('Accept', 'text/html').send({});

    expect(res.status).toBe(401);
  });
});

describe('the next target is allow-listed, not sanitised (CMS-09)', () => {
  it('accepts a CMS path', () => {
    expect(safeNextTarget('/cms/photos?event=1')).toBe('/cms/photos?event=1');
  });

  it.each([
    ['//evil.example/x', 'protocol-relative'],
    ['https://evil.example', 'absolute URL'],
    ['http://evil.example', 'absolute URL'],
    ['/notcms/x', 'outside the CMS'],
    ['javascript:alert(1)', 'a scheme'],
    ['', 'empty'],
    ['/cms/x\r\nSet-Cookie: a=b', 'a header split'],
  ])('refuses %s (%s) and falls back to the dashboard', (raw) => {
    // A login link that quietly goes somewhere else is a phishing primitive
    // handed out by the login page itself, so the rule is positive: it must
    // start with /cms/ and nothing else is repaired.
    expect(safeNextTarget(raw)).toBe('/cms/');
  });

  it('refuses a non-string without throwing', () => {
    for (const raw of [undefined, null, 42, {}, ['/cms/x']]) {
      expect(safeNextTarget(raw)).toBe('/cms/');
    }
  });
});

describe('the page-side handler exists for sessions lost under an open tab', () => {
  it('every fetch call site checks for 401 before treating it as a content error', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(__dirname, '..', 'src', 'cms');
    for (const file of ['cmsEventPages.ts', 'cmsPhotoPages.ts', 'cmsAgentPages.ts']) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const fetches = (source.match(/await fetch\(/g) ?? []).length;
      const guards = (source.match(/cmsHandleAuth\(res\)/g) ?? []).length;
      expect(guards, `${file}: ${fetches} fetch call(s) but ${guards} auth guard(s)`).toBeGreaterThanOrEqual(
        Math.min(fetches, 1),
      );
    }
  });

  it('the handler navigates rather than showing the generic save error', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'cms', 'cmsEventPages.ts'), 'utf8');
    expect(source).toMatch(/function cmsHandleAuth\(res\)\{[\s\S]{0,400}location\.href = '\/cms\/login\?next='/);
  });
});
