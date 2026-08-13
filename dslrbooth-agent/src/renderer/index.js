'use strict'

// The first-run form and a status light — not the finished operator surface;
// per-field polish, `.env` import and a log pane are plan 10-03. Every value
// written into the document below goes through `textContent`/`.value`, never
// `innerHTML`, so nothing here can turn a stored string into markup.

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
    el.placeholder = snapshot[SECRET_PRESENCE_KEY[field]]
      ? 'Stored — leave blank to keep it'
      : 'Required'
  }
}

function formatTimestamp(value) {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

function renderStatus(status) {
  if (!status) return
  byId('status-running').textContent = status.running ? 'running' : 'stopped'
  byId('status-socket').textContent = status.socketState
  byId('status-trigger-port').textContent = status.triggerPort == null ? '-' : String(status.triggerPort)
  byId('status-dslrbooth').textContent = status.dslrBoothReachable
  byId('status-last-event').textContent = formatTimestamp(status.lastEventAt)
  byId('status-last-error').textContent = status.lastError || '-'
}

async function refreshStatus() {
  renderStatus(await window.agentDesktop.getStatus())
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
}

document.addEventListener('DOMContentLoaded', init)
