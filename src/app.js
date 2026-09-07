// src/app.js
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');

const config = require('./config/env');
const logger = require('./utils/logger');
const requireAuth = require('./middleware/requireAuth');
const environmentGuard = require('./middleware/environmentGuard');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const authRoutes = require('./auth/authRoutes');
const putAwayRoutes = require('./modules/putAway/putAway.routes');
const pickRoutes = require('./modules/pick/pick.routes');
const verifyPackRoutes = require('./modules/verifyPack/verifyPack.routes');
const shipRoutes = require('./modules/ship/ship.routes');
const gatePassRoutes = require('./modules/gatePass/gatePass.routes');
const inquiryRoutes = require('./modules/inquiry/inquiry.routes');
const scanLoggingRoutes = require('./modules/scanLogging/scanLogging.routes');
const transferRoutes = require('./modules/transfer/transfer.routes');
const quarantineRoutes = require('./modules/quarantine/quarantine.routes');

const app = express();

// Trust the Apache reverse proxy in front of this process (correct client
// IPs in logs, correct protocol detection for rate limiting, etc).
app.set('trust proxy', 1);

app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(pinoHttp({ logger }));

// Generous but real ceiling — protects the demo/BC backend from a runaway
// client (e.g. a device stuck retrying in a tight loop) without getting in
// the way of normal warehouse-floor scanning traffic.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(environmentGuard);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: config.env, dataSource: config.dataSource, time: new Date().toISOString() });
});

// Auth is the only unauthenticated route group.
app.use('/auth', authRoutes);

// Everything below requires a valid Bearer token.
app.use('/put-away', requireAuth, putAwayRoutes);
app.use('/pick/verify', requireAuth, verifyPackRoutes);
app.use('/pick', requireAuth, pickRoutes);
app.use('/ship', requireAuth, shipRoutes);
app.use('/gate-pass', requireAuth, gatePassRoutes);
app.use('/inquiry', requireAuth, inquiryRoutes);
app.use('/scan-logging', requireAuth, scanLoggingRoutes);
app.use('/transfer', requireAuth, transferRoutes);
app.use('/quarantine', requireAuth, quarantineRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;