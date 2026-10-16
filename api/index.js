'use strict';
// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
const { handle } = require('../lib/api');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const url = new URL(req.url, 'http://x');
  const query = Object.fromEntries(url.searchParams.entries());
  let body = {};
  if (req.method === 'POST') {
    body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
    if (!body || typeof body !== 'object') body = {};
  }
  const out = await handle(req.method, url.pathname, query, body);
  res.statusCode = out.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out.body));
};
