// src/server.js
const app = require('./app');
const config = require('./config/env');
const logger = require('./utils/logger');
const { checkBcEndpoints } = require('./data/adapters/bcEndpoints');

/**
 * Plain HTTP on an internal port — Apache (mod_ssl + mod_proxy) sits in
 * front on 6443 (training) / 7443 (production) and terminates TLS. See
 * deploy/README.md for the vhost config. Node never touches certificates
 * directly in this deployment.
 */
const server = app.listen(config.port, '127.0.0.1', () => {
  logger.info(`KIMS-WM middleware [${config.env}] listening on 127.0.0.1:${config.port} (data source: ${config.dataSource})`);
  // Which Business Central address(es) answer — one log line each, and the
  // first that answers is the one used. Never stops the server: an address
  // that is down now is tried again on the next call.
  if (config.businessCentralInUse) {
    checkBcEndpoints(config.businessCentral).catch((err) => logger.warn({ err }, 'Business Central address check failed'));
  }
});

// Fail loudly and exit rather than limping along in a broken state — the
// same "no error slips through silently" principle as the Flutter app's
// global error zone, applied on the server side. A process manager
// (systemd/PM2) is expected to restart the service after a crash.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection — shutting down');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});

module.exports = server;