import fs from 'fs'
import path from 'path'

/**
 * The rotating-file log tail (SC-3, plan 10-03 Task 2).
 *
 * Per 10-CONTEXT's explicit instruction, this does NOT re-plumb the logger:
 * it reads the exact file `logging/logger.ts`'s `DailyRotateFile` transport
 * already writes (`${logDir}/app-<YYYY-MM-DD>.log`, `datePattern:
 * 'YYYY-MM-DD'`, `maxSize: '10m'`), and nothing here changes what winston
 * does. No import of `electron` — vitest must be able to drive `poll()`
 * directly, without waiting on a real timer.
 *
 * Mask defensively: the logger's own discipline is that neither secret is
 * ever written (`LiveConfig`'s and `WsConnection`'s own comments say so), but
 * this is still a new egress — the file becomes visible in a window, and a
 * future log line written by someone who did not read those comments would
 * arrive there. Every occurrence of a currently-stored secret is replaced by
 * a fixed mask before a line leaves this module.
 */

export interface ClockLike {
  now(): Date
}

const REAL_CLOCK: ClockLike = { now: () => new Date() }

export interface LogTailOptions {
  /**
   * Resolves the current log directory at POLL TIME, not once at
   * construction — the same reason `agent.ts`'s reachability probe reads
   * `live.dslrBoothApiPort` live rather than a captured boot value
   * (10-RESEARCH Pitfall 4, applied here to the log directory).
   */
  resolveLogDir: () => string
  /** Called once per complete, masked line, in order. */
  emit: (line: string) => void
  /** Returns the secret values to mask, evaluated at poll time. Defaults to none. */
  secrets?: () => string[]
  /** Defaults to the real clock. Injectable for the midnight-rollover case. */
  clock?: ClockLike
  /** Milliseconds between polls when `start()` drives its own timer. Defaults to 1000. */
  pollIntervalMs?: number
  /** Maximum retained lines in the ring buffer. Defaults to 500. */
  bufferCap?: number
  /** Maximum bytes read in a single poll, so a very large append cannot stall the process. Defaults to 64 KiB. */
  byteCapPerPoll?: number
}

export interface LogTail {
  /** Starts the recurring timer (after one immediate poll). Idempotent. */
  start(): void
  /** Stops the timer. Leaves no timer behind (T-10-20). Idempotent. */
  stop(): void
  /** Drives a single poll cycle directly — what tests call instead of waiting on a timer. */
  poll(): void
  /** The retained buffer, oldest first / newest last. */
  getRecentLines(): string[]
}

export const SECRET_MASK = '***MASKED***'

function formatDate(d: Date): string {
  // Local time, matching winston-daily-rotate-file's own default (no `utc: true`
  // is set in logger.ts) — using UTC here would disagree with the transport
  // about when "today" rolls over.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function maskLine(line: string, secretValues: string[]): string {
  let masked = line
  for (const secret of secretValues) {
    if (!secret) continue
    masked = masked.split(secret).join(SECRET_MASK)
  }
  return masked
}

export function createLogTail(options: LogTailOptions): LogTail {
  const {
    resolveLogDir,
    emit,
    secrets = () => [],
    clock = REAL_CLOCK,
    pollIntervalMs = 1000,
    bufferCap = 500,
    byteCapPerPoll = 64 * 1024,
  } = options

  let currentFileName: string | null = null
  let offset = 0
  let partial = ''
  let timer: ReturnType<typeof setInterval> | null = null
  const buffer: string[] = []

  function poll(): void {
    const dir = resolveLogDir()
    const fileName = `app-${formatDate(clock.now())}.log`
    const filePath = path.join(dir, fileName)

    if (fileName !== currentFileName) {
      // A new day's file — follow it, starting from its own beginning.
      currentFileName = fileName
      offset = 0
      partial = ''
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      // Directory or file does not exist yet — wait quietly, do not throw.
      return
    }

    if (stat.size < offset) {
      // Shorter than our offset: this is what the size cap's roll looks like
      // from here. Start over from the beginning rather than emitting
      // nothing forever.
      offset = 0
      partial = ''
    }

    if (stat.size <= offset) return // nothing appended since the last poll

    const bytesToRead = Math.min(stat.size - offset, byteCapPerPoll)
    const buf = Buffer.alloc(bytesToRead)
    const fd = fs.openSync(filePath, 'r')
    try {
      fs.readSync(fd, buf, 0, bytesToRead, offset)
    } finally {
      fs.closeSync(fd)
    }
    offset += bytesToRead

    const content = partial + buf.toString('utf8')
    const parts = content.split(/\r?\n/)
    // The last element is either the new held-back partial line, or an empty
    // string when `content` ended exactly on a line terminator.
    partial = parts.pop() ?? ''

    const secretValues = secrets()
    for (const line of parts) {
      const masked = maskLine(line, secretValues)
      buffer.push(masked)
      if (buffer.length > bufferCap) buffer.shift()
      emit(masked)
    }
  }

  return {
    poll,
    start(): void {
      if (timer) return
      poll()
      timer = setInterval(poll, pollIntervalMs)
    },
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    getRecentLines(): string[] {
      return [...buffer]
    },
  }
}
