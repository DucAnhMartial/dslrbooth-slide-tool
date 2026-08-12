import { escapeHtml } from './cmsPages';
import { page, LOGOUT_FORM } from './cmsEventPages';
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
 * The thumbnail cell.
 *
 * `alt=""` on purpose: the guest's name sits in the very next cell, so a
 * screen reader that also announced the image would read the same person
 * twice. The image is decoration for a row that is already labelled.
 */
function thumbnailCell(row: PhotoHistoryRow): string {
  return `<td class="thumb"><span class="thumb-box">
          <img class="thumb-img" src="${escapeHtml(row.photoUrl)}" alt="" loading="lazy" width="120" height="80">
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
    .name{max-width:1px;width:60%}
    .ellipsis{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .time{white-space:nowrap;color:var(--text-muted)}
    .empty{padding:var(--sp-2xl) 0;text-align:center}
    .pager{display:flex;flex-wrap:wrap;gap:var(--sp-md);align-items:center;margin-top:var(--sp-lg)}
    .pager [aria-disabled="true"]{opacity:.5}
    select{max-width:420px}
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

    section = `<div class="card">
    <h2>${eventName}</h2>
    <p class="muted">Tổng cộng ${data.total} ảnh trong lịch sử của sự kiện này.</p>
    ${body}
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

  return page('Lịch sử ảnh', PHOTO_STYLES, body, '');
}
