import net from 'net'

/**
 * A TCP-connect probe against `127.0.0.1:port` — resolves `true` on connect
 * (and destroys the socket immediately), resolves `false` on error or its own
 * timeout, and never rejects.
 *
 * This stays inside the dumb-relay rule (`mirror-request/CLAUDE.md`), not an
 * exception to it: it sends no bytes, carries no password, names no dslrBooth
 * API path, and cannot start a session. It answers the one question an
 * operator standing at a booth actually asks — whether dslrBooth is
 * listening at all. An HTTP call to the Local API would be the Agent acting
 * on its own initiative; a bare TCP connect is not.
 */
export function probeTcp(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.createConnection({ host: '127.0.0.1', port })

    const finish = (reachable: boolean) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(reachable)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}
