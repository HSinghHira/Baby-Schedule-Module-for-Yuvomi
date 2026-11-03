/**
 * Baby Schedule sidecar for Yuvomi.
 *
 * Runs beside Yuvomi, is served on the same origin under
 * /api/extensions/baby-schedule/ by the reverse proxy, and keeps the
 * household's weekly baby schedule in its own SQLite database.
 */

import http from 'node:http';
import { loadConfig } from './config.js';
import { openDatabase, createRepository } from './db.js';
import { createIdentityResolver } from './identity.js';
import { createApp } from './app.js';
import { createTaskBridge } from './bridge.js';

const config = loadConfig();
const db = openDatabase(config.dbFile);
const repo = createRepository(db, config.household);
const identity = createIdentityResolver({
  yuvomiUrl: config.yuvomiUrl,
  cacheSeconds: config.authCacheSeconds,
  timeoutMs: config.authTimeoutMs,
});
const bridge = createTaskBridge({ repo, yuvomiUrl: config.yuvomiUrl });
const handle = createApp({ config, repo, identity, bridge });
bridge.start(30000);

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[baby-schedule] request failed', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"Internal error","code":500,"reason":"server_error"}');
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 65000;

server.listen(config.port, config.host, () => {
  console.log(`[baby-schedule] listening on ${config.host}:${config.port}; Yuvomi at ${config.yuvomiUrl}; database ${config.dbFile}`);
});

function shutdown(signal) {
  console.log(`[baby-schedule] ${signal} received, shutting down`);
  bridge.stop();
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
