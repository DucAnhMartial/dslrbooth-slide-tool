import { escapeHtml } from './cmsPages';
import type { EventSummary } from '../state/localStore';
import type { EventConfig } from '../types';

/**
 * The CMS Console's event surface: the library list, the configuration form,
 * and the two confirmation pages.
 *
 * Same inline template-string idiom as `displayPage.ts` and `cmsPages.ts` — no
 * framework, no bundler, no build step beyond `tsc` (08-UI-SPEC, locked).
 *
 * The design tokens below repeat `cmsPages.ts`'s CMS_STYLES rather than
 * importing them, because that constant is module-private there and this plan
 * executes in parallel with another that owns neighbouring files; widening an
 * export in a file outside this plan's declared set is a worse trade than one
 * duplicated token block. If the two ever need to change together, promoting
 * the block to a shared export is a two-line follow-up — recorded in the plan
 * summary rather than left to be discovered.
 */

// ---------------------------------------------------------------------------
// The configuration envelope — the values the CMS will accept
// ---------------------------------------------------------------------------

/**
 * UI-SPEC's save copy, verbatim, defined ONCE.
 *
 * These live in the page module and are imported by the routes — one
 * direction, no import cycle — so the string the JSON API returns and the
 * string the browser renders cannot drift into two slightly different
 * apologies.
 */
export const SAVE_SUCCESS = 'Đã lưu cấu hình sự kiện';
export const SAVE_ERROR = 'Không lưu được cấu hình — vui lòng thử lại. Nếu vẫn lỗi, liên hệ kỹ thuật.';

/**
 * UI-SPEC Open Question 1, answered by the human on 2026-08-12: exactly three
 * fonts, all self-hosted, never a CDN link. The room screen falls back to the
 * system stack for anything it does not recognise, and this list is the reason
 * it never has to.
 */
export const FONT_CHOICES = ['system-ui', 'be-vietnam-pro', 'lora'] as const;

/**
 * UI-SPEC Open Question 2, answered: ONE layout ships this phase. The field
 * exists so a later layout needs no migration; a second value here would grow
 * a room-screen test matrix for a layout that does not exist.
 */
export const LAYOUT_STYLES = ['stage_sidebar'] as const;

/**
 * The character caps. CONTEXT left these to the planner's discretion; these
 * are chosen against what the room screen renders legibly at TV distance, not
 * against what SQLite can hold.
 *
 * - `name` 60: an event name appears in the CMS list row and in the room
 *   screen's header; past ~60 characters the header wraps into the stage area.
 * - `idle_heading` 80: rendered at the Display size (clamp up to 8rem). Beyond
 *   80 characters it stops being a heading and starts being a paragraph set in
 *   display type.
 * - `idle_sub` 120: one or two lines of supporting copy at Label size.
 * - `qr_cta_text` 60: sits beside the QR frame, in a column narrower than the
 *   heading's.
 *
 * Each cap is enforced by the SERVER as well as by the input attribute. The
 * attribute is a courtesy to the operator; the check in validateEventPatch()
 * is the control, because a `maxlength` is one devtools edit away from absent.
 */
export const FIELD_CAPS = {
  name: 60,
  idle_heading: 80,
  idle_sub: 120,
  qr_cta_text: 60,
  guest_name_template: 240,
} as const;

/** How many photos the slideshow holds. */
export const PHOTO_COUNT_RANGE = { min: 1, max: 50 } as const;
/** CMS-10: percent, so 0 means the operator's artwork is shown untouched. */
export const BACKGROUND_OVERLAY_RANGE = { min: 0, max: 100 } as const;

/**
 * How long each photo is held, in milliseconds. The floor is a legibility
 * bound, not a technical one: below ~2s a guest looking up from their phone
 * cannot find their own photo before it is gone.
 */
export const PHOTO_DURATION_RANGE = { min: 2000, max: 30_000 } as const;

/**
 * D-12: every TV opens THIS path and renders whatever event is active. There
 * is no per-event URL, so there is no per-event string to copy — the copy
 * control exists so an operator setting up a new screen does not have to
 * remember the path under pressure, not because it varies.
 */
export const SCREEN_URL_PATH = '/display-screen';

/**
 * D9-06: the slides-only variant of the SAME fixed URL above, selected by
 * `?view=slides` (D9-01) — not a second screen identity, not a per-event
 * link. It belongs beside `SCREEN_URL_PATH` in the same fixed screen-address
 * card for the same reason: there is one string to copy per screen TYPE, and
 * the D-12 test asserts that count does not grow with the event list.
 */
export const SLIDES_SCREEN_URL_PATH = `${SCREEN_URL_PATH}?view=slides`;

const FONT_LABELS: Record<string, string> = {
  'system-ui': 'Mặc định hệ thống (system-ui)',
  'be-vietnam-pro': 'Be Vietnam Pro (chữ không chân)',
  lora: 'Lora (chữ có chân)',
};

const LAYOUT_LABELS: Record<string, string> = {
  stage_sidebar: 'Sân khấu + danh sách chờ (mặc định)',
};

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

const STYLES = `
    :root{
      --bg:#f7f7f9;--surface:#ffffff;--border:rgba(0,0,0,.08);
      --accent:#6c8fff;--destructive:#a33127;--text:#171719;--text-muted:#5f5f6b;
      --sp-xs:4px;--sp-sm:8px;--sp-md:16px;--sp-lg:24px;--sp-xl:32px;--sp-2xl:48px;
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);
      font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;font-weight:400;line-height:1.5}
    h1{font-size:28px;font-weight:600;line-height:1.2;margin:0 0 var(--sp-lg)}
    h2{font-size:20px;font-weight:600;line-height:1.2;margin:0 0 var(--sp-md)}
    label{display:block;font-size:16px;font-weight:400;margin-bottom:var(--sp-sm)}
    main{max-width:900px;margin:0 auto;padding:var(--sp-xl)}
    header{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-md);margin-bottom:var(--sp-lg)}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:var(--sp-lg);margin-bottom:var(--sp-lg)}
    input[type=text],input[type=number],select{width:100%;min-height:44px;padding:var(--sp-sm) var(--sp-md);
      font-size:16px;font-family:inherit;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)}
    input[type=color]{width:64px;min-height:44px;padding:var(--sp-xs);border:1px solid var(--border);border-radius:6px;background:var(--surface)}
    input[type=file]{font-size:14px;font-family:inherit}
    input:focus-visible,button:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--sp-xs);
      min-height:44px;padding:var(--sp-sm) var(--sp-lg);font-size:16px;font-weight:600;font-family:inherit;
      border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
    button[disabled]{opacity:.6;cursor:progress}
    button.secondary,.btn.secondary{background:var(--surface);color:var(--text);border:1px solid var(--border)}
    button.destructive,.btn.destructive{background:var(--destructive);color:#fff}
    .muted{color:var(--text-muted)}
    .error{color:var(--destructive);font-size:16px;margin:0 0 var(--sp-md)}
    .ok{color:#1d6b4f;font-size:16px;margin:0 0 var(--sp-md)}
    .field{margin-bottom:var(--sp-md)}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--sp-md)}
    .actions{display:flex;flex-wrap:wrap;gap:var(--sp-md);align-items:center}
    /* UI-SPEC G1: one spinner, one disabled state, shared by every mutating
       control on every CMS page — not a per-button variant. */
    .spin{width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;
      border-radius:50%;display:inline-block;animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
`;

/**
 * UI-SPEC's logo rule (Open Question 5, closed with the stated default): an
 * uploaded asset has an arbitrary aspect ratio, so the preview box is bounded
 * and the image is contained inside it — never stretched, never cropped.
 */
const PREVIEW_STYLES = `
    .preview{width:200px;height:120px;border:1px dashed var(--border);border-radius:6px;background:var(--bg);
      display:grid;place-items:center;overflow:hidden;margin-bottom:var(--sp-sm)}
    .preview img{max-width:100%;max-height:100%;object-fit:contain}
    .preview .placeholder{color:var(--text-muted);font-size:14px;text-align:center;padding:var(--sp-sm)}
`;

/**
 * D9-04: the shared `label{display:block}` and the 44px minimum-height rules
 * above are written for text inputs — a checkbox stretched by them looks like
 * a rendering bug, not a control. This block scopes the checkbox row to its
 * own flex layout instead of overriding the shared rules globally.
 */
const CHECKBOX_STYLES = `
    .checkbox-row{display:flex;align-items:center;gap:var(--sp-sm);min-height:44px;margin-bottom:0;cursor:pointer}
    .checkbox-row input[type=checkbox]{width:20px;height:20px;flex:none;min-height:0}

    /* CMS-08: the which-screen tag beside every field label. Colour-coded so
       a glance down the form groups the settings by screen without reading
       each one, and quiet enough that the label still reads first. */
    .screentag{display:inline-block;margin-left:.5rem;padding:.1rem .5rem;border-radius:999px;
      font-size:.7rem;font-weight:600;letter-spacing:.02em;vertical-align:middle;
      border:1px solid currentColor;opacity:.85;white-space:nowrap}
    .screentag.both{color:#2f6f4f}
    .screentag.waiting{color:#2f5f8f}
    .screentag.slides{color:#7a4a8f}
    .screentag.none{color:#7a7a7a}

    /* The legend, once at the top of the form. */
    .screenlegend{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;
      margin:0 0 var(--sp-md);padding:.75rem 1rem;border-radius:.6rem;
      background:rgba(127,127,127,.08);font-size:.85rem}
    .screenlegend b{font-weight:600}
`;

/**
 * The ONE in-flight implementation (UI-SPEC G1, human-answered 2026-08-12).
 *
 * Every mutating control on every CMS page carries `data-mutating` and a
 * `data-inflight-label`; this handler is what turns those attributes into the
 * disabled+spinner state. Written once and shared rather than per button,
 * because "no mutating control can be double-submitted" is a property of the
 * whole console — a per-button variant is a per-button opportunity to forget.
 *
 * `busy` is checked before anything else, so a second click during a request
 * cannot start a second one even if the browser dispatches it.
 */
const INFLIGHT_SCRIPT = `
  function cmsBusy(button){
    if(!button) return false;
    if(button.dataset.busy === '1') return false;
    button.dataset.busy = '1';
    button.dataset.prevHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spin" aria-hidden="true"></span> ' + (button.dataset.inflightLabel || 'Đang xử lý…');
    return true;
  }
  function cmsRelease(button){
    if(!button) return;
    button.disabled = false;
    button.dataset.busy = '';
    if(button.dataset.prevHtml) button.innerHTML = button.dataset.prevHtml;
  }
  function cmsFail(){ alert(${JSON.stringify(SAVE_ERROR)}); }
  /* CMS-09: an expired session, seen from inside a page that is already open.
     Sessions have no timeout, so this happens when the service restarts under
     a CMS tab someone left open — a deploy, a crash, a reboot. Before this,
     every such action failed with the generic save error, which told the
     operator their edit was broken when in fact they were simply logged out.
     A 401 is never a content error: send them to the login page, carrying
     where they were so they land back on it. Returns true when it handled the
     response, so callers can stop. */
  function cmsHandleAuth(res){
    if(!res || res.status !== 401) return false;
    location.href = '/cms/login?next=' + encodeURIComponent(location.pathname + location.search);
    return true;
  }
`;

/**
 * Exported for `cmsAgentPages.ts` (plan 08-04). This is the follow-up the note
 * at the top of this file recorded: the shared chrome and the ONE in-flight
 * implementation are promoted to an export rather than duplicated a second
 * time, now that no parallel plan owns this file. A second copy of
 * INFLIGHT_SCRIPT would be a second place for "no mutating control can be
 * double-submitted" to stop being true.
 */
export function page(title: string, extraStyles: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}${extraStyles}</style>
</head>
<body>
${body}
<script>${INFLIGHT_SCRIPT}${script}</script>
</body></html>`;
}

/**
 * The logout control, repeated on every page. A form post, and `data-mutating`
 * like every other mutating control — ending a session is a write.
 */
export const LOGOUT_FORM = `<form method="post" action="/cms/logout">
      <button class="secondary" type="submit" data-mutating data-inflight-label="Đang đăng xuất…">Đăng xuất</button>
    </form>`;

/** Upload icon — never shipped alone; see the accessibility note in UI-SPEC. */
const UPLOAD_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 11V3m0 0L5 6m3-3 3 3"/><path d="M2 11v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"/></svg>`;

/**
 * Warning icon, used on the confirmation pages and on the photo-history
 * placeholder tile, ALWAYS beside its label. Exported for `cmsPhotoPages.ts`
 * for the same reason `page()` and `LOGOUT_FORM` are: one destructive language
 * across the console, and one copy of the glyph to keep it that way.
 */
export const WARNING_ICON =`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 2 1.5 13.5h13L8 2Z"/><path d="M8 6.5v3.2M8 11.6v.1"/></svg>`;

// ---------------------------------------------------------------------------
// The event list
// ---------------------------------------------------------------------------

/**
 * The event library, and the operator's landing page after login.
 *
 * With zero events this renders the UI-SPEC empty state — a heading, a
 * sentence, and the create CTA — and no list container at all. "Never a blank
 * table" is satisfied here in its strongest form: there is no table.
 */
export function renderCmsEventListPage(data: {
  events: EventSummary[];
  activeEventId?: string;
}): string {
  const rows = data.events
    .map((event) => {
      const isActive = event.id === data.activeEventId;
      const name = escapeHtml(event.name);
      const id = escapeHtml(event.id);
      return `<li class="row">
        <span class="name" title="${name}">${name}</span>
        <span class="badge">${isActive ? 'Đang phát' : ''}</span>
        <a class="btn secondary" href="/cms/events/${id}">Sửa cấu hình</a>
        <a class="btn secondary" href="/cms/photos?event=${id}">Lịch sử ảnh</a>
        ${
          isActive
            ? '<span class="muted">Đang hoạt động</span>'
            : `<a class="btn" href="/cms/events/${id}/activate">Kích hoạt</a>`
        }
      </li>`;
    })
    .join('');

  // G2: the list scrolls; operator event counts are small, so no pagination.
  const list = data.events.length
    ? `<ul id="eventList">${rows}</ul>`
    : `<div class="empty">
        <h2>Chưa có sự kiện nào</h2>
        <p class="muted">Tạo sự kiện đầu tiên để bắt đầu cấu hình màn hình phòng.</p>
      </div>`;

  const body = `<main>
  <header>
    <h1>Bảng điều khiển sự kiện</h1>
    ${LOGOUT_FORM}
  </header>
  <div class="card">
    <div class="actions" style="margin-bottom:var(--sp-lg)">
      <a class="btn" href="/cms/events/new">+ Tạo sự kiện mới</a>
      <a class="btn secondary" href="/cms/booth">Kết thúc khách này</a>
    </div>
    ${list}
  </div>
  <div class="card">
    <h2>Địa chỉ màn hình phòng</h2>
    <p class="muted">Mở địa chỉ phù hợp trên mỗi TV trong phòng. Địa chỉ giống nhau cho mọi sự kiện —
      màn hình luôn hiển thị sự kiện đang hoạt động, không cần sửa lại khi đổi khách.</p>
    <div class="screenUrlRow">
      <p class="muted"><strong>Loại 1 — Thứ tự + slide</strong> (màn hình hiện tại, không đổi)</p>
      <div class="actions">
        <code id="screenUrl">${SCREEN_URL_PATH}</code>
        <button class="secondary" type="button" id="copyUrl" data-nonmutating="copy">Sao chép địa chỉ</button>
        <span class="muted" id="copyState" role="status"></span>
      </div>
    </div>
    <div class="screenUrlRow">
      <p class="muted"><strong>Loại 2 — Chỉ slide</strong> (chỉ có ảnh, không có danh sách chờ)</p>
      <div class="actions">
        <code id="slidesUrl">${SLIDES_SCREEN_URL_PATH}</code>
        <button class="secondary" type="button" id="copySlidesUrl" data-nonmutating="copy">Sao chép địa chỉ</button>
        <span class="muted" id="copySlidesState" role="status"></span>
      </div>
    </div>
  </div>
</main>`;

  const styles = `
    ul{list-style:none;padding:0;margin:0;max-height:60vh;overflow-y:auto}
    .row{display:grid;grid-template-columns:1fr auto auto auto auto;gap:var(--sp-md);align-items:center;
      min-height:44px;padding:var(--sp-md) 0;border-top:1px solid var(--border)}
    .row:first-child{border-top:0}
    .name{font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .badge{color:var(--accent);font-weight:600}
    .empty{padding:var(--sp-2xl) 0;text-align:center}
    code{font-size:16px;background:var(--bg);padding:var(--sp-sm) var(--sp-md);border-radius:6px}
    .screenUrlRow{margin-bottom:var(--sp-md)}
    .screenUrlRow:last-child{margin-bottom:0}
`;

  // Copying a URL mutates nothing, so it deliberately does NOT take the
  // in-flight state — G1 is about writes, and disabling a read-only control
  // would be noise. D9-06: the same copy behaviour serves both labeled
  // screen-address types, parameterized rather than duplicated a second time.
  const script = `
  function bindCopy(buttonId, stateId, path){
    var button = document.querySelector('#' + buttonId);
    button.addEventListener('click', function(){
      var full = location.origin + path;
      var done = function(){ document.querySelector('#' + stateId).textContent = 'Đã sao chép'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(full).then(done, function(){ document.querySelector('#' + stateId).textContent = full; });
      } else {
        document.querySelector('#' + stateId).textContent = full;
      }
    });
  }
  bindCopy('copyUrl', 'copyState', ${JSON.stringify(SCREEN_URL_PATH)});
  bindCopy('copySlidesUrl', 'copySlidesState', ${JSON.stringify(SLIDES_SCREEN_URL_PATH)});
`;

  return page('Bảng điều khiển sự kiện', styles, body, script);
}

// ---------------------------------------------------------------------------
// The create form
// ---------------------------------------------------------------------------

/** A name, and nothing else — every other field has a shipped default. */
export function renderCmsEventCreatePage(): string {
  const body = `<main>
  <header>
    <h1>Tạo sự kiện mới</h1>
    <a class="btn secondary" href="/cms/events">Quay lại danh sách</a>
  </header>
  <div class="card">
    <p class="error" id="formError" role="alert" hidden></p>
    <form id="createForm">
      <div class="field">
        <label for="name">Tên sự kiện</label>
        <input id="name" name="name" type="text" maxlength="${FIELD_CAPS.name}" required
          placeholder="Ví dụ: Tiệc cưới Minh &amp; Lan">
        <p class="muted">Tối đa ${FIELD_CAPS.name} ký tự. Mọi cấu hình khác đã có sẵn giá trị mặc định —
          sự kiện tạo xong là dùng được ngay.</p>
      </div>
      <button type="submit" id="createBtn" data-mutating data-inflight-label="Đang tạo…">+ Tạo sự kiện mới</button>
    </form>
  </div>
</main>`;

  const script = `
  document.querySelector('#createForm').addEventListener('submit', async function(e){
    e.preventDefault();
    var button = document.querySelector('#createBtn');
    var input = document.querySelector('#name');
    if (!input.value.trim()) return;
    if (!cmsBusy(button)) return;
    try {
      var res = await fetch('/cms/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: input.value })
      });
      if (cmsHandleAuth(res)) return;
      if (res.ok) { var created = await res.json(); location.href = '/cms/events/' + created.id + '?saved=1'; return; }
    } catch (err) { /* fall through to the shared failure copy */ }
    cmsRelease(button);
    var box = document.querySelector('#formError');
    box.textContent = ${JSON.stringify(SAVE_ERROR)};
    box.hidden = false;
  });
`;

  return page('Tạo sự kiện mới', '', body, script);
}

// ---------------------------------------------------------------------------
// The configuration form
// ---------------------------------------------------------------------------

/**
 * CMS-08: which screen does this field actually change?
 *
 * The form mixes settings for two different screens plus a couple that change
 * nothing visible at all, and said so nowhere — an operator edited the QR, the
 * background and the photo settings and reported seeing no change anywhere,
 * partly because some of it genuinely did nothing and partly because the rest
 * only shows on a screen they were not looking at.
 *
 * THE MAP IS DERIVED FROM THE PAGES, NOT FROM INTENT. Each entry below was
 * read out of displayPage.ts and slidesPage.ts by listing every 'cfg.' they
 * dereference; test/cms-field-screen-tags.test.ts re-derives it the same way
 * and fails if a page starts or stops reading a field without this map being
 * updated. A label that drifts from behaviour is worse than no label, because
 * it is believed.
 */
export const SCREEN_TAG = {
  both: { text: 'Cả hai màn', cls: 'both' },
  waiting: { text: 'Màn chờ chụp', cls: 'waiting' },
  slides: { text: 'Màn trình chiếu', cls: 'slides' },
  cmsOnly: { text: 'Chỉ trong CMS', cls: 'none' },
  inactive: { text: 'Chưa dùng', cls: 'none' },
} as const;

export type ScreenTagKey = keyof typeof SCREEN_TAG;

/** Field name (the form's own `name` attribute) -> which screen it affects. */
export const FIELD_SCREEN_MAP: Record<string, ScreenTagKey> = {
  name: 'cmsOnly',
  logo_url: 'both',
  background_url: 'both',
  background_overlay: 'both',
  color_dominant: 'both',
  color_secondary: 'both',
  color_accent: 'both',
  color_text: 'both',
  color_text_muted: 'both',
  font_choice: 'both',
  idle_heading: 'both',
  idle_sub: 'both',
  qr_cta_text: 'both',
  qr_image_url: 'waiting',
  photo_count: 'slides',
  photo_duration_ms: 'slides',
  show_guest_name: 'slides',
  hero_enabled: 'slides',
  guest_name_template: 'slides',
  caption_position: 'slides',
  photo_fit: 'slides',
  layout_style: 'inactive',
};

function screenTag(fieldName: string): string {
  const key = FIELD_SCREEN_MAP[fieldName];
  if (!key) return '';
  const tag = SCREEN_TAG[key];
  return `<span class="screentag ${tag.cls}">${tag.text}</span>`;
}

// ---------------------------------------------------------------------------

function textField(opts: {
  name: string;
  label: string;
  value: string;
  maxlength: number;
  hint?: string;
}): string {
  return `<div class="field">
        <label for="${opts.name}">${opts.label}${screenTag(opts.name)}</label>
        <input id="${opts.name}" name="${opts.name}" type="text" maxlength="${opts.maxlength}"
          value="${escapeHtml(opts.value)}">
        ${opts.hint ? `<p class="muted">${opts.hint}</p>` : ''}
      </div>`;
}

function colorField(name: string, label: string, value: string): string {
  return `<div class="field">
        <label for="${name}">${label}${screenTag(name)}</label>
        <input id="${name}" name="${name}" type="color" value="${escapeHtml(value)}">
      </div>`;
}

/**
 * D9-04: one of the two per-event display toggles. The wrapper row puts the
 * input and its label side by side (see CHECKBOX_STYLES) rather than the
 * block layout every text field above uses, with a hint stating plainly which
 * screens the toggle affects — both toggles are event configuration, so both
 * change the default layout as well as the slides-only view.
 */
function checkboxField(opts: { name: string; label: string; checked: boolean; hint: string }): string {
  return `<div class="field">
        <label class="checkbox-row" for="${opts.name}">
          <input id="${opts.name}" name="${opts.name}" type="checkbox"${opts.checked ? ' checked' : ''}>
          <span>${opts.label}${screenTag(opts.name)}</span>
        </label>
        <p class="muted">${opts.hint}</p>
      </div>`;
}

/**
 * One uploaded asset: a bounded preview, a file picker, and an upload button.
 * The hidden input is what the save actually submits — the stored URL the
 * server minted, never the file's own name, which is not sent anywhere that
 * reads it.
 */
function assetField(opts: { name: string; label: string; value: string | null; hint: string }): string {
  const preview = opts.value
    ? `<img src="${escapeHtml(opts.value)}" alt="">`
    : `<span class="placeholder">Chưa có ảnh</span>`;
  return `<div class="field">
        <label for="${opts.name}_file">${opts.label}${screenTag(opts.name)}</label>
        <div class="preview" id="${opts.name}_preview">${preview}</div>
        <input type="hidden" name="${opts.name}" id="${opts.name}" value="${escapeHtml(opts.value ?? '')}">
        <div class="actions">
          <input type="file" id="${opts.name}_file" accept="image/png,image/jpeg,image/gif,image/webp">
          <button type="button" class="secondary" data-mutating data-inflight-label="Đang tải lên…"
            data-upload-for="${opts.name}">${UPLOAD_ICON}<span>Tải ảnh lên</span></button>
          <button type="button" class="secondary" data-mutating data-inflight-label="Đang xóa…"
            data-clear-for="${opts.name}">Xóa ảnh</button>
        </div>
        <p class="muted">${opts.hint}</p>
      </div>`;
}

/**
 * The whole CMS-01 field set on one page.
 *
 * Every field here writes to a column `buildSnapshot()` projects into
 * `eventConfig`. That correspondence is the point: a field added to this form
 * without a matching column in the projection would change nothing on any
 * screen while looking, to the operator, exactly like a working control.
 */
export function renderCmsEventFormPage(data: {
  event: EventConfig;
  notice?: 'saved' | 'error';
  photoCount?: number;
}): string {
  const event = data.event;
  const id = escapeHtml(event.id ?? '');
  const notice =
    data.notice === 'saved'
      ? `<p class="ok" role="status">${SAVE_SUCCESS}</p>`
      : data.notice === 'error'
        ? `<p class="error" role="alert">${SAVE_ERROR}</p>`
        : '';

  const fontOptions = FONT_CHOICES.map(
    (font) =>
      `<option value="${font}"${event.fontChoice === font ? ' selected' : ''}>${FONT_LABELS[font]}</option>`,
  ).join('');
  const layoutOptions = LAYOUT_STYLES.map(
    (layout) =>
      `<option value="${layout}"${event.layoutStyle === layout ? ' selected' : ''}>${LAYOUT_LABELS[layout]}</option>`,
  ).join('');

  const body = `<main>
  <header>
    <h1>Cấu hình sự kiện</h1>
    <a class="btn secondary" href="/cms/events">Quay lại danh sách</a>
  </header>
  <div class="card">
    ${notice}
    <p class="ok" id="saveOk" role="status" hidden>${SAVE_SUCCESS}</p>
    <p class="error" id="saveError" role="alert" hidden>${SAVE_ERROR}</p>
    <form id="eventForm" data-event-id="${id}">
      <p class="screenlegend">
        <b>Mỗi cài đặt bên dưới có nhãn cho biết nó đổi màn nào:</b>
        <span class="screentag both">${SCREEN_TAG.both.text}</span>
        <span class="screentag waiting">${SCREEN_TAG.waiting.text}</span>
        <span class="screentag slides">${SCREEN_TAG.slides.text}</span>
        <span class="screentag none">${SCREEN_TAG.cmsOnly.text}</span>
        <span class="screentag none">${SCREEN_TAG.inactive.text}</span>
      </p>
      <h2>Tên sự kiện</h2>
      ${textField({
        name: 'name',
        label: 'Tên sự kiện',
        value: event.name,
        maxlength: FIELD_CAPS.name,
        hint: `Tối đa ${FIELD_CAPS.name} ký tự.`,
      })}

      <h2>Hình ảnh</h2>
      ${assetField({
        name: 'logo_url',
        label: 'Logo',
        value: event.logoUrl,
        hint: 'PNG, JPEG, GIF hoặc WEBP, tối đa 5MB. Ảnh hiển thị trọn khung, không bị kéo méo hay cắt xén.',
      })}
      ${assetField({
        name: 'background_url',
        label: 'Ảnh nền / ảnh chờ',
        value: event.backgroundUrl,
        hint: 'Ảnh nền của màn hình phòng, cũng là ảnh hiển thị ở trạng thái chờ khi chưa có khách nào.',
      })}

      <div class="field">
        <label for="background_overlay">Độ mờ phủ lên ảnh nền (%)${screenTag('background_overlay')}</label>
        <input id="background_overlay" name="background_overlay" type="number"
          min="${BACKGROUND_OVERLAY_RANGE.min}" max="${BACKGROUND_OVERLAY_RANGE.max}"
          value="${event.backgroundOverlay}">
        <p class="muted">Từ ${BACKGROUND_OVERLAY_RANGE.min} đến ${BACKGROUND_OVERLAY_RANGE.max}.
          <b>0 = hiện nguyên ảnh nền, không phủ gì.</b> Số càng cao thì ảnh nền càng mờ đi và chữ càng dễ đọc.
          Ảnh nền sáng và nhiều chi tiết thì cần số cao; ảnh tối, đơn giản thì để thấp hoặc 0.</p>
      </div>

      <h2>Màu sắc</h2>
      <div class="grid">
        ${colorField('color_dominant', 'Màu nền chính', event.colorDominant)}
        ${colorField('color_secondary', 'Màu nền phụ', event.colorSecondary)}
        ${colorField('color_accent', 'Màu nhấn', event.colorAccent)}
        ${colorField('color_text', 'Màu chữ', event.colorText)}
        ${colorField('color_text_muted', 'Màu chữ phụ', event.colorTextMuted)}
      </div>
      <p class="muted">Màu báo lỗi và màu báo kết nối là cố định, không đổi theo sự kiện —
        để nhận diện sự cố không bao giờ bị lẫn vào màu thương hiệu.</p>

      <h2>Chữ và nội dung màn hình chờ</h2>
      <div class="field">
        <label for="font_choice">Phông chữ${screenTag('font_choice')}</label>
        <select id="font_choice" name="font_choice">${fontOptions}</select>
      </div>
      ${textField({
        name: 'idle_heading',
        label: 'Tiêu đề màn hình chờ',
        value: event.idleHeading,
        maxlength: FIELD_CAPS.idle_heading,
        hint: `Tối đa ${FIELD_CAPS.idle_heading} ký tự.`,
      })}
      ${textField({
        name: 'idle_sub',
        label: 'Lời chào / mô tả',
        value: event.idleSub,
        maxlength: FIELD_CAPS.idle_sub,
        hint: `Tối đa ${FIELD_CAPS.idle_sub} ký tự.`,
      })}

      <h2>Mã QR đăng ký</h2>
      ${assetField({
        name: 'qr_image_url',
        label: 'Ảnh mã QR',
        value: event.qrImageUrl,
        hint: 'Tải lên ảnh mã QR đã tạo sẵn cho sự kiện này.',
      })}
      ${textField({
        name: 'qr_cta_text',
        label: 'Dòng kêu gọi bên cạnh mã QR',
        value: event.qrCtaText,
        maxlength: FIELD_CAPS.qr_cta_text,
        hint: `Tối đa ${FIELD_CAPS.qr_cta_text} ký tự.`,
      })}

      <h2>Trình chiếu ảnh</h2>
      <div class="grid">
        <div class="field">
          <label for="photo_count">Số ảnh hiển thị${screenTag('photo_count')}</label>
          <input id="photo_count" name="photo_count" type="number" inputmode="numeric"
            min="${PHOTO_COUNT_RANGE.min}" max="${PHOTO_COUNT_RANGE.max}" step="1" value="${event.photoCount}">
          <p class="muted">Từ ${PHOTO_COUNT_RANGE.min} đến ${PHOTO_COUNT_RANGE.max} ảnh.</p>
        </div>
        <div class="field">
          <label for="photo_duration_ms">Thời gian mỗi ảnh (mili giây)${screenTag('photo_duration_ms')}</label>
          <input id="photo_duration_ms" name="photo_duration_ms" type="number" inputmode="numeric"
            min="${PHOTO_DURATION_RANGE.min}" max="${PHOTO_DURATION_RANGE.max}" step="100" value="${event.photoDurationMs}">
          <p class="muted">Từ ${PHOTO_DURATION_RANGE.min} đến ${PHOTO_DURATION_RANGE.max} mili giây.</p>
        </div>
        <div class="field">
          <label for="layout_style">Kiểu bố cục${screenTag('layout_style')}</label>
          <select id="layout_style" name="layout_style">${layoutOptions}</select>
        </div>
      </div>
      ${checkboxField({
        name: 'show_guest_name',
        label: 'Hiển thị tên khách trên ảnh',
        checked: event.showGuestName,
        hint: 'Chỉ áp dụng cho màn hình trình chiếu (?view=slides) — màn hình chờ chụp không hiển thị ảnh nào. Tắt để ẩn tên khách khỏi mọi ảnh trên màn trình chiếu.',
      })}
      ${checkboxField({
        name: 'hero_enabled',
        label: 'Hiệu ứng "ảnh vừa chụp" phóng to',
        checked: event.heroEnabled,
        hint: 'Chỉ áp dụng cho màn hình trình chiếu (?view=slides) — màn hình chờ chụp không hiển thị ảnh nào. Tắt để ảnh vừa chụp vào thẳng vòng trình chiếu, không phóng to riêng trước.',
      })}
      ${textField({
        name: 'guest_name_template',
        label: 'Mẫu chú thích tên khách',
        value: event.guestNameTemplate,
        maxlength: FIELD_CAPS.guest_name_template,
        hint: `Dùng {guest_name} để chèn tên khách. Tối đa ${FIELD_CAPS.guest_name_template} ký tự.`,
      })}
      <div class="grid">
        <div class="field">
          <label for="caption_position">Vị trí chú thích${screenTag('caption_position')}</label>
          <select id="caption_position" name="caption_position">
            ${['top-left','top-center','top-right','middle-left','middle-center','middle-right','bottom-left','bottom-center','bottom-right'].map((value) => `<option value="${value}"${event.captionPosition === value ? ' selected' : ''}>${value}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="photo_fit">Cách vừa ảnh${screenTag('photo_fit')}</label>
          <select id="photo_fit" name="photo_fit">
            <option value="contain"${event.photoFit === 'contain' ? ' selected' : ''}>contain</option>
            <option value="cover"${event.photoFit === 'cover' ? ' selected' : ''}>cover</option>
          </select>
          <p class="muted"><b>cover</b> phù hợp khung ảnh ngang và có thể cắt logo hoặc phần lớn dải ảnh dọc.</p>
        </div>
      </div>

      <div class="actions">
        <button type="submit" id="saveBtn" data-mutating data-inflight-label="Đang lưu…">Lưu cấu hình</button>
        <a class="btn secondary" href="/cms/events/${id}/activate">Kích hoạt sự kiện này</a>
        <a class="btn destructive" href="/cms/events/${id}/delete">Xóa sự kiện</a>
      </div>
    </form>
  </div>
</main>`;

  const script = `
  var form = document.querySelector('#eventForm');
  var eventId = form.dataset.eventId;

  function collect(){
    var payload = {};
    form.querySelectorAll('[name]').forEach(function(input){
      // D9-04: a checkbox's .value is a constant string regardless of its
      // checked state — without this branch the toggle would submit the
      // same payload whether ticked or not, and the control would silently
      // do nothing. This branch MUST run before the generic non-number path
      // below, which reads .value.
      if (input.type === 'checkbox') {
        payload[input.name] = input.checked;
      } else if (input.type === 'number') {
        payload[input.name] = input.value === '' ? null : Number(input.value);
      } else {
        payload[input.name] = input.value;
      }
    });
    return payload;
  }

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var button = document.querySelector('#saveBtn');
    if (!cmsBusy(button)) return;
    document.querySelector('#saveOk').hidden = true;
    document.querySelector('#saveError').hidden = true;
    var ok = false;
    try {
      var res = await fetch('/cms/api/events/' + encodeURIComponent(eventId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect())
      });
      if (cmsHandleAuth(res)) return;
      ok = res.ok;
    } catch (err) { ok = false; }
    cmsRelease(button);
    document.querySelector(ok ? '#saveOk' : '#saveError').hidden = false;
  });

  // Uploads post base64 inside JSON through the existing parser — deliberately
  // no multipart, and deliberately no upload library (RESEARCH "Don't
  // Hand-Roll": multipart parsing is the part with the CVE history).
  form.addEventListener('click', async function(e){
    var button = e.target.closest('[data-upload-for]');
    if (!button) return;
    var field = button.dataset.uploadFor;
    var picker = document.querySelector('#' + field + '_file');
    if (!picker.files || !picker.files[0]) { picker.click(); return; }
    if (!cmsBusy(button)) return;
    var file = picker.files[0];
    var reader = new FileReader();
    reader.onload = async function(){
      var ok = false;
      try {
        var res = await fetch('/cms/api/assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: String(reader.result) })
        });
        if (cmsHandleAuth(res)) return;
        if (res.ok) {
          var stored = await res.json();
          document.querySelector('#' + field).value = stored.url;
          document.querySelector('#' + field + '_preview').innerHTML = '<img alt="">';
          document.querySelector('#' + field + '_preview').firstChild.src = stored.url;
          ok = true;
        }
      } catch (err) { ok = false; }
      cmsRelease(button);
      if (!ok) cmsFail();
    };
    reader.onerror = function(){ cmsRelease(button); cmsFail(); };
    reader.readAsDataURL(file);
  });

  form.addEventListener('click', function(e){
    var button = e.target.closest('[data-clear-for]');
    if (!button) return;
    var field = button.dataset.clearFor;
    document.querySelector('#' + field).value = '';
    document.querySelector('#' + field + '_preview').innerHTML = '<span class="placeholder">Chưa có ảnh</span>';
  });
`;

  return page('Cấu hình sự kiện', PREVIEW_STYLES + CHECKBOX_STYLES, body, script);
}

// ---------------------------------------------------------------------------
// The two confirmations
// ---------------------------------------------------------------------------

/**
 * D-02's confirmation, and the reason it is a WARNING rather than a block.
 *
 * The count comes from the live queue and is stated plainly, because the
 * operator's real question at 8pm is "how many people am I about to confuse?"
 * — not "may I?". Blocking until the queue drained was rejected on measured
 * evidence: a ticket once sat queued with nobody to shoot it and had to be
 * fixed by hand in the database. A CMS that refuses to switch until that
 * clears is a CMS that is unusable exactly when the room is busiest.
 */
export function renderCmsActivateConfirmPage(data: {
  event: EventSummary;
  queueLength: number;
  alreadyActive: boolean;
}): string {
  const name = escapeHtml(data.event.name);
  const id = escapeHtml(data.event.id);
  const waiting =
    data.queueLength > 0
      ? `<p class="warn">${WARNING_ICON}<span>Còn ${data.queueLength} khách đang chờ trong hàng đợi.</span></p>
       <p class="muted">Đổi sự kiện đang phát sẽ thay đổi giao diện mọi màn hình ngay lập tức.
         Hàng đợi không bị ảnh hưởng — ${data.queueLength} khách đang chờ vẫn được chụp bình thường.</p>`
      : `<p class="muted">Hiện không có khách nào đang chờ.</p>`;

  const body = `<main>
  <header>
    <h1>Kích hoạt sự kiện</h1>
    <a class="btn secondary" href="/cms/events">Quay lại danh sách</a>
  </header>
  <div class="card">
    <h2>${name}</h2>
    ${waiting}
    <p class="error" id="switchError" role="alert" hidden>${SAVE_ERROR}</p>
    <form id="activateForm" data-event-id="${id}" data-waiting="${data.queueLength}">
      <div class="actions">
        <button type="submit" id="activateBtn" data-mutating data-inflight-label="Đang kích hoạt…"
          ${data.alreadyActive ? 'disabled' : ''}>Kích hoạt sự kiện này</button>
        <a class="btn secondary" href="/cms/events">Hủy</a>
      </div>
    </form>
  </div>
</main>`;

  const styles = `.warn{display:flex;align-items:center;gap:var(--sp-sm);color:var(--destructive);font-size:16px;font-weight:600}`;

  const script = `
  var form = document.querySelector('#activateForm');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var button = document.querySelector('#activateBtn');
    if (!cmsBusy(button)) return;
    var ok = false;
    try {
      var res = await fetch('/cms/api/events/' + encodeURIComponent(form.dataset.eventId) + '/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The confirmation is carried to the SERVER, which is what enforces
        // it. A dialog the browser could skip is not the decision D-02 asks
        // for; this field is.
        body: JSON.stringify({ confirmed: true })
      });
      if (cmsHandleAuth(res)) return;
      ok = res.ok;
    } catch (err) { ok = false; }
    if (ok) { location.href = '/cms/events'; return; }
    cmsRelease(button);
    document.querySelector('#switchError').hidden = false;
  });
`;

  return page('Kích hoạt sự kiện', styles, body, script);
}

/**
 * The typed destructive confirmation. The operator retypes the event's name —
 * the confirmation the UI-SPEC copy promises, made specific to one event so a
 * reflexive click cannot delete the wrong one.
 */
export function renderCmsDeleteConfirmPage(data: {
  event: EventSummary;
  photoCount: number;
  isActive: boolean;
}): string {
  const name = escapeHtml(data.event.name);
  const id = escapeHtml(data.event.id);

  const body = `<main>
  <header>
    <h1>Xóa sự kiện</h1>
    <a class="btn secondary" href="/cms/events">Quay lại danh sách</a>
  </header>
  <div class="card">
    <p class="warn">${WARNING_ICON}<span>Xóa sự kiện “${name}”? Toàn bộ cấu hình và lịch sử ảnh sẽ mất. Không thể hoàn tác.</span></p>
    <p class="muted">Sự kiện này đang có ${data.photoCount} ảnh trong lịch sử.${
      data.isActive
        ? ' Đây là sự kiện đang phát — sau khi xóa, mọi màn hình sẽ quay về giao diện mặc định.'
        : ''
    }</p>
    <p class="error" id="deleteError" role="alert" hidden>${SAVE_ERROR}</p>
    <form id="deleteForm" data-event-id="${id}">
      <div class="field">
        <label for="confirmName">Nhập lại tên sự kiện để xác nhận</label>
        <input id="confirmName" name="confirmName" type="text" maxlength="${FIELD_CAPS.name}" autocomplete="off">
      </div>
      <div class="actions">
        <button type="submit" class="destructive" id="deleteBtn" data-mutating data-inflight-label="Đang xóa…">Xóa sự kiện</button>
        <a class="btn secondary" href="/cms/events">Hủy</a>
      </div>
    </form>
  </div>
</main>`;

  const styles = `.warn{display:flex;align-items:center;gap:var(--sp-sm);color:var(--destructive);font-size:16px;font-weight:600}`;

  const script = `
  var form = document.querySelector('#deleteForm');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var button = document.querySelector('#deleteBtn');
    if (!cmsBusy(button)) return;
    var ok = false;
    try {
      var res = await fetch('/cms/api/events/' + encodeURIComponent(form.dataset.eventId) + '/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: document.querySelector('#confirmName').value })
      });
      if (cmsHandleAuth(res)) return;
      ok = res.ok;
    } catch (err) { ok = false; }
    if (ok) { location.href = '/cms/events'; return; }
    cmsRelease(button);
    document.querySelector('#deleteError').hidden = false;
  });
`;

  return page('Xóa sự kiện', styles, body, script);
}
