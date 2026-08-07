'use strict';
/**
 * routes/admin.js — Protected admin endpoints
 *
 * POST /admin/backfill-recordings — pull call recordings from the Telnyx API
 *                                   into call_logs (idempotent).
 *
 * Auth: Authorization: Bearer <INBOX_PASSWORD>
 */

const { backfillRecordings } = require('../scripts/backfill-recordings');

function requireAdmin(req, res, next) {
  const auth     = req.headers['authorization'] || '';
  const password = process.env.INBOX_PASSWORD;
  if (!password) return next(); // no password set — allow (dev mode)
  const token = auth.replace('Bearer ', '').trim();
  if (token !== password) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

module.exports = () => {
  const router = require('express').Router();

  router.post('/backfill-recordings', requireAdmin, async (req, res) => {
    console.log('[ADMIN] Starting recording backfill from Telnyx API');
    try {
      const result = await backfillRecordings();
      console.log('[ADMIN] Recording backfill complete:', result);
      res.json({ status: 'done', ...result });
    } catch (err) {
      console.error('[ADMIN] Recording backfill error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
