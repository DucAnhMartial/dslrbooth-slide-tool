// Windows Service installer for dslrBooth Agent
// Usage: node service/install-service.js [install|uninstall]
require('dotenv').config()

const Service = require('node-windows').Service
const path = require('path')
const fs = require('fs')

const projectRoot = path.join(__dirname, '..')
const exePath = path.join(projectRoot, 'dslrbooth-agent.exe')
const jsPath = path.join(projectRoot, 'dist', 'index.js')

// Prefer .exe if built, otherwise use .js (dev mode)
const scriptPath = fs.existsSync(exePath) ? exePath : jsPath
const useExe = fs.existsSync(exePath)

console.log(`Using script: ${scriptPath} (${useExe ? 'EXE' : 'JS'})`)

const svc = new Service({
  name: 'dslrBooth Agent',
  description: 'Relay agent between dslrBooth Local API and Extension Service',
  script: scriptPath,
  nodeOptions: useExe ? [] : ['-r', 'dotenv/config'],  // EXE has dotenv baked in
  env: [
    { name: 'EXTENSION_SERVICE_WS_URL', value: process.env.EXTENSION_SERVICE_WS_URL || '' },
    { name: 'DSLRBOOTH_API_PORT', value: process.env.DSLRBOOTH_API_PORT || '1500' },
    { name: 'DSLRBOOTH_PASSWORD', value: process.env.DSLRBOOTH_PASSWORD || '' },
    { name: 'TRIGGER_SERVER_PORT', value: process.env.TRIGGER_SERVER_PORT || '3001' },
    { name: 'LOG_LEVEL', value: process.env.LOG_LEVEL || 'info' },
    { name: 'LOG_DIR', value: process.env.LOG_DIR || 'logs' },
  ],
  workingDirectory: projectRoot,
  wait: 5,
  grow: 0.25,
  maxRetries: 3,
})

const action = process.argv[2] || 'install'

if (action === 'uninstall') {
  svc.on('uninstall', () => {
    console.log('Service uninstalled successfully')
  })
  svc.uninstall()
} else {
  svc.on('install', () => {
    console.log('Service installed successfully')
    console.log('Starting service...')
    svc.start()
  })

  svc.on('alreadyinstalled', () => {
    console.log('Service already installed')
  })

  svc.on('start', () => {
    console.log('Service started successfully')
  })

  svc.on('error', (err) => {
    console.error('Service error:', err)
  })

  svc.install()
}