import { escapeHtml } from './cmsPages';
import { page, LOGOUT_FORM } from './cmsEventPages';

/**
 * The CMS booth-release page (D11-08).
 *
 * The chrome, the design tokens and the ONE in-flight implementation come
 * from `cmsEventPages.ts` by import rather than by a second copy — same
 * discipline `cmsAgentPages.ts` follows, for the same reason: G1's promise
 * is that no mutating control anywhere in the console can be
 * double-submitted, and a duplicated handler is a second place for that to
 * quietly stop being true.
 */

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const BOOTH_RELEASE_BUTTON = 'Kết thúc khách này';

export const BOOTH_RELEASE_SUCCESS = 'Đã kết thúc lượt khách này';

/** The all-or-nothing body refusal (T-11-12). */
export const BOOTH_RELEASE_INVALID = 'Yêu cầu không hợp lệ — vui lòng tải lại trang.';

/**
 * The race where the job id the page rendered no longer owns the booth by
 * the time the operator clicked — someone else's session started, or a
 * retake was already under way. Distinct wording from the already-finished
 * case below so an operator staring at two refusals in the log can tell
 * them apart.
 */
export const BOOTH_RELEASE_WRONG_JOB = 'Khách này không còn ở booth — trang sẽ tự làm mới.';

/**
 * The race where the job DID own the booth but finalized (printing or
 * grace) in the gap between render and click. Nothing was double-sent —
 * that is exactly what this refusal, rather than a silent success, proves.
 */
export const BOOTH_RELEASE_ALREADY_FINISHED = 'Lượt khách này đã kết thúc trước đó.';

export const BOOTH_NO_GUEST_HEADING = 'Không có khách nào đang ở booth';
export const BOOTH_NO_GUEST_BODY = 'Trang sẽ tự làm mới khi có khách mới.';

export interface CmsBoothPageData {
  jobId: string;
  guestName: string;
  waitingSinceMs: number;
}

/**
 * How often the page reloads itself, in seconds. A full page reload —
 * driven by the browser, not a client-side timer — is what keeps the
 * elapsed time honest: the value is recomputed server-side on every render
 * from a durable timestamp, the same reasoning DisplayServer's own
 * `justCaptured` projection is built on (D-09/D-10). No script advances
 * this number; the flagged assumption in 11-03-PLAN.md accepts up to one
 * refresh interval of staleness, which cannot affect correctness because
 * the release POST carries the job id and the server re-checks it.
 */
const REFRESH_SECONDS = 5;

/**
 * The page. Two states only — no guest, or a guest with their given name,
 * their elapsed time in whole seconds, and one form posting the job id.
 * No other guest contact detail is ever rendered: `stall.guestName` is
 * already the given-name projection by the time it reaches this function.
 */
export function renderCmsBoothPage(stall: CmsBoothPageData | null): string {
  const refreshTag = `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`;

  const content = stall
    ? (() => {
        const seconds = Math.max(0, Math.round(stall.waitingSinceMs / 1000));
        return `<main>
  <header>
    <h1>Kết thúc lượt khách</h1>
    ${LOGOUT_FORM}
  </header>
  <div class="card">
    <div class="actions" style="margin-bottom:var(--sp-lg)">
      <a class="btn secondary" href="/cms/events">Quay lại danh sách sự kiện</a>
    </div>
    <h2>${escapeHtml(stall.guestName)}</h2>
    <p class="muted">Đã ở booth ${seconds} giây</p>
    <p class="ok" id="releaseOk" role="status" hidden></p>
    <p class="error" id="releaseError" role="alert" hidden></p>
    <form id="releaseForm">
      <input type="hidden" id="jobId" value="${escapeHtml(stall.jobId)}">
      <div class="actions">
        <button type="submit" id="releaseBtn" class="destructive" data-mutating
          data-inflight-label="Đang kết thúc…">${escapeHtml(BOOTH_RELEASE_BUTTON)}</button>
      </div>
    </form>
  </div>
</main>`;
      })()
    : `<main>
  <header>
    <h1>Kết thúc lượt khách</h1>
    ${LOGOUT_FORM}
  </header>
  <div class="card">
    <div class="actions" style="margin-bottom:var(--sp-lg)">
      <a class="btn secondary" href="/cms/events">Quay lại danh sách sự kiện</a>
    </div>
    <h2>${BOOTH_NO_GUEST_HEADING}</h2>
    <p class="muted">${BOOTH_NO_GUEST_BODY}</p>
  </div>
</main>`;

  const body = refreshTag + content;

  // Only the guest state carries a submit handler — the no-guest state has
  // no form to wire up. Follows `cmsAgentPages.ts`'s own collect/post shape,
  // using the shared cmsBusy/cmsRelease/cmsHandleAuth the page() chrome
  // already provides so this one control is not a second implementation of
  // G1's in-flight rule.
  const script = stall
    ? `
  var form = document.querySelector('#releaseForm');
  var okBox = document.querySelector('#releaseOk');
  var errBox = document.querySelector('#releaseError');

  function report(ok, message){
    okBox.hidden = true; errBox.hidden = true;
    var box = ok ? okBox : errBox;
    box.textContent = message;
    box.hidden = false;
  }

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var button = document.querySelector('#releaseBtn');
    if (!cmsBusy(button)) return;
    try {
      var res = await fetch('/cms/api/booth/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: document.querySelector('#jobId').value })
      });
      var payload = await res.json().catch(function(){ return {}; });
      if (cmsHandleAuth(res)) return;
      report(res.ok, payload.message || payload.error || ${JSON.stringify(BOOTH_RELEASE_INVALID)});
      if (res.ok) setTimeout(function(){ location.reload(); }, 600);
    } catch (err) {
      report(false, ${JSON.stringify(BOOTH_RELEASE_INVALID)});
    }
    cmsRelease(button);
  });
`
    : '';

  return page('Kết thúc lượt khách', '', body, script);
}
