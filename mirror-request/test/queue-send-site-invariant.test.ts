import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * D11-05/D11-08 (phase 11), 11-VALIDATION.md's precedent in
 * test/local-store-persistence.test.ts (`seedRegistrationsCursor.toString()`
 * — a test that asserts against the SOURCE rather than against behaviour):
 * a behavioural test can only prove "no test currently exercises a second
 * send site". It cannot prove a second send site DOES NOT EXIST, because a
 * future edit could add one that no fixture happens to reach. This file pins
 * the structural guarantee directly, against the queue service's own source
 * text — one send site is what makes a double notification structurally
 * impossible, not merely unlikely, and that property has to be checked
 * against the code, not against a sample of the code's behaviour.
 *
 * Comments are stripped before counting, so a comment that merely MENTIONS
 * one of these names — including this file's own doc comments, were they
 * ever copy-pasted into the source under test — cannot satisfy or break the
 * count. Block comments are stripped first, so a commented-out call site
 * inside a `/** ... *\/` block (as this file's own header would be, if
 * copy-pasted into the source) is never miscounted as live code.
 *
 * `finalizePendingPrint()` (the D11-05 gate itself) and `onFileUpload()`'s
 * D-11 late-arrival branch both legitimately call the wrapper methods
 * `recordPhotoHistory()`/`sendNotification()` — that is by design (a photo
 * arriving late for an already-closed job is still delivered exactly once,
 * directly, because the finalize gate has already run and will not run
 * again for that job). What must stay singular is not "how many places call
 * the wrapper" but the wrapper's OWN single call to the underlying
 * primitive: `sendNotification()` is the only caller of
 * `notificationService.sendPhotoLink()`, and `writePhotoHistory()` is the
 * only caller of `store.recordEventPhoto()`. Those two primitives are what
 * this file pins, because they are the two irreversible actions — a real
 * message sent, a real durable row written — and a second call site to
 * EITHER of them, however it was reached, would make a double notification
 * or a duplicate history row possible again, silently.
 */

const SOURCE_PATH = path.join(__dirname, '..', 'src', 'queue', 'queueService.ts');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (including JSDoc) first
    .replace(/\/\/.*$/gm, ''); // then line comments
}

function countCalls(source: string, methodName: string): number {
  // `.methodName(` — a property-access CALL, not a type declaration
  // (`methodName: (...)`) or a bare mention. The leading dot is what
  // distinguishes an actual invocation from every other way this project's
  // TypeScript spells the same identifier (parameter names, object-literal
  // type shapes, etc.).
  const pattern = new RegExp(`\\.${methodName}\\s*\\(`, 'g');
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}

describe('QueueService source invariants — the one-send-site guarantee, pinned against the source (D11-05)', () => {
  const rawSource = fs.readFileSync(SOURCE_PATH, 'utf8');
  const source = stripComments(rawSource);

  it('sendPhotoLink is called from exactly one place in the service source — the single choke point that makes a double notification structurally impossible, not merely unlikely', () => {
    const callCount = countCalls(source, 'sendPhotoLink');
    expect(
      callCount,
      'sendPhotoLink must be called from exactly one place (sendNotification()). ' +
      'A second call site would make a double notification possible again, silently — ' +
      'the exact defect D11-04/D11-05 exist to make structurally impossible, not merely unlikely.',
    ).toBe(1);
  });

  it('recordEventPhoto is called from exactly one place in the service source — the single choke point for a durable photo-history write', () => {
    const callCount = countCalls(source, 'recordEventPhoto');
    expect(
      callCount,
      'recordEventPhoto must be called from exactly one place (writePhotoHistory()). ' +
      'A second call site risks a duplicate or out-of-band history row for the same capture, ' +
      'independent of the store\'s own INSERT OR IGNORE idempotency (defence in depth, not a substitute for it).',
    ).toBe(1);
  });

  it('the retired release-fallback field name (releaseTimer) does not occur anywhere in the service source', () => {
    expect(
      source,
      'releaseTimer was Phase 7\'s D-02 release-fallback timer, retired by D11-05/D11-06 — its ' +
      'guarantee moved to RETAKE_GRACE_MS (an unapproved attempt) and the unchanged SESSION_TIMEOUT_MS ' +
      '(a session that never starts). A reintroduction of this field would resurrect a second, competing ' +
      'release path this phase deliberately removed.',
    ).not.toMatch(/\breleaseTimer\b/);
  });

  it('the retired resolvePendingPrint method name does not occur anywhere in the service source — markPendingPrintFinalized() replaced it, not wrapped it (D11-05)', () => {
    expect(
      source,
      'D11-05\'s own text: "thay resolvePendingPrint" (replaces, not wraps). A reintroduced ' +
      'resolvePendingPrint call site would be a second, un-audited path to the same terminal state ' +
      'markPendingPrintFinalized() already owns exclusively.',
    ).not.toMatch(/\bresolvePendingPrint\b/);
  });
});
