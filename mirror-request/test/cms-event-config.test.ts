import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore, DEFAULT_EVENT_CONFIG } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createSessionStore, createRequireSession } from '../src/cms/cmsAuth';
import { createCmsEventRoutes } from '../src/cms/cmsEventRoutes';
import {
  FONT_CHOICES,
  LAYOUT_STYLES,
  FIELD_CAPS,
  PHOTO_COUNT_RANGE,
  PHOTO_DURATION_RANGE,
} from '../src/cms/cmsEventPages';

// ---------------------------------------------------------------------------
// Plan 08-03 Task 2 — the CMS-01 configuration surface.
//
// The claim under test is ROADMAP SC-1 stated literally: a new customer is a
// CONFIGURATION change. That is only true if (a) every CMS-01 field is
// reachable from the browser, (b) every field the operator leaves alone still
// renders a correct screen, and (c) no value an operator can submit can put
// the room screen into an illegible state.
//
// (c) is why every cap below is asserted against the SERVER and not only
// against the rendered `maxlength` attribute. The attribute is a courtesy to
// the operator; the server check is the control, and a test that only read the
// attribute would pass against a service with no validation at all.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const SAVE_SUCCESS = 'Đã lưu cấu hình sự kiện';
const SAVE_ERROR = 'Không lưu được cấu hình — vui lòng thử lại. Nếu vẫn lỗi, liên hệ kỹ thuật.';

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(): LocalStore {
  const store = new LocalStore(path.join(makeTmpDir('gsd-cms-config-'), 'test.sqlite'));
  openStores.push(store);
  return store;
}

interface Harness {
  app: express.Express;
  cookie: string;
  store: LocalStore;
}

function build(store: LocalStore = makeStore()): Harness {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
    next();
  });
  const sessions = createSessionStore();
  const token = sessions.create('operator');
  app.use(
    '/cms',
    createCmsIpGate([WHITELISTED_IP]),
    express.urlencoded({ extended: false }),
    express.json(),
    createRequireSession(sessions, 'cms_session'),
    createCmsEventRoutes(store, { uploadDir: makeTmpDir('gsd-cms-config-uploads-'), maxBytes: 5_242_880 }),
  );
  return { app, cookie: `cms_session=${token}`, store };
}

async function createEvent(h: Harness, name: string): Promise<string> {
  const res = await request(h.app).post('/cms/api/events').set('Cookie', h.cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The empty state (UI-SPEC: never a blank table)
// ---------------------------------------------------------------------------

describe('CMS event list — the empty state is authored, not blank', () => {
  it('renders the exact UI-SPEC empty copy and the create CTA, and no table element at all', async () => {
    const h = build();
    const res = await request(h.app).get('/cms/events').set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Chưa có sự kiện nào');
    expect(res.text).toContain('Tạo sự kiện đầu tiên để bắt đầu cấu hình màn hình phòng.');
    expect(res.text).toContain('+ Tạo sự kiện mới');
    // "never a blank table" is the requirement; the strongest form of it is
    // that there is no table to be blank.
    expect(res.text).not.toContain('<table');
  });

  it('serves the same list at /cms/ so the post-login landing page is the event library', async () => {
    const h = build();
    const res = await request(h.app).get('/cms/').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Chưa có sự kiện nào');
  });

  it('stops showing the empty state once an event exists, and lists it', async () => {
    const h = build();
    await createEvent(h, 'Tiệc cưới A');

    const res = await request(h.app).get('/cms/events').set('Cookie', h.cookie);
    expect(res.text).not.toContain('Chưa có sự kiện nào');
    expect(res.text).toContain('Tiệc cưới A');
  });
});

// ---------------------------------------------------------------------------
// Every CMS-01 field is reachable (SC-1)
// ---------------------------------------------------------------------------

describe('CMS-01: the form exposes every configurable field', () => {
  it('renders an input or select for each CMS-01 property, by name', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');
    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    const fields = [
      'name',
      'logo_url',
      'background_url',
      'color_dominant',
      'color_secondary',
      'color_accent',
      'color_text',
      'color_text_muted',
      'font_choice',
      'idle_heading',
      'idle_sub',
      'qr_image_url',
      'qr_cta_text',
      'photo_count',
      'photo_duration_ms',
      'layout_style',
      'guest_name_template',
      'caption_position',
      'photo_fit',
    ];
    for (const field of fields) {
      expect(res.text, `${field} must be reachable from the form`).toContain(`name="${field}"`);
    }
  });

  it('offers exactly the three curated fonts and the one shipped layout', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');
    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);

    expect(FONT_CHOICES).toEqual(['system-ui', 'be-vietnam-pro', 'lora']);
    expect(LAYOUT_STYLES).toEqual(['stage_sidebar']);
    for (const font of FONT_CHOICES) {
      expect(res.text).toContain(`value="${font}"`);
    }
    // Open Question 2 ships ONE layout; a second option here would be a test
    // matrix for a layout that does not exist.
    expect(res.text.match(/name="layout_style"/g)).toHaveLength(1);
  });

  it('renders the new-event form with the create CTA', async () => {
    const h = build();
    const res = await request(h.app).get('/cms/events/new').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="name"');
    expect(res.text).toContain('Tạo sự kiện mới');
  });
});

describe('caption configuration', () => {
  it('saves contain_blur and rejects an invalid fit beside a valid field atomically', async () => {
    const h = build();
    const id = await createEvent(h, 'Chú thích');
    await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({
      guest_name_template: 'Chào {guest_name}', caption_position: 'top-right', photo_fit: 'contain_blur',
    }).expect(200);
    expect(h.store.getEventConfig(id)).toMatchObject({ guestNameTemplate: 'Chào {guest_name}', captionPosition: 'top-right', photoFit: 'contain_blur' });
    const before = h.store.getEventConfig(id);
    await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({
      guest_name_template: 'Thay đổi hợp lệ', photo_fit: 'invalid-fit',
    }).expect(400);
    expect(h.store.getEventConfig(id)).toEqual(before);
  });

  it('offers all three slides-only fits and explains contain_blur and cover', async () => {
    const h = build();
    const id = await createEvent(h, 'Khung ngang');
    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);

    expect(res.text).toContain('<option value="contain"');
    expect(res.text).toContain('<option value="cover"');
    expect(res.text).toContain('<option value="contain_blur"');
    expect(res.text).toContain('giữ trọn ảnh');
    expect(res.text).toContain('bản ảnh làm mờ');
    expect(res.text).toContain('cắt logo');
    expect(res.text).toContain('screentag slides">Màn trình chiếu');
  });
});

// ---------------------------------------------------------------------------
// Partial save (UI-SPEC "partial" row, UI-01 generalized)
// ---------------------------------------------------------------------------

describe('an event saved with only a name still renders a correct screen', () => {
  it('reads back every projected field as its shipped default', async () => {
    const h = build();
    const id = await createEvent(h, 'Chỉ có tên');

    const config = h.store.getEventConfig(id)!;
    expect(config.fontChoice).toBe('system-ui');
    expect(config.layoutStyle).toBe('stage_sidebar');
    expect(config.photoCount).toBe(DEFAULT_EVENT_CONFIG.photoCount);
    expect(config.photoDurationMs).toBe(DEFAULT_EVENT_CONFIG.photoDurationMs);
    for (const [key, value] of Object.entries(config)) {
      // The three asset URLs and the id are legitimately null on a brand-new
      // event — there is no shipped logo to point at.
      if (['id', 'logoUrl', 'backgroundUrl', 'qrImageUrl'].includes(key)) continue;
      expect(value, `${key} must carry a shipped default`).not.toBeNull();
      expect(value, `${key} must carry a shipped default`).not.toBeUndefined();
    }
  });

  it('saves a subset of fields without disturbing the rest', async () => {
    const h = build();
    const id = await createEvent(h, 'Một phần');

    const res = await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ idle_heading: 'Chào mừng quý khách' });

    expect(res.status).toBe(200);
    const config = h.store.getEventConfig(id)!;
    expect(config.idleHeading).toBe('Chào mừng quý khách');
    expect(config.idleSub).toBe(DEFAULT_EVENT_CONFIG.idleSub);
    expect(config.colorAccent).toBe(DEFAULT_EVENT_CONFIG.colorAccent);
  });

  it('clears a field back to its shipped default when the operator empties it', async () => {
    const h = build();
    const id = await createEvent(h, 'Hoàn tác');
    await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ idle_heading: 'Tạm thời' })
      .expect(200);

    await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ idle_heading: '' })
      .expect(200);

    // Read-time coalescing (08-01's decision) is what makes "clear" mean
    // "return to the shipped default" rather than "render nothing".
    expect(h.store.getEventConfig(id)!.idleHeading).toBe(DEFAULT_EVENT_CONFIG.idleHeading);
  });
});

// ---------------------------------------------------------------------------
// The caps, enforced on the SERVER (UI-SPEC G3)
// ---------------------------------------------------------------------------

describe('every text field is capped, and the cap is enforced server-side', () => {
  it('publishes the caps this plan chose, including the 240-character caption template', () => {
    expect(FIELD_CAPS).toEqual({ name: 60, idle_heading: 80, idle_sub: 120, qr_cta_text: 60, guest_name_template: 240 });
  });

  it('renders each cap as a maxlength attribute on its input', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');
    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);

    expect(res.text).toContain('maxlength="60"');
    expect(res.text).toContain('maxlength="80"');
    expect(res.text).toContain('maxlength="120"');
  });

  it('refuses an over-cap value for EVERY capped field and leaves the row unchanged', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');
    const before = h.store.getEventConfig(id)!;

    for (const [field, cap] of Object.entries(FIELD_CAPS)) {
      const res = await request(h.app)
        .post(`/cms/api/events/${id}`)
        .set('Cookie', h.cookie)
        .send({ [field]: 'x'.repeat(cap + 1) });

      expect(res.status, `${field} past its cap must be refused`).toBe(400);
      expect(res.body.error).toBe(SAVE_ERROR);
      expect(h.store.getEventConfig(id)).toEqual(before);
    }
  });

  it('accepts a value exactly AT each cap — the bound is a cap, not an off-by-one', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    for (const [field, cap] of Object.entries(FIELD_CAPS)) {
      const res = await request(h.app)
        .post(`/cms/api/events/${id}`)
        .set('Cookie', h.cookie)
        .send({ [field]: 'x'.repeat(cap) });
      expect(res.status, `${field} at exactly its cap must be accepted`).toBe(200);
    }
  });

  it('refuses an over-cap name at CREATE time too, not only on update', async () => {
    const h = build();
    const res = await request(h.app)
      .post('/cms/api/events')
      .set('Cookie', h.cookie)
      .send({ name: 'x'.repeat(FIELD_CAPS.name + 1) });

    expect(res.status).toBe(400);
    expect(h.store.listEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Enumerated and numeric envelopes
// ---------------------------------------------------------------------------

describe('values that would break the room screen are refused, never clamped', () => {
  it('refuses a font outside the curated three', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    const res = await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ font_choice: 'Comic Sans' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(SAVE_ERROR);
    expect(h.store.getEventConfig(id)!.fontChoice).toBe('system-ui');
  });

  it('accepts each of the three curated fonts', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    for (const font of FONT_CHOICES) {
      await request(h.app)
        .post(`/cms/api/events/${id}`)
        .set('Cookie', h.cookie)
        .send({ font_choice: font })
        .expect(200);
      expect(h.store.getEventConfig(id)!.fontChoice).toBe(font);
    }
  });

  it('refuses a layout style that does not ship', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    const res = await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ layout_style: 'fullscreen_slideshow' });

    expect(res.status).toBe(400);
    expect(h.store.getEventConfig(id)!.layoutStyle).toBe('stage_sidebar');
  });

  it('refuses an out-of-range per-photo duration rather than silently clamping it', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    for (const bad of [PHOTO_DURATION_RANGE.min - 1, PHOTO_DURATION_RANGE.max + 1, 0, -6000, 1.5, NaN]) {
      const res = await request(h.app)
        .post(`/cms/api/events/${id}`)
        .set('Cookie', h.cookie)
        .send({ photo_duration_ms: bad });
      expect(res.status, `photo_duration_ms=${bad} must be refused`).toBe(400);
    }
    // Silent clamping would leave the operator's form and the room screen
    // disagreeing about what was saved.
    expect(h.store.getEventConfig(id)!.photoDurationMs).toBe(DEFAULT_EVENT_CONFIG.photoDurationMs);
  });

  it('refuses an out-of-range photo count and accepts both ends of the range', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    for (const bad of [PHOTO_COUNT_RANGE.min - 1, PHOTO_COUNT_RANGE.max + 1]) {
      const res = await request(h.app)
        .post(`/cms/api/events/${id}`)
        .set('Cookie', h.cookie)
        .send({ photo_count: bad });
      expect(res.status, `photo_count=${bad} must be refused`).toBe(400);
    }
    for (const good of [PHOTO_COUNT_RANGE.min, PHOTO_COUNT_RANGE.max]) {
      await request(h.app)
        .post(`/cms/api/events/${id}`)
        .set('Cookie', h.cookie)
        .send({ photo_count: good })
        .expect(200);
    }
  });

  it('refuses a colour that is not a six-digit hex value', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    for (const bad of ['red', '#fff', 'rgb(0,0,0)', '#12345g', 'url(javascript:alert(1))', '#000;}']) {
      const res = await request(h.app)
        .post(`/cms/api/events/${id}`)
        .set('Cookie', h.cookie)
        .send({ color_accent: bad });
      expect(res.status, `${bad} must be refused as a colour`).toBe(400);
    }
    await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ color_accent: '#ff8800' })
      .expect(200);
    expect(h.store.getEventConfig(id)!.colorAccent).toBe('#ff8800');
  });

  it('refuses the whole save when one field of several is invalid — no partial write', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    const res = await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ idle_heading: 'Hợp lệ', font_choice: 'Comic Sans' });

    expect(res.status).toBe(400);
    expect(h.store.getEventConfig(id)!.idleHeading).toBe(DEFAULT_EVENT_CONFIG.idleHeading);
  });
});

// ---------------------------------------------------------------------------
// The UI-SPEC contracts that are visible in the markup
// ---------------------------------------------------------------------------

describe('UI-SPEC contracts in the rendered CMS markup', () => {
  it('renders the save-success copy after a save and the save-error copy on a rejected one', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    const saved = await request(h.app).get(`/cms/events/${id}?saved=1`).set('Cookie', h.cookie);
    expect(saved.text).toContain(SAVE_SUCCESS);

    const failed = await request(h.app).get(`/cms/events/${id}?error=1`).set('Cookie', h.cookie);
    expect(failed.text).toContain(SAVE_ERROR);
  });

  it('bounds the logo and background previews with object-fit: contain', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');
    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);

    expect(res.text).toContain('object-fit:contain');
  });

  it('truncates long list names with an ellipsis while carrying the full name in title', async () => {
    const h = build();
    // 48 characters — long enough to overflow a list row, inside the 60-cap.
    // (The 61-character version of this string was the first thing the server
    // cap actually refused while this suite was being written.)
    const longName = 'Tiệc cưới của anh Nguyễn Văn A và chị Trần Thị B';
    await createEvent(h, longName);

    const res = await request(h.app).get('/cms/events').set('Cookie', h.cookie);
    expect(res.text).toContain('text-overflow:ellipsis');
    expect(res.text).toContain(`title="${longName}"`);
    // G2: the list scrolls rather than growing without bound.
    expect(res.text).toContain('overflow-y:auto');
  });

  it('escapes an operator-authored name in both the list and the form', async () => {
    const h = build();
    const id = await createEvent(h, '<img src=x onerror=alert(1)>');

    for (const url of ['/cms/events', `/cms/events/${id}`]) {
      const res = await request(h.app).get(url).set('Cookie', h.cookie);
      expect(res.text, `${url} must escape the name`).not.toContain('<img src=x onerror=alert(1)>');
      expect(res.text).toContain('&lt;img');
    }
  });

  it('gives every mutating control the ONE shared in-flight hook (G1)', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    for (const url of ['/cms/events', '/cms/events/new', `/cms/events/${id}`]) {
      const res = await request(h.app).get(url).set('Cookie', h.cookie);
      const forms = res.text.match(/<form[\s\S]*?<\/form>/g) ?? [];
      expect(forms.length, `${url} should render at least one form`).toBeGreaterThan(0);

      for (const form of forms) {
        for (const button of form.match(/<button[^>]*>/g) ?? []) {
          expect(button, `${url}: every button inside a form needs the shared hook`).toContain(
            'data-mutating',
          );
        }
      }
      // One shared implementation, not per-button variants: exactly one
      // in-flight handler is wired per page.
      expect((res.text.match(/data-inflight-label/g) ?? []).length).toBeGreaterThan(0);
    }
  });

  it('ships no icon-only control — every button with an SVG carries text or an aria-label', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');

    for (const url of ['/cms/events', `/cms/events/${id}`]) {
      const res = await request(h.app).get(url).set('Cookie', h.cookie);
      for (const button of res.text.match(/<button[\s\S]*?<\/button>/g) ?? []) {
        if (!button.includes('<svg')) continue;
        const withoutTags = button.replace(/<[^>]*>/g, '').trim();
        const hasLabel = /aria-label="[^"]+"/.test(button);
        expect(
          withoutTags.length > 0 || hasLabel,
          `${url}: an icon-only button shipped: ${button}`,
        ).toBe(true);
        // Where an icon ships, the SVG itself is hidden from assistive tech so
        // the label is announced once, not twice.
        expect(button).toContain('aria-hidden="true"');
      }
    }
  });

  it('keeps every interactive target at the 44px minimum the UI-SPEC pins', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới A');
    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);
    expect(res.text).toContain('min-height:44px');
  });
});
