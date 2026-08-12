require('dotenv').config();
// Before ./db or ./push-notify: both throw from inside a dependency when their
// configuration is missing, which reads only as "service unavailable" on the
// deployment platform. This turns that into a named list of variables.
require('./lib/startup-check')();
const express      = require('express');
const cookieSession = require('cookie-session');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const path    = require('path');
const { verifyConnection } = require('./db');
const { reportVoiceConfig } = require('./lib/voice-preflight');
require('./push-notify'); // initialises VAPID on startup

const app = express();

const sseClients = new Set();
function broadcastSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(data); } catch { sseClients.delete(client); }
  });
}
require('./lib/broadcaster').setBroadcast(broadcastSSE);

app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = ['http://localhost:3000', process.env.APP_URL].filter(Boolean);
    if (allowed.includes(origin) || origin.endsWith('.up.railway.app')) return cb(null, true);
    cb(null, true);
  },
  credentials: true
}));

app.set('trust proxy', 1);

// Raw body for HMAC signature verification on the Telnyx messaging webhook
app.use('/webhook/telnyx',  express.raw({ type: 'application/json' }));
// Voice Call Control webhook — must be raw before the global express.json() runs
app.use('/webhooks/voice',  express.raw({ type: 'application/json' }));

// Image uploads arrive as base64 JSON — needs a higher limit than the default 100kb
app.use('/api/upload', express.json({ limit: '8mb' }));
app.use(express.json());

// Cookie-session: signed client-side cookie — survives Railway restarts/redeploys.
// Session only stores { authenticated: true } so cookie stays tiny (<100 bytes).
app.use(cookieSession({
  name:   'shore_sess',
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-this',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 30 * 24 * 60 * 60 * 1000  // 30 days
}));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  return res.status(401).json({ error: 'Unauthorised' });
}

const sendLimiter = rateLimit({
  windowMs: 60000,
  max: 20,
  message: { error: 'Too many messages, slow down' }
});

// ── Webhooks (no auth middleware — each verifies its own caller) ───────────
app.use('/webhook', require('./routes/webhook')(broadcastSSE));
// GHL workflow "new contact" webhook — secret lives in the URL path
app.use('/webhook', express.json(), require('./routes/webhook-ghl-contact')(broadcastSSE));
// GHL workflow "send SMS" webhook — secret via header/body/query
app.use('/webhook', express.json(), require('./routes/webhook-send')(broadcastSSE));

// ── Auth ──────────────────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));

// ── Admin (protected by INBOX_PASSWORD) ───────────────────────────────────
app.use('/admin', require('./routes/admin')());

// ── Authenticated API routes ──────────────────────────────────────────────
app.use('/api/sse',           requireAuth, require('./routes/sse')(sseClients));
app.use('/api/send',          requireAuth, sendLimiter, require('./routes/send')(broadcastSSE));
app.use('/api/upload',        requireAuth, require('./routes/upload'));
app.use('/api/react',         requireAuth, sendLimiter, require('./routes/react')(broadcastSSE));
app.use('/api/conversations', requireAuth, require('./routes/conversations'));
app.use('/api/contacts',      requireAuth, require('./routes/contacts'));
app.use('/api/push',          requireAuth, require('./routes/push')());
app.use('/api/mobile-push',   requireAuth, require('./routes/mobile-push')());
app.use('/api/voice',         requireAuth, require('./routes/voice'));

// Voice webhooks (public — Telnyx calls this directly)
app.use('/webhooks/voice', require('./routes/voice-webhook'));

// Answers 200 even when the database is unreachable, and says so in the body.
// A deploy that fails its health check is rolled away along with its logs, so
// the platform never shows why. Reporting "degraded" keeps the container up
// and the cause readable.
let databaseReady = false;
app.get('/health', (req, res) => {
  res.json({
    status: databaseReady ? 'ok' : 'degraded',
    database: databaseReady ? 'connected' : 'unreachable',
    uptime: Math.floor(process.uptime()),
    ts: new Date().toISOString()
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
// 0.0.0.0 explicitly: the container's health check reaches the process from
// outside, so binding only to loopback would look identical to a crash.
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Shore Academy Inbox listening on 0.0.0.0:${PORT}`);
  databaseReady = await verifyConnection();
  console.log(`Telnyx: ${process.env.TELNYX_PHONE_NUMBER}`);
  console.log(`GHL: ${process.env.GHL_PIT ? 'configured' : 'NOT configured'}`);
  console.log('Automations: none — all marketing automation lives in GoHighLevel');

  // Says whether Telnyx can actually place a call, rather than leaving it to
  // be discovered by one failing. Advisory: never blocks or crashes startup.
  reportVoiceConfig();
});

module.exports = { app, broadcastSSE };
