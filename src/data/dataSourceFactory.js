const config = require('../config/env');
const demoDataSource = require('./adapters/demoDataSource');
const BusinessCentralDataSource = require('./adapters/businessCentralDataSource');
const logger = require('../utils/logger');

/**
 * The one place that decides which adapter every module talks to. Every
 * controller imports `dataSource` from here — never a specific adapter
 * file directly — so DATA_SOURCE in .env is genuinely the only thing that
 * needs to change to move from demo data to live Business Central.
 */
let dataSource;

if (config.dataSource === 'businessCentral') {
  logger.info('Data source: Business Central');
  dataSource = new BusinessCentralDataSource(config.businessCentral);
} else {
  logger.info('Data source: demo (in-memory)');
  dataSource = demoDataSource;
}

module.exports = dataSource;
