'use strict'

// The operator surface (plan 10-02's tracer, plan 10-03's polish, import,
// status/log pane and tray). Every value written into the document below
// goes through `textContent`/`.value`, never `innerHTML`, so nothing here can
// turn a stored string — or a log line, or a legacy `.env` path — into markup.

const FIELDS = [
  'extensionServiceWsUrl',
  'dslrBoothApiPort',
  'triggerServerPort',
  'logLevel',
  'logDir',
  'autoOpenDisplay',
]
// UAT-06: the four fields the Extension Service may push down (D-16's safe
// set). Editing one here works immediately -- and is then overwritten the next
// time the relay connects and pulls configuration, because the CMS is the
// source of truth for these four and the Agent asks it on every connect.
// Found on the first booth PC: the operator unticked the display option, saved
// it, watched config.json hold `false`, and still saw the guest window open --
// the stored CMS row said `true` and won, silently, exactly as designed.
//
// Nothing about that boundary changes here (D-16 and D-17 are locked, and a
// local edit staying possible is the deliberate recovery path for a booth that
// cannot reach the CMS). What changes is that the window stops implying
// otherwise.
//
// Mirrors SAFE_AGENT_CONFIG_FIELDS in src/liveConfig.ts. Kept as a literal
// because the renderer is plain browser JS with no bundler and cannot import
// it; test/electron-cms-managed-fields.test.ts asserts the two lists are equal,
// so they cannot drift.
const CMS_MANAGED_FIELDS = ['logLevel', 'autoOpenDisplay', 'dslrBoothApiPort', 'dslrBoothPassword']
const CMS_MANAGED_NOTICE =
  'Managed from the CMS. A change here applies now, but the Extension Service overwrites it the next time the relay connects — change it in /cms/agent to make it stick.'

const SECRET_FIELDS = ['extensionServiceWsToken', 'dslrBoothPassword']
const SECRET_PRESENCE_KEY = {
  extensionServiceWsToken: 'hasExtensionServiceWsToken',
  dslrBoothPassword: 'hasDslrBoothPassword',
}

function byId(id) {
  return document.getElementById(id)
}

function clearFieldErrors() {
  for (const field of [...FIELDS, ...SECRET_FIELDS]) {
    const el = byId('error-' + field)
    if (el) el.textContent = ''
  }
  byId('save-error').textContent = ''
}

/**
 * UAT-06: writes the CMS-managed notice under each of the four safe fields,
 * and the effective-log-path notice under logDir. Creates the paragraph if the
 * markup has none, so adding a field to the list needs no HTML change.
 * Text only -- never markup (T-10-19).
 */
function renderFieldNotices(effectiveLogDir) {
  const notices = CMS_MANAGED_FIELDS.map((field) => [field, CMS_MANAGED_NOTICE])
  notices.push([
    'logDir',
    'The desktop app always writes its log beside its own settings' +
      (effectiveLogDir ? ' (' + effectiveLogDir + ')' : '') +
      '. This value is used by the CLI and Windows-service builds, not by this window.',
  ])

  for (const [field, text] of notices) {
    const input = byId(field)
    if (!input) continue
    let hint = byId('notice-' + field)
    if (!hint) {
      hint = document.createElement('p')
      hint.className = 'field-notice'
      hint.id = 'notice-' + field
      const anchor = input.closest('.field') || input.parentElement
      if (!anchor) continue
      anchor.appendChild(hint)
    }
    hint.textContent = text
  }
}

function showFieldErrors(errors) {
  clearFieldErrors()
  const generic = []
  for (const [key, message] of Object.entries(errors || {})) {
    const el = byId('error-' + key)
    if (el) {
      el.textContent = message
    } else {
      generic.push(message)
    }
  }
  if (generic.length > 0) byId('save-error').textContent = generic.join(' ')
}

// UAT-01: a field-error map read by an operator, not JSON.stringify's braces
// and quotes. "extensionServiceWsToken: is required" beats
// {"extensionServiceWsToken":"is required"} at 2am at an event.
function formatStartError(result) {
  if (result && result.error) return result.error
  if (result && result.errors) {
    const parts = Object.entries(result.errors).map(([field, message]) => field + ': ' + message)
    if (parts.length > 0) return 'Could not start — ' + parts.join('; ')
  }
  return 'Could not start.'
}

function renderImportOffer(snapshot) {
  const panel = byId('import-panel')
  if (!panel) return
  if (snapshot.isFirstRun && snapshot.legacyEnvPath) {
    byId('legacy-path').textContent = snapshot.legacyEnvPath
    panel.hidden = false
  } else {
    panel.hidden = true
  }
}

async function loadConfigIntoForm() {
  const snapshot = await window.agentDesktop.getConfig()
  for (const field of FIELDS) {
    const el = byId(field)
    if (!el) continue
    if (el.type === 'checkbox') {
      el.checked = Boolean(snapshot[field])
    } else {
      el.value = snapshot[field] == null ? '' : String(snapshot[field])
    }
  }
  for (const field of SECRET_FIELDS) {
    const el = byId(field)
    if (!el) continue
    el.value = ''
    const present = Boolean(snapshot[SECRET_PRESENCE_KEY[field]])
    el.placeholder = present
      ? 'Stored — leave blank to keep it'
      : 'Required'
    const hint = byId('hint-' + field)
    if (hint) hint.textContent = present ? 'Currently set.' : 'Not set.'
  }
  renderImportOffer(snapshot)
  return snapshot
}

function formatTimestamp(value) {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':')
}

// UAT-01: a failed start() has no home in the status snapshot -- when the
// configuration is refused the Agent is never constructed, so `lastError` is
// empty and the message the click handler just wrote was erased by the very
// next renderStatus(), in the same tick. Hold it here instead, and let the
// real status win whenever it has something to say.
let pendingStartError = ''

function renderStatus(status) {
  if (!status) return
  byId('status-running').textContent = status.running ? 'running' : 'stopped'
  byId('status-socket').textContent = status.socketState
  byId('status-trigger-port').textContent = status.triggerPort == null ? '-' : String(status.triggerPort)
  byId('status-dslrbooth').textContent = status.dslrBoothReachable
  byId('status-last-event').textContent = formatTimestamp(status.lastEventAt)
  byId('status-uptime').textContent =
    status.running && status.startedAt ? formatDuration(Date.now() - status.startedAt) : '-'
  byId('status-last-error').textContent = status.lastError || pendingStartError || '-'
}

async function refreshStatus() {
  renderStatus(await window.agentDesktop.getStatus())
}

// The DOM-side log pane cap (T-10-20): an unbounded node list in a window
// left open for a whole event is a slow leak nobody would attribute to the
// log pane. Matches the retained-buffer cap `logTail.ts` applies on the main
// side, applied again here to the DOM itself.
const LOG_LINE_CAP = 500
const logLineNodePairs = []

function appendLogLine(line) {
  const pre = byId('log-lines')
  if (!pre) return
  // Text nodes only (T-10-19): a log line that happens to contain markup
  // (e.g. from a guest name) can never become markup on this page.
  const lineNode = document.createTextNode(line)
  const breakNode = document.createTextNode('\n')
  pre.appendChild(lineNode)
  pre.appendChild(breakNode)
  logLineNodePairs.push([lineNode, breakNode])
  if (logLineNodePairs.length > LOG_LINE_CAP) {
    const [oldLine, oldBreak] = logLineNodePairs.shift()
    pre.removeChild(oldLine)
    pre.removeChild(oldBreak)
  }
}

async function loadRecentLogLines() {
  const lines = await window.agentDesktop.getRecentLogLines()
  for (const line of lines || []) appendLogLine(line)
}

const PREFERENCE_FIELDS = ['startRelayOnLaunch', 'startWithWindows']

async function loadPreferencesIntoForm() {
  const prefs = await window.agentDesktop.getPreferences()
  for (const field of PREFERENCE_FIELDS) {
    const el = byId(field)
    if (el) el.checked = Boolean(prefs && prefs[field])
  }
}

function wirePreferenceCheckbox(field) {
  const el = byId(field)
  if (!el) return
  el.addEventListener('change', async () => {
    const desired = el.checked
    const result = await window.agentDesktop.setPreferences({ [field]: desired })
    if (!result || result.ok !== true) {
      byId('preferences-error').textContent = 'Could not save preference.'
      el.checked = !desired // revert on failure -- the checkbox must reflect what was actually saved
      return
    }
    byId('preferences-error').textContent = ''
  })
}

function collectPatch() {
  const patch = {}
  for (const field of FIELDS) {
    const el = byId(field)
    if (!el) continue
    if (el.type === 'checkbox') {
      patch[field] = el.checked
    } else if (el.type === 'number') {
      if (el.value !== '') patch[field] = Number(el.value)
    } else {
      patch[field] = el.value
    }
  }
  for (const field of SECRET_FIELDS) {
    const el = byId(field)
    if (el && el.value) patch[field] = el.value
  }
  return patch
}

function init() {
  // UAT-06: rendered before anything async, so the notices are on screen even
  // if loading the configuration fails.
  renderFieldNotices()

  loadConfigIntoForm().catch((err) => {
    byId('save-error').textContent = String((err && err.message) || err)
  })
  refreshStatus().catch(() => {})
  loadRecentLogLines().catch(() => {})
  loadPreferencesIntoForm().catch(() => {})
  wirePreferenceCheckbox('startRelayOnLaunch')
  wirePreferenceCheckbox('startWithWindows')

  byId('import-button')?.addEventListener('click', async () => {
    const result = await window.agentDesktop.importLegacyEnv()
    if (!result || result.ok !== true) {
      showFieldErrors(result && result.errors)
      return
    }
    byId('import-result').textContent = 'Imported: ' + result.importedFields.join(', ')
    await loadConfigIntoForm()
  })

  byId('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    clearFieldErrors()
    byId('restart-required-notice').hidden = true

    const result = await window.agentDesktop.setConfig(collectPatch())
    if (!result || result.ok !== true) {
      showFieldErrors(result && result.errors)
      return
    }
    if (result.restartRequired) {
      byId('restart-required-notice').hidden = false
    }
    // The configuration just changed, so a start failure caused by the old
    // one is stale -- stop showing it (UAT-01).
    pendingStartError = ''
    await loadConfigIntoForm()
    await refreshStatus()
  })

  byId('restart-button')?.addEventListener('click', async () => {
    await window.agentDesktop.stop()
    const result = await window.agentDesktop.start()
    if (result && result.ok === true) {
      byId('restart-required-notice').hidden = true
    }
    await refreshStatus()
  })

  byId('start-button').addEventListener('click', async () => {
    const result = await window.agentDesktop.start()
    if (!result || result.ok !== true) {
      pendingStartError = formatStartError(result)
      if (result && result.errors) showFieldErrors(result.errors)
    } else {
      pendingStartError = ''
    }
    byId('status-last-error').textContent = pendingStartError || '-'
    await refreshStatus()
  })

  byId('stop-button').addEventListener('click', async () => {
    await window.agentDesktop.stop()
    await refreshStatus()
  })

  window.agentDesktop.onStatus((status) => renderStatus(status))
  window.agentDesktop.onLogLine((line) => appendLogLine(line))
}

document.addEventListener('DOMContentLoaded', init)
