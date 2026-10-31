// Offline static server for the deck, with HTTP Range support (kept from the SDTH deck).
// Usage: node tools/serve.mjs [port]   (default 4173), then open http://localhost:<port>/
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = resolve(join(root, p));
  if (!(f === root || f.startsWith(root + sep)) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const size = statSync(f).size, type = types[extname(f)] || 'application/octet-stream';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
    const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : m[1] ? size - 1 : size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache' });
    return createReadStream(f, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': 'no-cache' });
  createReadStream(f).pipe(res);
});
// Take the first free port from the one asked for (another copy of the deck may already hold it).
(function listen(p, tries) {
  const onListening = () => {
    console.log(`Triage stack deck: http://localhost:${p}/  (press P or the Present button for the audience tab; Ctrl+C to stop)`);
    if (process.env.DECK_OPEN) import('node:child_process').then(({ exec }) => exec(`open http://localhost:${p}/`));
  };
  server.once('error', e => {
    server.removeListener('listening', onListening);
    if (e.code === 'EADDRINUSE' && tries > 0) listen(p + 1, tries - 1); else throw e;
  });
  server.once('listening', onListening);
  server.listen(p, '127.0.0.1');
})(port, 10);
