/**
 * The guest-facing wait estimator. Pure: no database, no clock, no logger, no
 * import from LocalStore. Everything it needs arrives as an argument, which is
 * what lets every branch below be pinned by a plain-array unit test.
 *
 * Naming: the `Ms` in `estimateWaitMs` refers to its millisecond *inputs* —
 * the returned bounds are whole MINUTES. D-03 says the guest sees a range,
 * rounded up ("khoảng 3-5 phút"), never a precise ticking number: a countdown
 * that ticks down and then jumps back up when the queue shifts destroys trust
 * faster than a vague answer ever will. Rounding up is deliberate too — it is
 * always better for a guest to be called early than late.
 *
 * The `Math.max(1, ...)` floor on the high bound is what makes a guest with
 * nobody ahead of them see "0-1 minutes" rather than "0 minutes", which would
 * read as a promise the booth cannot keep.
 */

export interface WaitRange {
  lowMinutes: number;
  highMinutes: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * Median, not mean (D-02). A single session that hit Phase 2's five-minute
 * BUSY timeout would drag a mean upward for hours; the median absorbs it.
 *
 * Sorts a COPY — never the caller's array in place. The caller owns its array
 * and a hidden reorder is exactly the kind of action-at-a-distance that makes
 * a pure function stop being one.
 */
export function medianMs(durations: number[]): number | null {
  if (durations.length === 0) return null;

  const sorted = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * D-04's cold-start boundary, written out rather than left to the symbol:
 * the comparison is `durations.length < cfg.minSamples` — STRICTLY less than.
 * A sample of exactly `minSamples` uses the computed median and does NOT fall
 * back to the default. (`<` vs `<=` here is precisely the off-by-one class
 * this project has already paid for.)
 */
export function estimateWaitMs(
  durations: number[],
  guestsAhead: number,
  cfg: { minSamples: number; defaultMs: number },
): WaitRange {
  const perSessionMs = durations.length < cfg.minSamples
    ? cfg.defaultMs
    // medianMs only returns null for an empty array, which the branch above
    // already claims for any minSamples >= 1. The coalesce covers a
    // minSamples of 0 without letting a null reach the arithmetic.
    : (medianMs(durations) ?? cfg.defaultMs);

  const pointMs = perSessionMs * guestsAhead;
  const highMinutes = Math.max(1, Math.ceil(pointMs / MS_PER_MINUTE));
  const lowMinutes = Math.max(0, highMinutes - 1);

  return { lowMinutes, highMinutes };
}
