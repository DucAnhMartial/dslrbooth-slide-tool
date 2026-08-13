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

function renderStatus(status) {
  if (!status) return
  byId('status-running').textContent = status.running ? 'running' : 'stopped'
  byId('status-socket').textContent = status.socketState
  byId('status-trigger-port').textContent = status.triggerPort == null ? '-' : String(status.triggerPort)
  byId('status-dslrbooth').textContent = status.dslrBoothReachable
  byId('status-last-event').textContent = formatTimestamp(status.lastEventAt)
  byId('status-uptime').textContent =
    status.running && status.startedAt ? formatDuration(Date.now() - status.startedAt) : '-'
  byId('status-last-error').textContent = status.lastError || '-'
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
  loadConfigIntoForm().catch((err) => {
    byId('save-error').textContent = String((err && err.message) || err)
  })
  refreshStatus().catch(() => {})
  loadRecentLogLines().catch(() => {})

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
    await loadConfigIntoForm()
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
      const message = (result && (result.error || (result.errors && JSON.stringify(result.errors)))) || 'Could not start.'
      byId('status-last-error').textContent = message
    }
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
