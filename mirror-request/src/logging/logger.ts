import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getConfig } from '../config';

const config = getConfig();

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+?\d{7,}/g;

export function mask(value: string): string {
  return value
    .replace(PHONE_RE, m => '*'.repeat(m.length))
    .replace(EMAIL_RE, '[EMAIL REDACTED]');
}

const formatFile = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ level, message, label, stack }) => {
    const masked = typeof message === 'string' ? mask(message) : message;
    const meta = label ? ` [${label}]` : '';
    const s = stack ? `\n${stack}` : '';
    return `${level}${meta}: ${masked}${s}`;
  })
);

const fileTransport = new DailyRotateFile({
  filename: 'logs/extension-service-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  format: formatFile,
});

const formatConsole = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, label, stack }) => {
    const masked = typeof message === 'string' ? mask(message) : message;
    const prefix = label ? `[${label}]` : '';
    const s = stack ? `\n${stack}` : '';
    return `${level} ${prefix}${masked}${s}`;
  })
);

export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat(),
  ),
  transports: [fileTransport],
  exitOnError: false,
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: formatConsole }));
}

export function labelLogger(name: string) {
  return logger.child({ label: name });
}

export default logger;
