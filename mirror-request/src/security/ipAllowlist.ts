/**
 * The single shared source of "what counts as an allowed peer" for the two
 * display surfaces (`GET /display-screen` and `WS /display`, D-09). Reuses
 * the exact logic `src/ingestion/mirrorReceiver.ts:20-54` already
 * established for `/on-register`, reimplemented here as plain exported
 * functions rather than imported — `mirrorReceiver.ts` stays untouched so
 * Phase 1's green suite carries zero risk from this plan (05-CONTEXT.md
 * phase boundary).
 *
 * The parameter type of `clientIp` is a structural shape, not `Request`:
 * it must serve both an Express `Request` (which has `.ip`) and the raw
 * `http.IncomingMessage` delivered at the WebSocket `upgrade` event (which
 * has no Express `.ip` property at all) — that is precisely why the
 * fallback to `req.socket.remoteAddress` matters for the WS layer.
 *
 * No application-level proxy trust (`app.set('trust proxy', ...)`) is
 * enabled anywhere in this service (see `src/index.ts`). Without it,
 * `req.ip` resolves to the direct TCP peer, which is what
 * `DISPLAY_IP_WHITELIST` is meant to match. Enabling `trust proxy`
 * unscoped would let any client forge `X-Forwarded-For` and impersonate an
 * allow-listed address (T-05-02). See `src/ingestion/mirrorReceiver.ts:20-34`
 * for the full original reasoning this is copied from — do not diverge
 * from it, and do not enable proxy trust to "fix" a deployment topology
 * change; scope it to the specific hop instead and re-verify this file's
 * reasoning first.
 */
export function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return (req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
}

export function isWhitelisted(ip: string, whitelist: string[]): boolean {
  // Development escape hatch only, same as Phase 1: an empty whitelist
  // allows every request. DISPLAY_IP_WHITELIST's production fail-fast
  // check (src/config.ts) makes this branch unreachable in production.
  if (whitelist.length === 0) return true;
  return whitelist.some((allowed) => {
    if (allowed.endsWith('.*')) {
      const prefix = allowed.slice(0, -2);
      return ip.startsWith(prefix);
    }
    return ip === allowed;
  });
}
