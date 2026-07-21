const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const fs = require('fs-extra');

dotenv.config();

const app = express();

app.set('etag', false);

const { PORT, HOST, NODE_ENV, DOWNLOAD_DIR, TEMP_DIR, LOG_DIR } = process.env;

fs.ensureDirSync(path.resolve(DOWNLOAD_DIR || 'server/downloads'));
fs.ensureDirSync(path.resolve(TEMP_DIR || 'server/temp'));
fs.ensureDirSync(path.resolve(LOG_DIR || 'server/logs'));

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      imgSrc: ["'self'", 'https:', 'data:'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
    },
  },
}));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors({ origin: true, credentials: true }));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('ETag', '');
  next();
});

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.RATE_LIMIT_MAX || 100),
  // Status polling is frequent during local downloads; rate limiting belongs
  // on a public deployment, not the local development experience.
  skip: () => NODE_ENV !== 'production',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use(express.static(path.join(__dirname, '..', 'client')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', require('./routes/api'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

module.exports = app;
