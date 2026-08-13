import { describe, it, expect, afterEach } from 'vitest'
import { createTriggerServer } from '../src/triggers/server'
import type { Logger } from '../src/logging/logger'

// ---------------------------------------------------------------------------
// The booth-side display no longer lists the queue.
//
// The Agent opens `http://127.0.0.1:<triggerServerPort>/display` in an Edge
// kiosk window ON THE BOOTH PC, and closes it again when dslrBooth needs the
// screen ("Display hidden; returning control to dslrBooth"). That window is
// for the guest STANDING AT THE CAMERA: their name, the countdown, and the
// instruction to look at the lens.
//
// The "Thứ tự tiếp theo" list beside it was the one part that duplicated the
// room screen, which since Phase 8 carries the queue for the whole venue at
// /display-screen. Two places showing the same list is two places to disagree
// when one of them lags.
//
// What must SURVIVE is asserted here too, and that is the point of the file:
// removing a column from a kiosk page is a one-line deletion, and a one-line
// deletion is exactly the kind of change that quietly takes the countdown or
// the lens prompt with it. Nothing else in this repository renders that page.
// ---------------------------------------------------------------------------

const PORT = 34567

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

let server: { updateDisplay: (p: unknown) => void; close: () => Promise<void> } | null = null

async function pageHtml(): Promise<string> {
  server = createTriggerServer({ port: PORT, onEvent: () => {} }, silentLogger) as never
  const res = await fetch(`http://127.0.0.1:${PORT}/display`)
  return res.text()
}

afterEach(async () => {
  await server?.close()
  server = null
})

describe('the booth display page', () => {
  it('no longer renders the queue list', async () => {
    const html = await pageHtml()

    expect(html).not.toContain('Thứ tự tiếp theo')
    expect(html).not.toContain('id="queue"')
  })

  it('still tells the guest at the camera what is happening', async () => {
    const html = await pageHtml()

    // The three states the booth screen exists to communicate. Losing any of
    // these to a careless deletion leaves a guest standing in front of a
    // camera with no idea whether it is their turn.
    expect(html).toContain('Xin mời khách tiếp theo')
    expect(html).toContain('nhìn vào ống kính')
    expect(html).toContain('Vui lòng chờ lượt chụp tiếp theo')
    // The countdown ring and the name the countdown belongs to.
    expect(html).toContain('id="count"')
    expect(html).toContain('id="guest"')
  })

  it('still serves the state the page polls', async () => {
    server = createTriggerServer({ port: PORT, onEvent: () => {} }, silentLogger) as never
    server!.updateDisplay({ phase: 'announcing', guestName: 'Lan', endsAt: 123, queueLength: 2 })

    const state = await (await fetch(`http://127.0.0.1:${PORT}/display-state`)).json()

    // `updateDisplay` and /display-state are the seam the service pushes
    // through; the page rendering less of it must not change what arrives.
    // `upNext` is deliberately still accepted and still stored — dropping it
    // from AgentDisplayState would be a protocol change to a message the
    // service already sends, which is a different decision from not drawing it.
    expect(state).toMatchObject({ phase: 'announcing', guestName: 'Lan', queueLength: 2 })
  })
})
