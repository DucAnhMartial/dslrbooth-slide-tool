import { ChildProcess, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { Logger } from '../logging/logger'

let displayProcess: ChildProcess | null = null

export function openDisplayWindow(port: number, logger: Logger): void {
  if (process.platform !== 'win32') {
    logger.debug('Display auto-open skipped: Windows only')
    return
  }

  const url = `http://127.0.0.1:${port}/display`
  const edgeCandidates = [
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(candidate => candidate && fs.existsSync(candidate))

  try {
    if (edgeCandidates[0]) {
      if (displayProcess && displayProcess.exitCode === null) return
      const profileDir = path.join(process.env.TEMP || process.cwd(), 'dslrbooth-agent-display')
      const child = spawn(edgeCandidates[0], [
        '--kiosk',
        url,
        '--edge-kiosk-type=fullscreen',
        '--no-first-run',
        `--user-data-dir=${profileDir}`,
      ], { stdio: 'ignore' })
      displayProcess = child
      child.once('exit', () => {
        if (displayProcess === child) displayProcess = null
      })
      logger.info(`Display opened in Edge kiosk mode: ${url}`)
      return
    }

    logger.error('Microsoft Edge not found; cannot safely show and auto-hide the guest display')
  } catch (err) {
    logger.error(`Failed to auto-open display: ${(err as Error).message}`)
  }
}

export function closeDisplayWindow(logger: Logger): Promise<void> {
  const pid = displayProcess?.pid
  displayProcess = null
  if (process.platform !== 'win32' || !pid) return Promise.resolve()

  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.once('error', (err) => {
      logger.warn(`Failed to close display window: ${err.message}`)
      resolve()
    })
    killer.once('exit', () => {
      logger.info('Display hidden; returning control to dslrBooth')
      resolve()
    })
  })
}
