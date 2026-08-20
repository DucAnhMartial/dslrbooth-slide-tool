import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Plan 10-04, Task 1 — the packaging invariants that otherwise break silently
// and are noticed on a booth PC: an output-directory collision with the
// compiler, a missing renderer, a shipped environment file, an icon that
// isn't there, or a signing key nobody meant to configure.
//
// electron-builder.json is written as JSON rather than YAML for exactly one
// reason worth stating here rather than assuming: a JSON document is
// readable by this file with `JSON.parse` and no parser dependency at all —
// no `js-yaml`, no `strip-json-comments`, nothing new in package.json to
// keep a test honest.
//
// This file asserts the CONFIGURATION and the BUILT TREE (`npm run build`'s
// output, which the plan's own `<verify>` command always runs first). It
// does NOT run the actual Windows packaging step (`scripts/build-win.sh`) —
// that pulls a multi-gigabyte Docker image and produces real Windows
// binaries, which is exercised once, for real, as this task's own
// acceptance criteria, not on every `vitest run`.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..')

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'))
}

const packageJson = readJson('package.json') as {
  devDependencies: Record<string, string>
}
const tsconfigJson = readJson('tsconfig.json') as {
  compilerOptions: { outDir: string }
}
const builderConfig = readJson('electron-builder.json') as {
  appId?: string
  productName?: string
  directories?: { output?: string; buildResources?: string }
  files?: string[]
  win?: { target?: string[]; icon?: string; artifactName?: string }
  nsis?: {
    oneClick?: boolean
    allowToChangeInstallationDirectory?: boolean
    artifactName?: string
  }
  portable?: { artifactName?: string }
}

// -- 1. the packaging tool, pinned to its current stable major (10-RESEARCH
//    Pitfall 1: the docs site documents the next major, v27, by default) ---

describe('electron-builder is pinned to the stable major, not the alpha tag', () => {
  it('is a devDependency', () => {
    expect(packageJson.devDependencies).toHaveProperty('electron-builder')
  })

  it('is pinned to a range whose major is 26, never 27', () => {
    const range = packageJson.devDependencies['electron-builder']
    // Accepts "^26", "^26.15.3", "26.x" etc. — any range form that names 26
    // as the major. Rejects anything naming 27 (the still-alpha next line)
    // or an unpinned "*"/"latest".
    expect(range).toMatch(/(?:^|[\^~])26(?:\.\d+){0,2}$/)
    expect(range).not.toMatch(/27/)
  })

  it('the installed version actually satisfies that pin (26.x)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const installed = require('electron-builder/package.json').version as string
    expect(installed.startsWith('26.')).toBe(true)
  })
})

// -- 2. electron-builder.json is plain JSON, readable with no parser dep ---

describe('electron-builder.json is JSON, not YAML', () => {
  it('exists and parses as JSON with no extra dependency', () => {
    expect(builderConfig).toBeTruthy()
    expect(typeof builderConfig).toBe('object')
  })

  it('the file on disk has no YAML sibling shadowing it', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'electron-builder.yml'))).toBe(false)
    expect(fs.existsSync(path.join(REPO_ROOT, 'electron-builder.yaml'))).toBe(false)
  })
})

// -- 3. the output directory does not collide with the compiler's own ------

describe('the packaging output directory never collides with the compiler output', () => {
  it('tsconfig.compilerOptions.outDir is ./dist', () => {
    expect(tsconfigJson.compilerOptions.outDir.replace(/^\.\//, '')).toBe('dist')
  })

  it('electron-builder.json directories.output is set and differs from dist', () => {
    const output = builderConfig.directories?.output
    expect(output).toBeTruthy()
    expect(output).not.toBe('dist')
    expect(output?.replace(/^\.\//, '')).not.toBe('dist')
  })
})

// -- 4. the file set includes the compiled output + renderer, excludes the -
//    environment file, the log directory, the service-only dependency, and
//    the compiler's map/declaration debris ---------------------------------

describe('the packaging file set is a deliberate allow/deny list', () => {
  const files = builderConfig.files ?? []

  it('includes the compiled dist output', () => {
    expect(files).toContain('dist/**/*')
  })

  it('excludes the compiler map and declaration files', () => {
    expect(files).toContain('!dist/**/*.map')
    expect(files).toContain('!dist/**/*.d.ts')
  })

  it('excludes the environment file', () => {
    expect(files.some((f) => f.includes('.env'))).toBe(true)
    expect(files).toContain('!.env')
  })

  it('excludes the local log directory', () => {
    expect(files.some((f) => /!.*logs/.test(f))).toBe(true)
  })

  it('excludes the Windows-service-only dependency (node-windows)', () => {
    expect(files.some((f) => f.includes('!node_modules/node-windows'))).toBe(true)
  })

  it('does not exclude node_modules wholesale (the app still needs its runtime deps)', () => {
    expect(files).toContain('node_modules/**/*')
  })
})

// -- 5. no signing configuration key is present anywhere in the document --

describe('no signing configuration is present anywhere (deliberate, permanent gap this phase)', () => {
  const SIGNING_KEY_PATTERN = /sign|certificate|csc/i

  function collectKeys(value: unknown, keys: string[] = []): string[] {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        keys.push(k)
        collectKeys(v, keys)
      }
    }
    return keys
  }

  it('no key anywhere in electron-builder.json names signing or a certificate', () => {
    const allKeys = collectKeys(builderConfig)
    const offenders = allKeys.filter((k) => SIGNING_KEY_PATTERN.test(k))
    expect(offenders).toEqual([])
  })
})

// -- 6. the three Windows targets, and artifact names with no spaces -------

describe('the Windows target list and artifact naming', () => {
  it('targets exactly the installer, the portable executable and the zip', () => {
    expect(builderConfig.win?.target).toEqual(
      expect.arrayContaining(['nsis', 'portable', 'zip']),
    )
    expect(builderConfig.win?.target).toHaveLength(3)
  })

  it('every configured artifactName template contains no space', () => {
    const templates = [
      builderConfig.win?.artifactName,
      builderConfig.nsis?.artifactName,
      builderConfig.portable?.artifactName,
    ].filter((t): t is string => Boolean(t))
    expect(templates.length).toBeGreaterThan(0)
    for (const template of templates) {
      expect(template).not.toMatch(/\s/)
    }
  })

  it('the installer lets the operator choose an install directory (not one-click)', () => {
    expect(builderConfig.nsis?.oneClick).toBe(false)
    expect(builderConfig.nsis?.allowToChangeInstallationDirectory).toBe(true)
  })
})

// -- 7. the app identifier and product name are set -------------------------

describe('application identity', () => {
  it('appId and productName are both non-empty strings', () => {
    expect(typeof builderConfig.appId).toBe('string')
    expect(builderConfig.appId?.length).toBeGreaterThan(0)
    expect(typeof builderConfig.productName).toBe('string')
    expect(builderConfig.productName?.length).toBeGreaterThan(0)
  })
})

// -- 8. the configured icon exists and is at least 256px square ------------

describe('the configured Windows icon', () => {
  const iconRelPath = builderConfig.win?.icon as string

  it('is configured', () => {
    expect(iconRelPath).toBeTruthy()
  })

  it('exists on disk', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, iconRelPath))).toBe(true)
  })

  it('is at least 256x256, read from the PNG header bytes directly (no image dependency)', () => {
    // PNG signature is 8 bytes; the IHDR chunk immediately follows: 4 bytes
    // length, 4 bytes type "IHDR", then 4 bytes width + 4 bytes height,
    // both big-endian — https://www.w3.org/TR/png/#11IHDR (offsets 16-24).
    const buf = fs.readFileSync(path.join(REPO_ROOT, iconRelPath))
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(buf.subarray(0, 8).equals(pngSignature)).toBe(true)
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    expect(width).toBeGreaterThanOrEqual(256)
    expect(height).toBeGreaterThanOrEqual(256)
  })
})

// -- 9. the built tree (npm run build, which <verify> always runs first) ---
//    actually contains what the file set claims to include ------------------

describe('the built tree matches what the file set claims to ship (post `npm run build`)', () => {
  const distDir = path.join(REPO_ROOT, 'dist')

  it('dist/ exists (the compiler ran)', () => {
    expect(fs.existsSync(distDir)).toBe(true)
  })

  it('the Electron main entry compiled', () => {
    expect(fs.existsSync(path.join(distDir, 'electron', 'main.js'))).toBe(true)
  })

  it('the renderer was copied into dist/renderer (scripts/copy-assets.js)', () => {
    expect(fs.existsSync(path.join(distDir, 'renderer', 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(distDir, 'renderer', 'tray.png'))).toBe(true)
  })

  it('dist/ never contains an environment file (nothing here reads .env into the build output)', () => {
    expect(fs.existsSync(path.join(distDir, '.env'))).toBe(false)
  })
})

// -- 10. the build script itself: run as the invoking user, caches in-repo -

describe('scripts/build-win.sh — the Wine-in-Docker build path (10-RESEARCH R1)', () => {
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'build-win.sh')
  const script = fs.readFileSync(scriptPath, 'utf8')

  it('exists and is executable', () => {
    const mode = fs.statSync(scriptPath).mode
    // eslint-disable-next-line no-bitwise
    expect(mode & 0o111).not.toBe(0)
  })

  it('compiles on the host before packaging (build:win never skips npm run build)', () => {
    expect(script).toMatch(/npm run build/)
  })

  it('runs the packaging step inside the packaging project\'s own Wine image', () => {
    expect(script).toMatch(/electronuserland\/builder:wine/)
  })

  it('runs the container as the invoking user, not root', () => {
    expect(script).toMatch(/-u\s+"\$\(id -u\):\$\(id -g\)"/)
  })

  it('points the tool\'s caches inside the repository', () => {
    expect(script).toMatch(/ELECTRON_CACHE=.*\.electron-builder-cache/)
    expect(script).toMatch(/ELECTRON_BUILDER_CACHE=.*\.electron-builder-cache/)
    expect(script).toMatch(/HOME=.*\.electron-builder-cache/)
  })

  it('switches automatic signing-identity discovery off explicitly', () => {
    expect(script).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY=false/)
  })

  it('mounts the repository directly rather than reinstalling dependencies inside the container', () => {
    // Strip comment lines first — the rationale prose above legitimately
    // says the word "install" (explaining why a real install step isn't
    // run); a bare substring match on the whole file would be satisfied by
    // that sentence even if a real `npm install`/`npm ci` command were later
    // added to the container's command line. Only a non-comment line
    // actually invoking one of those commands should fail this.
    const codeLines = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(codeLines).not.toMatch(/\bnpm (install|ci)\b/)
    expect(script).toMatch(/-v\s+"\$REPO_ROOT":\/project/)
  })

  it('records the resolved image digest into the output directory', () => {
    expect(script).toMatch(/IMAGE_DIGEST/)
    expect(script).toMatch(/builder-image-digest/)
  })

  it('keeps the documented named-volume fallback recipe as a comment', () => {
    expect(script).toMatch(/node-modules/)
    expect(script).toMatch(/#\s+docker run --rm/)
  })
})

// -- 11. the ignore file covers the new build output and in-repo caches ----

describe('.gitignore covers the packaging output and caches', () => {
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')

  it('ignores the electron-builder output directory', () => {
    expect(gitignore).toMatch(/^release\/$/m)
  })

  it('ignores the in-repository electron-builder caches', () => {
    expect(gitignore).toMatch(/^\.electron-builder-cache\/$/m)
  })
})
