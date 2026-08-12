import { escapeHtml } from './cmsPages';
import { page, LOGOUT_FORM, SAVE_ERROR } from './cmsEventPages';
import { LOG_LEVELS } from '../logging/logger';
import { READ_ONLY_AGENT_CONFIG_FIELDS } from '../agent/agentConfigContract';

/**
 * The CMS Agent-configuration page (UI-02).
 *
 * The chrome, the design tokens and the ONE in-flight implementation come from
 * `cmsEventPages.ts` by import rather than by a second copy — G1's promise is
 * that no mutating control anywhere in the console can be double-submitted, and
 * a duplicated handler is a second place for that to quietly stop being true.
 */

// ---------------------------------------------------------------------------
// Copy (08-UI-SPEC's fixed CMS system copy, verbatim where it pins a string)
// ---------------------------------------------------------------------------

export const AGENT_TEST_SUCCESS = 'Kết nối Agent thành công';
export const AGENT_TEST_FAILURE = 'Không kết nối được Agent — kiểm tra lại thông tin.';

/**
 * UI-SPEC pins "Đã lưu cấu hình sự kiện" for the EVENT save. This page saves
 * the Agent's configuration, not an event's, so the noun is corrected rather
 * than copied — telling an operator they saved an event when they saved the
 * booth's API port is worse than deviating from the table by one word.
 */
export const AGENT_SAVE_SUCCESS = 'Đã lưu cấu hình Agent';

/** The save error string is shared with the event form, deliberately. */
export const AGENT_SAVE_ERROR = SAVE_ERROR;

/**
 * An offline Agent is NOT a failed save. The database is the source of truth
 * and the Agent pulls its configuration on connect (D-17), so the only honest
 * thing to report is "saved, and it will be picked up".
 */
export const AGENT_OFFLINE_NOTICE =
  'Đã lưu cấu hình. Agent đang ngoại tuyến — máy booth sẽ nhận cấu hình mới ngay khi kết nối lại.';

export const AGENT_NO_PREVIOUS = 'Không có cấu hình trước đó để khôi phục.';
export const AGENT_RESTORE_SUCCESS = 'Đã khôi phục cấu hình trước đó';

/**
 * D-16's physical step, stated rather than hidden. These four fields create (or
 * hold open) the link a configuration change travels over; a wrong value costs
 * a trip to the booth, so the page explains the trip instead of offering a
 * control that could cause it.
 */
export const AGENT_MANUAL_EDIT_NOTE =
  'Chỉ sửa trực tiếp trên máy booth (tệp .env). Không sửa được từ xa — nếu sai, Agent sẽ không kết nối lại được và phải đến tận nơi.';

export const AGENT_PASSWORD_SET = 'Đã có mật khẩu — để trống nếu không đổi.';
export const AGENT_PASSWORD_UNSET = 'Chưa đặt mật khẩu.';

const READ_ONLY_LABELS: Record<string, string> = {
  extensionServiceWsUrl: 'Địa chỉ Extension Service (WebSocket)',
  extensionServiceWsToken: 'Mã kết nối Extension Service',
  triggerServerPort: 'Cổng nhận sự kiện từ dslrBooth',
  logDir: 'Thư mục lưu nhật ký',
};

const LOG_LEVEL_LABELS: Record<string, string> = {
  error: 'error — chỉ lỗi',
  warn: 'warn — lỗi và cảnh báo',
  info: 'info — mặc định',
  http: 'http',
  verbose: 'verbose',
  debug: 'debug — chi tiết, dùng khi cần dò lỗi',
  silly: 'silly — mọi thứ',
};

export interface CmsAgentPageData {
  logLevel: string;
  autoOpenDisplay: boolean;
  dslrBoothApiPort: number | null;
  passwordSet: boolean;
  agentOnline: boolean;
}

/**
 * The page.
 *
 * Note what is NOT here: the stored dslrBooth password. It is never rendered
 * back, not even into a `value` attribute the browser would mask — an HTML
 * response is a file the operator's browser caches, a screen a phone can
 * photograph, and a body a proxy can log (T-08-22). The field renders empty
 * with a set/unset indicator, and an empty submission means "leave unchanged".
 */
export function renderCmsAgentConfigPage(data: CmsAgentPageData): string {
  const levelOptions = LOG_LEVELS.map(
    (level) =>
      `<option value="${level}"${data.logLevel === level ? ' selected' : ''}>${escapeHtml(LOG_LEVEL_LABELS[level] ?? level)}</option>`,
  ).join('');

  const readOnlyRows = READ_ONLY_AGENT_CONFIG_FIELDS.map(
    (field) => `<div class="field">
        <label for="${field}">${escapeHtml(READ_ONLY_LABELS[field] ?? field)}</label>
        <input type="text" id="${field}" name="${field}" value="" readonly disabled
          placeholder="Chỉ có trên máy booth">
      </div>`,
  ).join('');

  const status = data.agentOnline
    ? '<span class="online">● Agent đang kết nối</span>'
    : '<span class="offline">● Agent mất kết nối</span>';

  const body = `<main>
  <header>
    <h1>Cấu hình Agent</h1>
    ${LOGOUT_FORM}
  </header>
  <div class="card">
    <div class="actions" style="margin-bottom:var(--sp-lg)">
      <a class="btn secondary" href="/cms/events">Quay lại danh sách sự kiện</a>
      ${status}
    </div>
    <p class="ok" id="saveOk" role="status" hidden></p>
    <p class="error" id="saveError" role="alert" hidden></p>
    <form id="agentForm">
      <h2>Cài đặt sửa được từ xa</h2>
      <p class="muted">Lưu xong, máy booth sẽ nhận cài đặt mới ngay, không cần khởi động lại Agent.</p>
      <div class="field">
        <label for="logLevel">Mức ghi nhật ký</label>
        <select id="logLevel" name="logLevel">${levelOptions}</select>
      </div>
      <div class="field">
        <label for="autoOpenDisplay">Tự mở màn hình khách khi có lượt mới</label>
        <select id="autoOpenDisplay" name="autoOpenDisplay">
          <option value="true"${data.autoOpenDisplay ? ' selected' : ''}>Bật</option>
          <option value="false"${data.autoOpenDisplay ? '' : ' selected'}>Tắt</option>
        </select>
      </div>
      <div class="field">
        <label for="dslrBoothApiPort">Cổng dslrBooth Local API</label>
        <input type="number" id="dslrBoothApiPort" name="dslrBoothApiPort" min="1" max="65535"
          value="${data.dslrBoothApiPort === null ? '' : String(data.dslrBoothApiPort)}">
      </div>
      <div class="field">
        <label for="dslrBoothPassword">Mật khẩu dslrBooth Local API</label>
        <input type="password" id="dslrBoothPassword" name="dslrBoothPassword" value=""
          autocomplete="new-password">
        <p class="muted">${data.passwordSet ? AGENT_PASSWORD_SET : AGENT_PASSWORD_UNSET}</p>
      </div>
      <div class="actions">
        <button type="submit" id="saveBtn" data-mutating data-inflight-label="Đang lưu…">Lưu cấu hình</button>
        <button type="button" class="secondary" id="testBtn" data-mutating data-inflight-label="Đang kiểm tra…">Kiểm tra kết nối</button>
        <button type="button" class="secondary" id="restoreBtn" data-mutating data-inflight-label="Đang khôi phục…">Khôi phục cấu hình trước</button>
      </div>
      <p class="muted" id="testState" role="status"></p>
    </form>
  </div>
  <div class="card">
    <h2>Chỉ sửa trên máy booth</h2>
    <p class="muted">${AGENT_MANUAL_EDIT_NOTE}</p>
    ${readOnlyRows}
  </div>
</main>`;

  const styles = `
    .online{color:#1d6b4f;font-weight:600}
    .offline{color:var(--destructive);font-weight:600}
    input[type=password]{width:100%;min-height:44px;padding:var(--sp-sm) var(--sp-md);
      font-size:16px;font-family:inherit;border:1px solid var(--border);border-radius:6px;
      background:var(--surface);color:var(--text)}
    input[disabled]{background:var(--bg);color:var(--text-muted)}
`;

  // Both outcome strings ship in the page so the connection test renders its
  // result without a second round trip — and so a test can read them here.
  const script = `
  var form = document.querySelector('#agentForm');
  var okBox = document.querySelector('#saveOk');
  var errBox = document.querySelector('#saveError');
  var TEST_OK = ${JSON.stringify(AGENT_TEST_SUCCESS)};
  var TEST_FAIL = ${JSON.stringify(AGENT_TEST_FAILURE)};

  function collect(){
    var payload = {};
    form.querySelectorAll('[name]').forEach(function(input){
      if (input.disabled) return;
      if (input.name === 'dslrBoothApiPort') {
        if (input.value !== '') payload[input.name] = Number(input.value);
      } else if (input.name === 'autoOpenDisplay') {
        payload[input.name] = input.value === 'true';
      } else if (input.name === 'dslrBoothPassword') {
        if (input.value !== '') payload[input.name] = input.value;
      } else {
        payload[input.name] = input.value;
      }
    });
    return payload;
  }

  function report(ok, message){
    okBox.hidden = true; errBox.hidden = true;
    var box = ok ? okBox : errBox;
    box.textContent = message;
    box.hidden = false;
  }

  async function post(url, button, body){
    if (!cmsBusy(button)) return;
    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      var payload = await res.json().catch(function(){ return {}; });
      report(res.ok, payload.message || payload.error || ${JSON.stringify(AGENT_SAVE_ERROR)});
      if (res.ok) setTimeout(function(){ location.reload(); }, 600);
    } catch (err) {
      report(false, ${JSON.stringify(AGENT_SAVE_ERROR)});
    }
    cmsRelease(button);
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    post('/cms/api/agent', document.querySelector('#saveBtn'), collect());
  });

  document.querySelector('#restoreBtn').addEventListener('click', function(){
    post('/cms/api/agent/restore', document.querySelector('#restoreBtn'), {});
  });

  document.querySelector('#testBtn').addEventListener('click', async function(){
    var button = document.querySelector('#testBtn');
    if (!cmsBusy(button)) return;
    var message = TEST_FAIL;
    try {
      var res = await fetch('/cms/api/agent/test', { method: 'POST' });
      var payload = await res.json();
      message = payload.online ? TEST_OK : TEST_FAIL;
    } catch (err) { message = TEST_FAIL; }
    document.querySelector('#testState').textContent = message;
    cmsRelease(button);
  });
`;

  return page('Cấu hình Agent', styles, body, script);
}
