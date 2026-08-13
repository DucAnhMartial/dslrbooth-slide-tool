import { escapeHtml, jsonForScript } from './cmsPages';
import { page, LOGOUT_FORM, WARNING_ICON } from './cmsEventPages';
import type { EventSummary } from '../state/localStore';

/**
 * The CMS Console's photo-history surface (CMS-03, D-10, D-11).
 *
 * The shared chrome — the design tokens, the ONE in-flight implementation, and
 * the logout control — is IMPORTED from `cmsEventPages.ts` rather than copied.
 * Plan 08-04 promoted `page()` and `LOGOUT_FORM` to exports for exactly this
 * reason: a second copy of the in-flight script would be a second place for
 * "no mutating control can be double-submitted" to stop being true.
 *
 * What this surface renders is a list of URLs, never images this service holds.
 * D-10 stores a reference to wherever the delivery webhook put the photo, so
 * nothing here fetches, copies or proxies an image — the operator's browser
 * loads it straight from its real home, and the case where that home has since
 * dropped the file is a DESIGNED state (see the G4 placeholder below), not an
 * error path.
 */

// ---------------------------------------------------------------------------
// The contract this page renders against
// ---------------------------------------------------------------------------

/**
 * UI-SPEC G2, human-answered 2026-08-12: photo history paginates at 50 a page,
 * newest first. The bound lives HERE and at the query, deliberately, because
 * D-11 puts no bound on the table itself — the history of a long wedding is
 * allowed to be large, and what must stay small is the DOM the operator's
 * browser is asked to build.
 */
export const PHOTOS_PER_PAGE = 50;

/** UI-SPEC copy table, verbatim, defined once and asserted against in tests. */
export const PHOTO_HISTORY_EMPTY_HEADING = 'Chưa có ảnh nào';
export const PHOTO_HISTORY_EMPTY_BODY =
  'Ảnh sẽ xuất hiện tại đây ngay khi khách đầu tiên chụp xong.';

/** UI-SPEC's destructive copy for the one deletion path in the system. */
export const CLEAR_HISTORY_ACTION = 'Xóa lịch sử ảnh';
export const CLEAR_HISTORY_CONFIRM =
  'Xóa toàn bộ lịch sử ảnh của sự kiện này? Không thể hoàn tác.';
export const CLEAR_HISTORY_MISMATCH =
  'Tên sự kiện chưa khớp — chưa có ảnh nào bị xóa. Nhập lại chính xác tên sự kiện để xác nhận.';

/**
 * UI-SPEC G4, human-answered 2026-08-12: the label on the placeholder tile that
 * replaces a thumbnail which cannot load. Visible text beside the icon, never
 * the browser's broken-image glyph and never an icon on its own.
 */
export const THUMB_MISSING_LABEL = 'Ảnh không tải được';

/** The row shape `listEventPhotos()` projects — no internal columns (T-08-29). */
export interface PhotoHistoryRow {
  jobId: string;
  photoUrl: string;
  guestName: string;
  capturedAt: number;
}

// ---------------------------------------------------------------------------
// Small renderers
// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `HH:MM · DD/MM/YYYY` in the SERVER's local time, formatted by hand rather
 * than through `toLocaleString`.
 *
 * Deliberate: `toLocaleString` renders differently depending on the ICU data
 * the host Node was built with, so the operator's timestamps would silently
 * change format on a rebuilt server, and a test asserting on them would be
 * asserting on the build. The booth, the service and the operator are in one
 * room in one timezone (PROJECT.md), so local time is the honest reading and no
 * timezone label is shown.
 */
export function formatCapturedAt(capturedAt: number): string {
  const at = new Date(capturedAt);
  return `${pad(at.getHours())}:${pad(at.getMinutes())} · ${pad(at.getDate())}/${pad(
    at.getMonth() + 1,
  )}/${at.getFullYear()}`;
}

/** One page link, as a path this page can be reached at again. */
function photoPageHref(eventId: string, pageNumber: number): string {
  return escapeHtml(`/cms/photos?event=${encodeURIComponent(eventId)}&page=${pageNumber}`);
}

/**
 * Whether a stored photo URL is one the operator's browser should be asked to
 * load at all.
 *
 * `http(s)` and this service's own root-relative paths, and nothing else. The
 * URL is recorded from the Agent's `file_upload` event and rendered into the
 * operator's browser, which is a trust boundary; `data:` and `javascript:`
 * URLs are refused rather than escaped, because the accepted set is small
 * enough to state exactly. A refusal is not an error — it renders the SAME G4
 * placeholder a dead link renders, and the row stays exactly where it is.
 */
export function isRenderableImageUrl(url: string): boolean {
  if (url.startsWith('//')) return false;
  if (url.startsWith('/')) return true;
  return /^https?:\/\/[^\s"'<>]+$/i.test(url);
}

/**
 * UI-SPEC G4: the neutral tile that stands in for a thumbnail which cannot
 * load — the admin-surface sibling of the room screen's initials avatar.
 *
 * D-10 stores a URL rather than a copy of the image, and accepts as the cost
 * that the far side may one day stop serving it. This is that accepted cost
 * rendered as a DESIGNED state: a neutral tile, the warning icon, and a
 * visible Vietnamese label. The icon is `aria-hidden` because the label beside
 * it is the accessible name.
 *
 * `hidden` when the image is at least worth attempting; visible from the
 * server when the URL is one we will not put in an `src` at all.
 */
function placeholderTile(hidden: boolean): string {
  return `<span class="thumb-missing"${hidden ? ' hidden' : ''}>${WARNING_ICON}<span class="thumb-missing-label">${THUMB_MISSING_LABEL}</span></span>`;
}

/**
 * The thumbnail cell.
 *
 * `alt=""` on purpose: the guest's name sits in the very next cell, so a
 * screen reader that also announced the image would read the same person
 * twice. The image is decoration for a row that is already labelled.
 */
function thumbnailCell(row: PhotoHistoryRow): string {
  const renderable = isRenderableImageUrl(row.photoUrl);
  const img = renderable
    ? `<img class="thumb-img" src="${escapeHtml(row.photoUrl)}" alt="" loading="lazy" width="120" height="80">`
    : '';
  return `<td class="thumb"><span class="thumb-box">
          ${img}${placeholderTile(renderable)}
        </span></td>`;
}

function photoRow(row: PhotoHistoryRow): string {
  const name = escapeHtml(row.guestName);
  return `<tr class="photo-row">
        ${thumbnailCell(row)}
        <td class="name"><span class="ellipsis" title="${name}">${name}</span></td>
        <td class="time">${escapeHtml(formatCapturedAt(row.capturedAt))}</td>
      </tr>`;
}

/**
 * The pager. Both controls carry a visible Vietnamese label — the arrows are
 * decoration beside the words, never a control on their own (UI-SPEC: no
 * icon-only control ships).
 *
 * The edges are rendered as disabled SPANS rather than omitted, so the row of
 * controls does not shift position as the operator pages through.
 */
function pager(eventId: string, pageNumber: number, totalPages: number): string {
  const previous =
    pageNumber > 1
      ? `<a class="btn secondary" href="${photoPageHref(eventId, pageNumber - 1)}">← Trang trước</a>`
      : `<span class="btn secondary" aria-disabled="true">← Trang trước</span>`;
  const next =
    pageNumber < totalPages
      ? `<a class="btn secondary" href="${photoPageHref(eventId, pageNumber + 1)}">Trang sau →</a>`
      : `<span class="btn secondary" aria-disabled="true">Trang sau →</span>`;

  return `<nav class="pager" aria-label="Phân trang lịch sử ảnh">
      ${previous}
      <span class="muted" role="status">Trang ${pageNumber} / ${totalPages}</span>
      ${next}
    </nav>`;
}

/** The event picker — a GET form, so choosing an event mutates nothing. */
function eventPicker(events: EventSummary[], selectedId: string | undefined): string {
  if (events.length === 0) {
    return `<div class="card">
    <h2>Chưa có sự kiện nào</h2>
    <p class="muted">Tạo sự kiện đầu tiên để bắt đầu — lịch sử ảnh được lưu theo từng sự kiện.</p>
    <div class="actions"><a class="btn" href="/cms/events/new">+ Tạo sự kiện mới</a></div>
  </div>`;
  }

  const options = events
    .map((event) => {
      const id = escapeHtml(event.id);
      const name = escapeHtml(event.name);
      return `<option value="${id}"${event.id === selectedId ? ' selected' : ''}>${name}</option>`;
    })
    .join('');

  return `<div class="card">
    <form method="get" action="/cms/photos">
      <label for="event">Sự kiện</label>
      <div class="actions">
        <select id="event" name="event">${options}</select>
        <button class="secondary" type="submit" data-nonmutating="filter">Xem lịch sử</button>
      </div>
    </form>
  </div>`;
}

const PHOTO_STYLES = `
    .actions{align-items:center}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;font-size:14px;font-weight:600;color:var(--text-muted);padding:var(--sp-sm) var(--sp-md);
      border-bottom:1px solid var(--border)}
    td{padding:var(--sp-sm) var(--sp-md);border-top:1px solid var(--border);vertical-align:middle}
    .photo-row{min-height:44px}
    .thumb-box{display:inline-grid;place-items:center;width:120px;height:80px;overflow:hidden;
      border-radius:6px;background:var(--bg);border:1px solid var(--border)}
    .thumb-img{max-width:100%;max-height:100%;object-fit:cover}
    /* G4: neutral, not alarming — a missing file is an accepted cost of
       storing URLs (D-10), not an incident. */
    .thumb-missing{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--sp-xs);
      width:100%;height:100%;color:var(--text-muted);text-align:center;padding:var(--sp-xs)}
    .thumb-missing[hidden]{display:none}
    .thumb-missing-label{font-size:14px;line-height:1.2}
    .name{max-width:1px;width:60%}
    .ellipsis{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .time{white-space:nowrap;color:var(--text-muted)}
    .empty{padding:var(--sp-2xl) 0;text-align:center}
    .pager{display:flex;flex-wrap:wrap;gap:var(--sp-md);align-items:center;margin-top:var(--sp-lg)}
    .pager [aria-disabled="true"]{opacity:.5}
    select{max-width:420px}
    .danger{border-top:1px solid var(--border);margin-top:var(--sp-lg);padding-top:var(--sp-lg)}
    .warn{display:flex;align-items:center;gap:var(--sp-sm);color:var(--destructive);font-size:16px;font-weight:600}
`;

/**
 * The G4 swap, in the two places a thumbnail can fail.
 *
 * Both are needed. The `error` listener is registered in the CAPTURE phase
 * because `error` on an `<img>` does not bubble, and the `load` sweep catches
 * the images that already failed before this script ran — without it, the
 * first screenful of a slow page would keep the browser's broken-image glyph,
 * which is precisely what G4 says never ships.
 *
 * The row is never removed and never hidden. A far side that dropped the file
 * has not un-photographed the guest, and this surface has exactly one way to
 * delete a row (D-11).
 */
const THUMB_FALLBACK_SCRIPT = `
  function cmsPhotoMissing(img){
    if(!img || img.dataset.missing === '1') return;
    img.dataset.missing = '1';
    img.hidden = true;
    var box = img.parentElement;
    var tile = box && box.querySelector('.thumb-missing');
    if(tile) tile.hidden = false;
  }
  document.addEventListener('error', function(e){
    var target = e.target;
    if(target && target.classList && target.classList.contains('thumb-img')) cmsPhotoMissing(target);
  }, true);
  window.addEventListener('load', function(){
    var images = document.querySelectorAll('.thumb-img');
    for(var i = 0; i < images.length; i++){
      if(images[i].complete && images[i].naturalWidth === 0) cmsPhotoMissing(images[i]);
    }
  });
`;

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * The operator's per-event photo history.
 *
 * `rows` is ALREADY the page's slice — this renderer never sees the whole
 * history and could not render an unbounded list if it wanted to. That is what
 * makes T-08-28's bound structural rather than a discipline the caller has to
 * remember.
 */
export function renderCmsPhotoHistoryPage(data: {
  events: EventSummary[];
  event?: EventSummary;
  rows: PhotoHistoryRow[];
  total: number;
  page: number;
  totalPages: number;
}): string {
  const picker = eventPicker(data.events, data.event?.id);

  let section: string;
  if (!data.event) {
    section =
      data.events.length === 0
        ? ''
        : `<div class="card">
    <div class="empty">
      <h2>Chưa chọn sự kiện</h2>
      <p class="muted">Chọn một sự kiện ở trên để xem lịch sử ảnh của sự kiện đó.</p>
    </div>
  </div>`;
  } else {
    const eventName = escapeHtml(data.event.name);
    const eventId = data.event.id;

    let body: string;
    if (data.total === 0) {
      // The UI-SPEC empty state, and no table to be blank.
      body = `<div class="empty">
      <h2>${PHOTO_HISTORY_EMPTY_HEADING}</h2>
      <p class="muted">${PHOTO_HISTORY_EMPTY_BODY}</p>
    </div>`;
    } else if (data.rows.length === 0) {
      // A page past the end — an empty RESULT, not an error, and not the empty
      // state either: telling an operator with 120 photos that they have none
      // would be a plain lie about their own event.
      body = `<div class="empty">
      <h2>Không còn ảnh ở trang này</h2>
      <p class="muted">Lịch sử ảnh của sự kiện này chỉ có ${data.totalPages} trang.</p>
      <div class="actions" style="justify-content:center">
        <a class="btn secondary" href="${photoPageHref(eventId, 1)}">Trang 1</a>
      </div>
    </div>`;
    } else {
      body = `<table>
      <thead><tr><th scope="col">Ảnh</th><th scope="col">Khách</th><th scope="col">Thời gian chụp</th></tr></thead>
      <tbody>${data.rows.map(photoRow).join('')}</tbody>
    </table>
    ${pager(eventId, data.page, data.totalPages)}`;
    }

    // The clear control is a LINK to the confirmation, not a button that
    // deletes: the destructive step and the click that reaches it are
    // deliberately two different actions, the same shape event deletion takes.
    section = `<div class="card">
    <h2>${eventName}</h2>
    <p class="muted">Tổng cộng ${data.total} ảnh trong lịch sử của sự kiện này.</p>
    ${body}
    <div class="danger actions">
      <a class="btn destructive" href="${escapeHtml(
        `/cms/photos/clear?event=${encodeURIComponent(eventId)}`,
      )}">${CLEAR_HISTORY_ACTION}</a>
      <span class="muted">Ảnh đã gửi cho khách không bị ảnh hưởng — chỉ danh sách trong CMS bị xóa.</span>
    </div>
  </div>`;
  }

  const body = `<main>
  <header>
    <h1>Lịch sử ảnh</h1>
    <div class="actions">
      <a class="btn secondary" href="/cms/events">Quay lại danh sách sự kiện</a>
      ${LOGOUT_FORM}
    </div>
  </header>
  ${picker}
  ${section}
</main>`;

  return page('Lịch sử ảnh', PHOTO_STYLES, body, THUMB_FALLBACK_SCRIPT);
}

// ---------------------------------------------------------------------------
// The one deletion path's confirmation (D-11)
// ---------------------------------------------------------------------------

/**
 * The typed destructive confirmation for clearing one event's photo history.
 *
 * The operator retypes the event's name — the same control plan 08-03
 * established for deleting an event, and for the same reason: clearing the
 * wrong wedding's history should require a mistake about its NAME, not a
 * mis-click. The comparison happens on the SERVER (see the route); this page
 * is where the operator is asked, not where the answer is enforced.
 *
 * `error` re-renders this same view after a mismatch, so a wrong answer costs
 * the operator a retype and never a row.
 */
export function renderCmsClearHistoryConfirmPage(data: {
  event: EventSummary;
  photoCount: number;
  error?: boolean;
}): string {
  const name = escapeHtml(data.event.name);
  const id = escapeHtml(data.event.id);
  const backHref = escapeHtml(`/cms/photos?event=${encodeURIComponent(data.event.id)}`);

  const body = `<main>
  <header>
    <h1>${CLEAR_HISTORY_ACTION}</h1>
    <div class="actions">
      <a class="btn secondary" href="${backHref}">Quay lại lịch sử ảnh</a>
      ${LOGOUT_FORM}
    </div>
  </header>
  <div class="card">
    <p class="warn">${WARNING_ICON}<span>${CLEAR_HISTORY_CONFIRM}</span></p>
    <p class="muted">Sự kiện “${name}” đang có ${data.photoCount} ảnh trong lịch sử.
      Ảnh đã gửi cho khách không bị ảnh hưởng — chỉ danh sách trong CMS bị xóa.</p>
    <p class="error" id="clearError" role="alert"${data.error ? '' : ' hidden'}>${CLEAR_HISTORY_MISMATCH}</p>
    <form id="clearForm" data-event-id="${id}">
      <div class="field">
        <label for="confirmName">Nhập lại tên sự kiện để xác nhận</label>
        <input id="confirmName" name="confirmName" type="text" maxlength="60" autocomplete="off">
      </div>
      <div class="actions">
        <button type="submit" class="destructive" id="clearBtn" data-mutating
          data-inflight-label="Đang xóa…">${CLEAR_HISTORY_ACTION}</button>
        <a class="btn secondary" href="${backHref}">Hủy</a>
      </div>
    </form>
  </div>
</main>`;

  const script = `
  var form = document.querySelector('#clearForm');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var button = document.querySelector('#clearBtn');
    if (!cmsBusy(button)) return;
    var ok = false;
    try {
      var res = await fetch('/cms/api/photos/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The typed confirmation travels to the SERVER, which is what enforces
        // it. A dialog the browser could skip is not a control.
        body: JSON.stringify({ eventId: form.dataset.eventId, confirmName: document.querySelector('#confirmName').value })
      });
      ok = res.ok;
    } catch (err) { ok = false; }
    if (ok) { location.href = ${jsonForScript(`/cms/photos?event=${data.event.id}`)}; return; }
    cmsRelease(button);
    document.querySelector('#clearError').hidden = false;
  });
`;

  return page(CLEAR_HISTORY_ACTION, PHOTO_STYLES, body, script);
}
