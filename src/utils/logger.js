const pino = require('pino');
const config = require('../config/env');

/**
 * One logger instance for the whole service. Nothing else calls
 * console.log directly — same principle as the Flutter app's AppLog: every
 * log line is structured, filterable, and easy to ship to a log aggregator
 * later without touching call sites.
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { env: config.env },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

module.exports = logger;
