import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createLogTail, SECRET_MASK, type ClockLike } from '../src/electron/logTail'

// ---------------------------------------------------------------------------
// Plan 10-03, Task 2 — the log tail (SC-3).
//
// Drives `poll()` directly rather than waiting on a real timer, following
// this task's own instruction. The rotation cases are written in both forms
// (a new date, and a shrink) because both happen on a booth PC that runs for
// a whole event and both present the same symptom to an operator: the pane
// stops updating.
//
// The filenames written here (`app-<YYYY-MM-DD>.log`) match
// `logging/logger.ts`'s DailyRotateFile transport exactly — this test file
// simulates what winston already writes; it does not re-derive the tail's
// own date formatting from itself.
// ---------------------------------------------------------------------------

let tmpDir: string | null = null
function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-logtail-'))
  return tmpDir
}

afterEach(() => {
  vi.useRealTimers()
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

function dateFileName(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `app-${y}-${m}-${day}.log`
}

function makeClock(initial: Date): ClockLike & { set(d: Date): void } {
  let current = initial
  return {
    now: () => current,
    set(d: Date) {
      current = d
    },
  }
}

describe('a single poll emits every complete line appended since the previous poll, in order', () => {
  it('emits both lines appended in one write, in order; a poll with nothing new emits nothing', () => {
    const dir = makeTmpDir()
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))
    const filePath = path.join(dir, dateFileName(clock.now()))
    fs.writeFileSync(filePath, 'line one\nline two\n')

    const emitted: string[] = []
    const tail = createLogTail({ resolveLogDir: () => dir, emit: (l) => emitted.push(l), clock })

    tail.poll()
    expect(emitted).toEqual(['line one', 'line two'])

    tail.poll()
    expect(emitted).toEqual(['line one', 'line two']) // no new emission
  })
})

describe('a partial final line is not emitted until it is terminated', () => {
  it('holds back an unterminated line, then emits it whole once terminated', () => {
    const dir = makeTmpDir()
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))
    const filePath = path.join(dir, dateFileName(clock.now()))
    fs.writeFileSync(filePath, 'partial line without a terminator')

    const emitted: string[] = []
    const tail = createLogTail({ resolveLogDir: () => dir, emit: (l) => emitted.push(l), clock })

    tail.poll()
    expect(emitted).toEqual([])

    fs.appendFileSync(filePath, '\n')
    tail.poll()
    expect(emitted).toEqual(['partial line without a terminator'])
  })
})

describe('when the file name rolls to a new date, the tail follows to the new file from its own beginning', () => {
  it('follows a midnight rollover', () => {
    const dir = makeTmpDir()
    const day1 = new Date(2026, 0, 15, 23, 59, 0)
    const day2 = new Date(2026, 0, 16, 0, 1, 0)
    const clock = makeClock(day1)

    fs.writeFileSync(path.join(dir, dateFileName(day1)), 'yesterday line\n')

    const emitted: string[] = []
    const tail = createLogTail({ resolveLogDir: () => dir, emit: (l) => emitted.push(l), clock })
    tail.poll()
    expect(emitted).toEqual(['yesterday line'])

    clock.set(day2)
    fs.writeFileSync(path.join(dir, dateFileName(day2)), 'today line\n')
    tail.poll()
    expect(emitted).toEqual(['yesterday line', 'today line'])
  })
})

describe('when the file shrinks, the tail restarts from the beginning rather than emitting nothing forever', () => {
  it('follows a size-cap-style truncation', () => {
    const dir = makeTmpDir()
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))
    const filePath = path.join(dir, dateFileName(clock.now()))
    fs.writeFileSync(filePath, 'a fairly long line before the roll\n')

    const emitted: string[] = []
    const tail = createLogTail({ resolveLogDir: () => dir, emit: (l) => emitted.push(l), clock })
    tail.poll()
    expect(emitted).toEqual(['a fairly long line before the roll'])

    // The size cap's roll looks like this from here: the same file name,
    // suddenly shorter than the offset held for it.
    fs.writeFileSync(filePath, 'first line after the roll\n')
    tail.poll()
    expect(emitted).toEqual(['a fairly long line before the roll', 'first line after the roll'])
  })
})

describe('when the directory or file does not exist yet, the tail waits quietly', () => {
  it('does not throw, and starts emitting once the file appears', () => {
    const dir = makeTmpDir()
    const missingDir = path.join(dir, 'does-not-exist-yet')
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))

    const emitted: string[] = []
    const tail = createLogTail({ resolveLogDir: () => missingDir, emit: (l) => emitted.push(l), clock })

    expect(() => tail.poll()).not.toThrow()
    expect(emitted).toEqual([])

    fs.mkdirSync(missingDir, { recursive: true })
    fs.writeFileSync(path.join(missingDir, dateFileName(clock.now())), 'now it exists\n')
    tail.poll()
    expect(emitted).toEqual(['now it exists'])
  })
})

describe('a line containing a stored secret is emitted with the value masked (T-10-17)', () => {
  it('replaces the secret with the fixed mask', () => {
    const dir = makeTmpDir()
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))
    const filePath = path.join(dir, dateFileName(clock.now()))
    fs.writeFileSync(filePath, 'auth failed for token super-secret-value here\n')

    const emitted: string[] = []
    const tail = createLogTail({
      resolveLogDir: () => dir,
      emit: (l) => emitted.push(l),
      clock,
      secrets: () => ['super-secret-value'],
    })
    tail.poll()
    expect(emitted).toEqual([`auth failed for token ${SECRET_MASK} here`])
    expect(emitted[0]).not.toContain('super-secret-value')
  })
})

describe('the retained buffer is capped, oldest dropped first', () => {
  it('keeps only the newest N lines when the cap is exceeded', () => {
    const dir = makeTmpDir()
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))
    const filePath = path.join(dir, dateFileName(clock.now()))
    fs.writeFileSync(filePath, ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n') + '\n')

    const tail = createLogTail({ resolveLogDir: () => dir, emit: () => {}, clock, bufferCap: 3 })
    tail.poll()
    expect(tail.getRecentLines()).toEqual(['l3', 'l4', 'l5'])
  })
})

describe('a single poll reads at most a documented number of bytes per poll', () => {
  it('does not read past the cap, and emits the remainder on the following poll', () => {
    const dir = makeTmpDir()
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))
    const filePath = path.join(dir, dateFileName(clock.now()))
    fs.writeFileSync(filePath, 'A'.repeat(15) + '\n')

    const emitted: string[] = []
    const tail = createLogTail({ resolveLogDir: () => dir, emit: (l) => emitted.push(l), clock, byteCapPerPoll: 10 })

    tail.poll()
    expect(emitted).toEqual([]) // only 10 of the 16 bytes read; no terminator reached yet

    tail.poll()
    expect(emitted).toEqual(['A'.repeat(15)])
  })
})

describe('no timer survives stop()', () => {
  it('leaves the timer count at zero after stop', () => {
    vi.useFakeTimers()
    const dir = makeTmpDir()
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))
    const tail = createLogTail({ resolveLogDir: () => dir, emit: () => {}, clock })

    tail.start()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    tail.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the recent-lines channel returns the retained buffer, newest last', () => {
  it('reflects what has been polled so far, in chronological order', () => {
    const dir = makeTmpDir()
    const clock = makeClock(new Date(2026, 0, 15, 10, 0, 0))
    const filePath = path.join(dir, dateFileName(clock.now()))
    fs.writeFileSync(filePath, 'first\nsecond\n')

    const tail = createLogTail({ resolveLogDir: () => dir, emit: () => {}, clock })
    tail.poll()
    expect(tail.getRecentLines()).toEqual(['first', 'second'])
  })
})

describe('the status panel and log pane in the renderer (source-text, no display server)', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  const indexJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.js'), 'utf8')

  it.each([
    'status-running',
    'status-socket',
    'status-trigger-port',
    'status-dslrbooth',
    'status-last-event',
    'status-uptime',
    'status-last-error',
  ])('the status panel has an element for %s', (id) => {
    expect(indexHtml).toContain(`id="${id}"`)
  })

  it('renderStatus assigns every documented AgentStatus-derived field', () => {
    const renderStatusBody = indexJs.slice(indexJs.indexOf('function renderStatus'), indexJs.indexOf('async function refreshStatus'))
    for (const id of ['status-running', 'status-socket', 'status-trigger-port', 'status-dslrbooth', 'status-last-event', 'status-uptime', 'status-last-error']) {
      expect(renderStatusBody).toContain(id)
    }
  })

  it('the log pane exists and the append path uses text nodes, never innerHTML', () => {
    expect(indexHtml).toContain('id="log-lines"')
    const appendLogLineBody = indexJs.slice(indexJs.indexOf('function appendLogLine'), indexJs.indexOf('async function loadRecentLogLines'))
    expect(appendLogLineBody).toContain('createTextNode')
    expect(appendLogLineBody).not.toMatch(/\.innerHTML/)
  })

  it('the log pane is bounded on the DOM side too', () => {
    expect(indexJs).toMatch(/LOG_LINE_CAP\s*=\s*\d+/)
    expect(indexJs).toContain('logLineNodePairs.shift()')
  })
})
