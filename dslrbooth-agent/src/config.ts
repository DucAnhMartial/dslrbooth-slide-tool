export interface Config {
  extensionServiceWsUrl: string
  extensionServiceWsToken: string
  dslrBoothApiPort: number
  dslrBoothPassword: string
  triggerServerPort: number
  logLevel: string
  logDir: string
  autoOpenDisplay: boolean
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env: ${name}`)
  }
  return value
}

export function loadConfig(): Config {
  const dslrBoothPassword = requiredEnv('DSLRBOOTH_PASSWORD')
  const extensionServiceWsToken = requiredEnv('EXTENSION_SERVICE_WS_TOKEN')

  return {
    extensionServiceWsUrl: requiredEnv('EXTENSION_SERVICE_WS_URL'),
    extensionServiceWsToken,
    dslrBoothApiPort: parseInt(process.env.DSLRBOOTH_API_PORT || '1500', 10),
    dslrBoothPassword,
    triggerServerPort: parseInt(process.env.TRIGGER_SERVER_PORT || '3001', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    logDir: process.env.LOG_DIR || 'logs',
    autoOpenDisplay: !['false', '0', 'no'].includes((process.env.AUTO_OPEN_DISPLAY || 'true').toLowerCase()),
  }
}
