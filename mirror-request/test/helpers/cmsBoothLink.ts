import type { CmsBoothLink } from '../../src/cms/cmsBoothRoutes';

/**
 * The stub every existing CMS test wants: the booth idle (no guest to show)
 * and a release that refuses. None of the seven files this is threaded into
 * is about the booth — plan 11-03's own `test/cms-booth-release.test.ts` is
 * where the real thing (idle/busy/grace/wrong-job/already-finished) is
 * driven and asserted.
 *
 * Exported as `BOOTH_LINK`, not a factory, on purpose: every call site
 * passes the SAME identifier so a single grep can confirm every real router
 * factory call in this repo supplies its now-required fourth argument.
 */
export const BOOTH_LINK: CmsBoothLink = {
  getBoothStallInfo: () => null,
  releaseForOperator: () => 'wrong_job',
};
