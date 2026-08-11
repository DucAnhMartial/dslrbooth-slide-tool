import type { Request, Response, NextFunction } from 'express';
import { clientIp } from './ipAllowlist';

/**
 * D-10's compensating control: `registrations.id` (the `/status/:jobId`
 * capability) is CSPRNG-minted but only 40 bits wide (ets_web's
 * short_code.py). That is not guessable in one shot, but it IS
 * brute-forceable given unlimited attempts — this fixed-window limiter is
 * what keeps the shipped capability-URL design (D-06/D-08 of Phase 5) sound
 * at that entropy width.
 *
 * Shape follows `./ipAllowlist.ts` deliberately: plain exported functions,
 * one small factory, no class holding hidden state, no new npm dependency.
 * `express-rate-limit` was audited by RESEARCH and returned `[SUS]`
 * ("too-new") — not adopted; this project has added zero runtime
 * dependencies since Phase 1.
 *
 * The edit that would silently break this file's guarantee: mounting
 * `createStatusRateLimiter(...)`'s middleware AFTER `store.getJob()`, or
 * inlining its check into the route handler body. The limiter MUST be the
 * first handler on the route — a throttled request must never reach the
 * store, or a real id gets more work done before refusal than a fake one,
 * and the extra work is a timing side-channel that confirms the id exists.
 * See `statusRoute.ts`'s mount-point comment for the other half of this
 * guarantee.
 */

export interface RateLimitEntry {
  windowStart: number;
  count: number;
}

export interface RateLimitState {
  entries: Map<string, RateLimitEntry>;
}

export function createRateLimitState(): RateLimitState {
  return { entries: new Map() };
}

/**
 * Pure decision function. Deterministic in `now` — no call to `Date.now()`
 * anywhere in this function — so tests drive time as a plain number instead
 * of waiting on real timers or installing fake ones. That is the same
 * injectability rule every timing knob in this project has followed since
 * Phase 2 (dbPoller.ts's intervalMs, notificationService.ts's retry delays).
 *
 * Fixed window, not sliding: once `now - windowStart >= windowMs` the window
 * has closed, so the entry resets to a fresh window of 1 rather than
 * decaying gradually.
 */
export function checkRateLimit(
  key: string,
  now: number,
  state: RateLimitState,
  opts: { windowMs: number; max: number },
): { limited: boolean; count: number } {
  const existing = state.entries.get(key);

  if (!existing || now - existing.windowStart >= opts.windowMs) {
    const fresh: RateLimitEntry = { windowStart: now, count: 1 };
    state.entries.set(key, fresh);
    return { limited: fresh.count > opts.max, count: fresh.count };
  }

  existing.count += 1;
  return { limited: existing.count > opts.max, count: existing.count };
}

/**
 * Bounds the map an attacker rotating source addresses would otherwise be
 * able to grow without limit (T-06-06). Two passes:
 *   1. Remove every entry whose window has already closed — the cheap,
 *      always-correct case, since a closed window carries no live budget
 *      information worth keeping.
 *   2. If the map is STILL above `maxKeys` after pass 1 (meaning more than
 *      `maxKeys` clients are simultaneously live inside their window),
 *      evict the entries with the oldest `windowStart` first until the map
 *      is exactly at `maxKeys`. Oldest-first means the clients that have
 *      been "in the system" the longest are the ones dropped, which is the
 *      closest this stateless-per-key structure can get to preserving the
 *      most recently active clients' budgets.
 * Returns the total number of entries removed across both passes.
 */
export function pruneExpired(
  state: RateLimitState,
  now: number,
  windowMs: number,
  maxKeys: number,
): number {
  let removed = 0;

  for (const [key, entry] of state.entries) {
    if (now - entry.windowStart >= windowMs) {
      state.entries.delete(key);
      removed += 1;
    }
  }

  if (state.entries.size > maxKeys) {
    const survivors = [...state.entries.entries()].sort(
      (a, b) => a[1].windowStart - b[1].windowStart,
    );
    const excess = state.entries.size - maxKeys;
    for (let i = 0; i < excess; i++) {
      state.entries.delete(survivors[i][0]);
      removed += 1;
    }
  }

  return removed;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  maxKeys: number;
  /** Injected so tests can inspect/seed state without module-level mutation. */
  state?: RateLimitState;
  /** Injected clock, defaulting to `Date.now`. Never read internally except here. */
  now?: () => number;
}

export const RATE_LIMITED_STATUS = 429;

/**
 * D-10's non-distinguishability requirement, applied to the throttled
 * response itself: one key, no `reason`, `code`, `hint`, `detail` or
 * retry-after field, and this exact shape whether or not the id a throttled
 * caller guessed happens to be real. Follows `statusRoute.ts`'s
 * `genericNotFound()` discipline verbatim — two response shapes are two
 * failure modes free to drift apart, and any difference between them is an
 * enumeration oracle.
 */
export const RATE_LIMITED_BODY = { error: 'too many requests' } as const;

/**
 * Express middleware factory. `opts.state`/`opts.now` let a test build an
 * isolated limiter with an isolated clock rather than reaching into module
 * scope — the same "config injected through the constructor" rule every
 * timing knob in this project has followed since Phase 2.
 */
export function createStatusRateLimiter(
  opts: RateLimitOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const state = opts.state ?? createRateLimitState();
  const now = opts.now ?? Date.now;

  return (req: Request, res: Response, next: NextFunction): void => {
    // An empty derived address still yields a usable key (shared bucket)
    // rather than throwing or bypassing the limiter entirely.
    const key = clientIp(req) || 'unknown';
    const currentTime = now();

    const { limited } = checkRateLimit(key, currentTime, state, {
      windowMs: opts.windowMs,
      max: opts.max,
    });

    // Pruned AFTER the decision (not before) so the bound holds at the end
    // of every single request, including the very last one of a burst — a
    // pre-decision-only prune would leave the map transiently one entry
    // over `maxKeys` whenever a brand-new key just pushed it over.
    if (state.entries.size > opts.maxKeys) {
      pruneExpired(state, currentTime, opts.windowMs, opts.maxKeys);
    }

    if (limited) {
      res.status(RATE_LIMITED_STATUS).json(RATE_LIMITED_BODY);
      return;
    }

    next();
  };
}
