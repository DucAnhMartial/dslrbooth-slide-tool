#!/usr/bin/env node
// Copies src/renderer verbatim into dist/renderer.
//
// The renderer is plain HTML/CSS/hand-written JavaScript (10-RESEARCH
// assumption A2). It is never passed through tsc: this project compiles to
// CommonJS (see tsconfig.json's "module": "commonjs"), and CommonJS output
// does not run in a browser context. tsc's own "include": ["src/**/*"] glob
// only picks up .ts files, so src/renderer's .html/.css/.js files are simply
// invisible to the compiler and this script is the only thing that puts them
// in dist/ at all. Chained after `tsc` in the `build` script (see
// package.json) so `npm run build` always leaves dist/renderer populated.
'use strict'

const fs = require('fs')
const path = require('path')

const projectRoot = path.join(__dirname, '..')
const src = path.join(projectRoot, 'src', 'renderer')
const dest = path.join(projectRoot, 'dist', 'renderer')

fs.rmSync(dest, { recursive: true, force: true })
fs.cpSync(src, dest, { recursive: true })
console.log(`copy-assets: ${src} -> ${dest}`)
