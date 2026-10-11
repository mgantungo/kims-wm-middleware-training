// src/data/dataSourceFactory.js
const config = require('../config/env');
const demoDataSource = require('./adapters/demoDataSource');
const BusinessCentralDataSource = require('./adapters/businessCentralDataSource');
const HybridDataSource = require('./adapters/hybridDataSource');
const logger = require('../utils/logger');

/**
 * The one place that decides which adapter every module talks to. Every
 * controller imports `dataSource` from here — never a specific adapter
 * file directly — so DATA_SOURCE in .env is genuinely the only thing that
 * needs to change to move data sources around.
 *
 * Three modes:
 *   demo            — everything in-memory demo data (default).
 *   businessCentral — EVERYTHING routed to Business Central at once. Only
 *                     safe once every module's methods are actually
 *                     implemented there — currently breaks every module
 *                     except Put Away's read path (see
 *                     businessCentralDataSource.js's class doc).
 *   hybrid          — the real mid-rollout mode: routes individual methods
 *                     to Business Central per their own config flag (see
 *                     hybridDataSource.js), demo for everything else.
 *                     This is what a genuinely phased integration should
 *                     run on, not businessCentral directly, until every
 *                     module has actually been migrated.
 */
let dataSource;

if (config.dataSource === 'businessCentral') {
  logger.info('Data source: Business Central');
  dataSource = new BusinessCentralDataSource(config.businessCentral);
} else if (config.dataSource === 'hybrid') {
  logger.info(
    `Data source: hybrid (Put Away reads: ${config.putAwayReadSource}, Put Away confirm: ${config.putAwayConfirmSource}, ` +
      `Put Away split: ${config.putAwaySplitSource}, Bin Inquiry: ${config.binInquirySource}, ` +
      `Pick reads: ${config.pickReadSource}, Pick confirm: ${config.pickConfirmSource}, ` +
      `Item Inquiry: ${config.itemInquirySource})`,
  );
  dataSource = new HybridDataSource({
    businessCentralConfig: config.businessCentral,
    putAwayReadSource: config.putAwayReadSource,
    putAwayConfirmSource: config.putAwayConfirmSource,
    putAwaySplitSource: config.putAwaySplitSource,
    binInquirySource: config.binInquirySource,
    pickReadSource: config.pickReadSource,
    pickConfirmSource: config.pickConfirmSource,
    itemInquirySource: config.itemInquirySource,
  });
} else {
  logger.info('Data source: demo (in-memory)');
  dataSource = demoDataSource;
}

module.exports = dataSource;