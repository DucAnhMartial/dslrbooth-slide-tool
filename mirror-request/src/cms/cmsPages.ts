import type { EventSummary } from '../state/localStore';

/**
 * The CMS Console's server-rendered pages, in `displayPage.ts`'s inline
 * template-string idiom — no framework, no bundler, no build step beyond
 * `tsc` (08-UI-SPEC: a locked decision, not a gap to fill with React).
 *
 * Design tokens below are the UI-SPEC's CMS Console contract, not the Room
 * Screen's: the operator's tool is a light admin surface and is NOT
 * event-themeable. Type scale is 14/16/20/28px at weights 400/600 only, and
 * every interactive control is at least 44px tall (the "operator mid-event
 * under pressure, possibly on a touchscreen laptop" persona — a missed tap
 * during a live event is the failure mode that minimum exists to prevent).
 */

/**
 * The single escaping point for operator-supplied text.
 *
 * Event names come from a form field and are rendered back into HTML, which
 * is a stored-XSS path if interpolated raw. Escaping happens HERE, at render,
 * rather than at write: the stored value stays exactly what the operator
 * typed (so it can be edited, exported, or rendered into a non-HTML context
 * later without double-escaping), and every HTML sink in this file is forced
 * through this one function.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialises a value for interpolation INSIDE an inline `<script>` block.
 *
 * `escapeHtml` is the wrong tool here and `JSON.stringify` alone is not
 * enough. `<script>` is a raw text element: the HTML parser does not decode
 * entities inside it, so `&quot;` would ship literally and break the script —
 * but it DOES scan for `</script`, and it wins that race against JavaScript's
 * own string quoting. `JSON.stringify` escapes quotes and backslashes and
 * leaves `<` and `/` alone, so a value containing `</script>` closes the
 * element from inside what the author believed was a string literal.
 *
 * The replacement text is a valid JS escape that evaluates back to the same
 * character, so the value the script sees is unchanged — while being nothing
 * at all to the HTML parser. That asymmetry is the whole mechanism.
 *
 * U+2028 and U+2029 are escaped for a different reason: they are literal line
 * terminators in JavaScript but legal raw characters in JSON, so an unescaped
 * one is a syntax error rather than a vulnerability. Both the pattern and the
 * replacement are written as escapes deliberately — as raw characters they
 * are invisible in every editor, and a maintainer cannot review what they
 * cannot see.
 *
 * Phase 8 code review, WR-08.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const CMS_STYLES = `
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
    .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:var(--sp-lg)}
    input[type=text],input[type=password]{width:100%;min-height:44px;padding:var(--sp-sm) var(--sp-md);
      font-size:16px;font-family:inherit;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)}
    input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    button{min-height:44px;padding:var(--sp-sm) var(--sp-lg);font-size:16px;font-weight:600;font-family:inherit;
      border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
    button[disabled]{opacity:.6;cursor:progress}
    button.secondary{background:var(--surface);color:var(--text);border:1px solid var(--border)}
    .muted{color:var(--text-muted)}
    .error{color:var(--destructive);font-size:16px;margin:0 0 var(--sp-md)}
`;

/**
 * The login page. `error` renders the UI-SPEC's single login-failure string —
 * the SAME string for an unknown username and for a wrong password, so the
 * response can never be used to confirm which operator accounts exist
 * (T-08-01).
 */
export function renderCmsLoginPage(opts: { error?: string; next?: string } = {}): string {
  const error = opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : '';
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Đăng nhập — Bảng điều khiển</title>
  <style>${CMS_STYLES}
    main{min-height:100vh;display:grid;place-items:center;padding:var(--sp-xl)}
    .card{width:100%;max-width:380px}
    .field{margin-bottom:var(--sp-md)}
  </style>
</head>
<body>
<main>
  <form class="card" method="post" action="/cms/login" id="loginForm">
    ${opts.next ? `<input type="hidden" name="next" value="${escapeHtml(opts.next)}">` : ''}
    <h1>Đăng nhập</h1>
    ${error}
    <div class="field">
      <label for="username">Tên đăng nhập</label>
      <input id="username" name="username" type="text" autocomplete="username" required>
    </div>
    <div class="field">
      <label for="password">Mật khẩu</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    <button type="submit" id="submit">Đăng nhập</button>
  </form>
</main>
<script>
  // UI-SPEC G1: every mutating control disables itself while in flight, so a
  // double-click cannot fire two writes. Progressive enhancement only — the
  // form posts and works with scripting disabled.
  document.querySelector('#loginForm').addEventListener('submit',function(){
    var b=document.querySelector('#submit');b.disabled=true;b.textContent='Đang đăng nhập…';
  });
</script>
</body></html>`;
}

/**
 * The dashboard: the event library plus the create/activate controls.
 *
 * Per UI-SPEC every icon would need a visible Vietnamese label beside it, so
 * this page ships text-labelled controls and no icons at all — the simplest
 * way to satisfy "no icon-only control ships".
 */
export function renderCmsDashboardPage(data: {
  events: EventSummary[];
  activeEventId?: string;
}): string {
  const rows = data.events.length
    ? data.events
        .map((event) => {
          const isActive = event.id === data.activeEventId;
          const name = escapeHtml(event.name);
          return `<li class="row">
        <span class="name" title="${name}">${name}</span>
        <span class="badge">${isActive ? 'Đang phát' : ''}</span>
        <button class="secondary activate" data-id="${escapeHtml(event.id)}" ${isActive ? 'disabled' : ''}>Kích hoạt</button>
      </li>`;
        })
        .join('')
    : `<li class="empty">
        <h2>Chưa có sự kiện nào</h2>
        <p class="muted">Tạo sự kiện đầu tiên để bắt đầu cấu hình màn hình phòng.</p>
      </li>`;

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bảng điều khiển sự kiện</title>
  <style>${CMS_STYLES}
    main{max-width:900px;margin:0 auto;padding:var(--sp-xl)}
    header{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-md);margin-bottom:var(--sp-lg)}
    ul{list-style:none;padding:0;margin:0;max-height:60vh;overflow-y:auto}
    .row{display:grid;grid-template-columns:1fr auto auto;gap:var(--sp-md);align-items:center;
      min-height:44px;padding:var(--sp-md) 0;border-top:1px solid var(--border)}
    .row:first-child{border-top:0}
    .name{font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .badge{color:var(--accent);font-weight:600}
    .empty{padding:var(--sp-2xl) 0;text-align:center}
    .create{display:flex;gap:var(--sp-md);margin-bottom:var(--sp-lg)}
    .create input{flex:1}
  </style>
</head>
<body>
<main>
  <header>
    <h1>Bảng điều khiển sự kiện</h1>
    <form method="post" action="/cms/logout"><button class="secondary" type="submit">Đăng xuất</button></form>
  </header>
  <div class="card">
    <form class="create" id="createForm">
      <label class="sr-only" for="newName" hidden>Tên sự kiện</label>
      <input id="newName" type="text" maxlength="80" placeholder="Tên sự kiện" required>
      <button type="submit" id="createBtn">+ Tạo sự kiện mới</button>
    </form>
    <ul id="eventList">${rows}</ul>
  </div>
</main>
<script>
  // Both controls below are mutating, so both take the shared in-flight
  // disable (UI-SPEC G1) and both reload on success — the server re-renders
  // the list rather than this page maintaining its own copy of the state.
  function inFlight(button,label){button.disabled=true;button.dataset.prev=button.textContent;button.textContent=label}
  document.querySelector('#createForm').addEventListener('submit',async function(e){
    e.preventDefault();
    var input=document.querySelector('#newName'),button=document.querySelector('#createBtn');
    if(!input.value.trim())return;
    inFlight(button,'Đang tạo…');
    var res=await fetch('/cms/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:input.value})});
    if(res.ok){location.reload()}else{button.disabled=false;button.textContent=button.dataset.prev;alert('Không lưu được cấu hình — vui lòng thử lại. Nếu vẫn lỗi, liên hệ kỹ thuật.')}
  });
  document.querySelector('#eventList').addEventListener('click',async function(e){
    var button=e.target.closest('.activate');if(!button)return;
    inFlight(button,'Đang kích hoạt…');
    var res=await fetch('/cms/api/events/'+encodeURIComponent(button.dataset.id)+'/activate',{method:'POST'});
    if(res.ok){location.reload()}else{button.disabled=false;button.textContent=button.dataset.prev;alert('Không lưu được cấu hình — vui lòng thử lại. Nếu vẫn lỗi, liên hệ kỹ thuật.')}
  });
</script>
</body></html>`;
}
