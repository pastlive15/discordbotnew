// utils/logger.js
const pino = require('pino');

// Pretty-print in dev
const transport =
  process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      }
    : undefined;

const logger = pino({ level: process.env.LOG_LEVEL || 'info' }, transport);

module.exports = logger;
