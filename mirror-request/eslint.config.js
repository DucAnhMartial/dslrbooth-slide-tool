/**
 * ESLint flat config.
 *
 * Why this file did not exist until 2026-08-16: `package.json` has carried a
 * `lint` script and the ESLint 9 + typescript-eslint 8 devDependencies since
 * the project began, but no configuration file of any kind. ESLint 9 dropped
 * the `.eslintrc` cascade, so `npm run lint` exited with "couldn't find an
 * eslint.config.js" — on every run, from the first. The project has therefore
 * never actually been linted; the script only looked like it was.
 *
 * That history sets the rule selection below. A codebase this size that has
 * never been linted will light up under an opinionated preset, and a lint run
 * that reports hundreds of pre-existing findings is one nobody runs twice. So
 * this config is deliberately narrow: it turns on the checks that catch real
 * defects — an unawaited promise, an unused binding, a `case` that falls
 * through — and leaves style to the reviewer. Tighten it later, from a green
 * baseline, one rule at a time.
 *
 * Not type-aware (no `parserOptions.project`). The type-aware presets are
 * where typescript-eslint's strongest rules live, but they need a full
 * program per run and would slow `npm run lint` from a second to tens of
 * seconds. `npm run typecheck` already runs the compiler in strict mode over
 * the same files, so the type-level ground is covered — this pass is for what
 * the compiler does not look at.
 */

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    // Build output and dependencies. Flat config has no implicit ignores
    // beyond node_modules, and `dist/` holds a compiled copy of every source
    // file — linting it would double every finding.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'data/**', 'logs/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: false } },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // Correctness — each of these has a plausible failure behind it.
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'require-atomic-updates': 'error',

      // Unused code. Warn, not error: an unused binding is a smell, not a
      // fault, and making it fatal is how a lint script gets bypassed with
      // --no-verify. `_`-prefixed arguments are the established convention in
      // this codebase for a signature-required parameter (see the express
      // handlers' `_req`), so they are exempt here rather than rewritten.
      'no-unused-vars': 'off', // superseded by the TS-aware version below
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // TypeScript-specific correctness.
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-unnecessary-type-constraint': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',

      // These two are enabled because the codebase already assumes them: src/
      // carries hand-written `eslint-disable` comments for `no-console` and
      // `@typescript-eslint/no-var-requires` at the exact lines where an ops
      // script legitimately prints to stdout or requires lazily. Those
      // comments were written against a config that never loaded, so they had
      // been inert since the day they were added. Turning the rules on is what
      // makes the author's intent real — and it means `console.log` left
      // behind in a request path is now reported, which is the reason the
      // disable comments were scoped so narrowly in the first place.
      'no-console': 'warn',
      '@typescript-eslint/no-var-requires': 'warn',

      // `no-undef` is off for TypeScript by design: the compiler resolves
      // identifiers, and leaving this on makes ESLint re-guess globals it has
      // no type information about (this is typescript-eslint's own guidance).
      'no-undef': 'off',
    },
  },
  {
    // Tests. The suites deliberately reach past public APIs — private fields
    // via `as unknown as`, hand-built partial doubles — so `any` and the
    // stricter shape rules would fire on code that is correct for what it is.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // Off in tests, on in src. Every one of the eight it reported here was
      // the same shape — a module-level `let server` assigned from an `await`
      // inside beforeAll/beforeEach — which is the standard vitest setup
      // idiom and not a race: hooks for one file run in sequence, and nothing
      // else holds a reference to the variable meanwhile. The rule cannot see
      // that, and eight standing false positives would train a reader to skim
      // past the real ones.
      'require-atomic-updates': 'off',
      // Tests print diagnostic context on purpose.
      'no-console': 'off',
    },
  },
];
