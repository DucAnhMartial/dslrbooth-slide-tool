import { describe, expect, it } from 'vitest';
import { estimateWaitMs, medianMs } from '../src/status/estimateWaitMs';

// Pure unit tests over plain arrays. No database, no server, no mocks, no
// timers — every input to the estimator is an argument, so every branch below
// is reachable without constructing any of the rest of the system.
//
// Every expected value states its arithmetic in the test name or a comment:
//   median x guestsAhead -> pointMs -> ceil(pointMs / 60000) = high, high - 1 = low
// This project has been burned six times by counts asserted but never
// computed, including a `<=` vs `<` off-by-one, so the numbers are written out
// where a reviewer can check the intent rather than just the symbol.

const CFG = { minSamples: 5, defaultMs: 180_000 };

describe('medianMs', () => {
  it('returns null for an empty sample', () => {
    expect(medianMs([])).toBeNull();
  });

  it('odd length: [300000, 100000, 200000] sorts to [100000, 200000, 300000], middle = 200000', () => {
    // Deliberately unsorted input: if the sort were dropped, the "middle"
    // element of the raw array would be 100000 and this would fail.
    expect(medianMs([300_000, 100_000, 200_000])).toBe(200_000);
  });

  it('even length: mean of the two middle values, (200000 + 300000) / 2 = 250000', () => {
    expect(medianMs([100_000, 200_000, 300_000, 400_000])).toBe(250_000);
  });

  it('does not mutate the caller array', () => {
    const durations = [300_000, 100_000, 200_000];

    medianMs(durations);

    expect(durations).toEqual([300_000, 100_000, 200_000]);
  });

  // D-02's actual reason for choosing median over mean, stated as a test
  // rather than as a comment. The outlier here is a session that hit Phase 2's
  // five-minute BUSY timeout; a mean would carry it for hours.
  it('one outlier cannot drag the result: median is 180000, not the mean of 744000', () => {
    const withOutlier = [180_000, 180_000, 180_000, 180_000, 3_000_000];

    expect(medianMs(withOutlier)).toBe(180_000);

    // (180000 * 4 + 3000000) / 5 = 3720000 / 5 = 744000 — what a mean would
    // have returned, i.e. a 12-minute-plus per-session estimate drawn from a
    // booth whose sessions actually run three minutes.
    const mean = withOutlier.reduce((a, b) => a + b, 0) / withOutlier.length;
    expect(mean).toBe(744_000);
    expect(medianMs(withOutlier)).not.toBe(mean);
  });
});

describe('estimateWaitMs — D-04 cold-start boundary', () => {
  // The comparison is `durations.length < minSamples`, strictly less than.
  // Both sides of that boundary are asserted, because `<` vs `<=` here is
  // exactly the off-by-one class this project has already paid for once.

  it('4 samples is below minSamples 5, so the configured default wins: 180000 x 1 -> ceil(180000/60000) = 3 -> {2, 3}', () => {
    const fourSamples = [600_000, 600_000, 600_000, 600_000];

    expect(estimateWaitMs(fourSamples, 1, CFG)).toEqual({ lowMinutes: 2, highMinutes: 3 });
  });

  it('exactly 5 samples is NOT below minSamples 5, so the computed median wins: 600000 x 1 -> ceil(600000/60000) = 10 -> {9, 10}', () => {
    const fiveSamples = [600_000, 600_000, 600_000, 600_000, 600_000];

    expect(estimateWaitMs(fiveSamples, 1, CFG)).toEqual({ lowMinutes: 9, highMinutes: 10 });
  });
});

describe('estimateWaitMs — D-03 rounding, both sides of the boundary', () => {
  it('an exact whole minute is not pushed to the next one: median 240000 x 1 -> 240000/60000 = 4.0 -> ceil = 4 -> {3, 4}', () => {
    const samples = [240_000, 240_000, 240_000, 240_000, 240_000];

    expect(estimateWaitMs(samples, 1, CFG)).toEqual({ lowMinutes: 3, highMinutes: 4 });
  });

  it('a fraction rounds up: median 252000 x 1 -> 252000/60000 = 4.2 -> ceil = 5 -> {4, 5}', () => {
    const samples = [252_000, 252_000, 252_000, 252_000, 252_000];

    expect(estimateWaitMs(samples, 1, CFG)).toEqual({ lowMinutes: 4, highMinutes: 5 });
  });

  it('multiple guests ahead multiply: median 180000 x 3 -> 540000/60000 = 9 -> ceil = 9 -> {8, 9}', () => {
    const samples = [180_000, 180_000, 180_000, 180_000, 180_000];

    expect(estimateWaitMs(samples, 3, CFG)).toEqual({ lowMinutes: 8, highMinutes: 9 });
  });
});

describe('estimateWaitMs — the zero-guests floor', () => {
  // Math.max(1, ...) on the high bound. Without it a guest with nobody ahead
  // would be shown "0-0 minutes", which reads as a promise the booth cannot
  // keep the moment anything at all delays the next session.
  it('guestsAhead 0 yields {0, 1}, never {0, 0}: 600000 x 0 -> 0/60000 = 0 -> ceil = 0 -> floored to high 1', () => {
    const samples = [600_000, 600_000, 600_000, 600_000, 600_000];

    expect(estimateWaitMs(samples, 0, CFG)).toEqual({ lowMinutes: 0, highMinutes: 1 });
  });

  it('the floor also holds on the cold-start path: 4 samples, guestsAhead 0 -> {0, 1}', () => {
    expect(estimateWaitMs([600_000, 600_000, 600_000, 600_000], 0, CFG)).toEqual({
      lowMinutes: 0,
      highMinutes: 1,
    });
  });
});
