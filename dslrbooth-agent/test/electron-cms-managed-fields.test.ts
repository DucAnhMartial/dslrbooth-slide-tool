import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { SAFE_AGENT_CONFIG_FIELDS, READ_ONLY_AGENT_CONFIG_FIELDS } from '../src/liveConfig'

// ---------------------------------------------------------------------------
// UAT-05 and UAT-06 regression — the window must not lie about two things it
// got quietly wrong on the first real booth-PC install.
//
// UAT-06: the operator unticked "Auto-open the booth display window", saved it,
// confirmed `config.json` held `false` — and the guest window still opened on
// every announcement. Nothing was broken: `autoOpenDisplay` is one of D-16's
// four safe fields, the Extension Service is their source of truth, the Agent
// pulls configuration on every connect, and the stored CMS row said `true`. The
// local edit applied and was then overwritten, exactly as designed. The defect
// was that the window presented a field the CMS owns as if it were local.
//
// UAT-05: the log pane tailed `store.getSnapshot().logDir`, whose shipped
// default is the RELATIVE string 'logs'. Resolved against the process working
// directory that is beside the installed .exe under Program Files — a folder
// with no log file in it. Meanwhile every Agent in this process is built with
// `bootLogger`, which writes to userData/logs. The pane watched one folder
// while the log filled another.
//
// Neither fix changes the D-16/D-17 boundary, which is locked: a local edit
// stays possible (it is the deliberate recovery path for a booth that cannot
// reach the CMS), and the CMS still wins. Only the window's honesty changed.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..')
const rendererJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'index.js'), 'utf8')
const mainSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'electron', 'main.ts'), 'utf8')

/** Reads a `const NAME = [...]` string-array literal out of the renderer. */
function arrayLiteral(name: string): string[] {
  const match = rendererJs.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`))
  if (!match) return []
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
}

describe('the CMS-managed fields are labelled as such (UAT-06)', () => {
  it("the renderer's list is exactly SAFE_AGENT_CONFIG_FIELDS, in the same order", () => {
    // The renderer is plain browser JS with no bundler, so it cannot import the
    // allow-list. This assertion is what keeps the copy honest.
    expect(arrayLiteral('CMS_MANAGED_FIELDS')).toEqual([...SAFE_AGENT_CONFIG_FIELDS])
  })

  it('does not mislabel a bootstrap field as CMS-managed', () => {
    const managed = arrayLiteral('CMS_MANAGED_FIELDS')
    for (const readOnly of READ_ONLY_AGENT_CONFIG_FIELDS) {
      expect(managed).not.toContain(readOnly)
    }
  })

  it('names the four fields explicitly rather than deriving them from a form scrape', () => {
    // A list built by walking the DOM would silently re-label whatever the
    // markup happened to contain.
    expect(arrayLiteral('CMS_MANAGED_FIELDS')).toHaveLength(4)
  })

  it('the notice says the CMS overwrites a local edit, and where to change it for good', () => {
    const notice = rendererJs.match(/const CMS_MANAGED_NOTICE\s*=\s*\n?\s*'([^']+)'/)
    expect(notice, 'CMS_MANAGED_NOTICE must exist').not.toBeNull()
    const text = notice![1]
    expect(text).toMatch(/overwrite/i)
    expect(text).toMatch(/\/cms\/agent/)
  })

  it('renders the notices before any async work, so a failed load still shows them', () => {
    const initBody = rendererJs.slice(rendererJs.indexOf('function init()'))
    const noticeAt = initBody.indexOf('renderFieldNotices()')
    const loadAt = initBody.indexOf('loadConfigIntoForm()')
    expect(noticeAt).toBeGreaterThan(-1)
    expect(noticeAt).toBeLessThan(loadAt)
  })

  it('writes the notice as text, never as markup (T-10-19)', () => {
    const fn = rendererJs.slice(
      rendererJs.indexOf('function renderFieldNotices'),
      rendererJs.indexOf('function showFieldErrors'),
    )
    expect(fn).toMatch(/\.textContent\s*=/)
    expect(fn).not.toMatch(/innerHTML/)
  })
})

describe('the log pane tails the directory that is actually written (UAT-05)', () => {
  it('resolves the tail to the process log dir, not the stored config value', () => {
    const tailBlock = mainSource.slice(
      mainSource.indexOf('createLogTail({'),
      mainSource.indexOf('createLogTail({') + 1200,
    )
    expect(tailBlock).toMatch(/resolveLogDir:\s*\(\)\s*=>\s*logDir\b/)
  })

  it('no longer reads logDir out of the snapshot for the tail', () => {
    // The exact expression that pointed the pane at a relative 'logs'.
    expect(mainSource).not.toMatch(/resolveLogDir:\s*\(\)\s*=>\s*store\.getSnapshot\(\)\.logDir/)
  })

  it('that log dir is absolute and under the user-data directory', () => {
    expect(mainSource).toMatch(/const logDir\s*=\s*path\.join\(userDataDir,\s*'logs'\)/)
    expect(mainSource).toMatch(/fs\.mkdirSync\(logDir,\s*\{\s*recursive:\s*true\s*\}\)/)
  })

  it('logDir is a bootstrap field, so nothing can change it live underneath the tail', () => {
    expect([...READ_ONLY_AGENT_CONFIG_FIELDS]).toContain('logDir')
  })

  it('the form explains that logDir does not decide where this window logs', () => {
    expect(rendererJs).toMatch(/notices\.push\(\[\s*\n?\s*'logDir'/)
    // Anchor on notices.push -- 'logDir' also appears in the FIELDS array at
    // the top of the file, and slicing from its first occurrence read the
    // wrong region entirely (which is how this assertion first failed).
    const pushAt = rendererJs.indexOf('notices.push([')
    expect(pushAt).toBeGreaterThan(-1)
    const noticeText = rendererJs.slice(pushAt, pushAt + 500)
    expect(noticeText).toMatch(/CLI and Windows-service builds/)
  })
})
