import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { Config } from '../config'

const { combine, timestamp, printf, errors } = winston.format

const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`
})

export function createLogger(config: Config): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: combine(timestamp(), errors({ stack: true }), logFormat),
      level: config.logLevel,
    }),
    new DailyRotateFile({
      filename: `${config.logDir}/app-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '10m',
      maxFiles: '14d',
      level: config.logLevel,
      format: combine(timestamp(), errors({ stack: true }), logFormat),
    }),
  ]

  return winston.createLogger({ transports })
}

export type Logger = winston.Logger
