// COMPANY_OS panel — крохотный статический сервер (без npm-зависимостей).
// Слушает process.env.PORT (правило со-сервера 178). Отдаёт SPA из ./public
// и генерит /config.js из env (SUPABASE_URL + SUPABASE_ANON_KEY) — значения приходят в env заявки
// деплоя, НЕ в git. anon-ключ безопасен с RLS.
// HTTPS: если есть self-signed сертификат (./certs, генерится в Dockerfile) — поднимаемся по TLS
// (self-serve HTTPS для внутреннего инструмента, без общего Caddy). Иначе — обычный HTTP.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8130;
const PUBLIC = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const handler = (req, res) => {
  const url = req.url.split('?')[0];

  // Конфиг для браузера — из env, не из git.
  if (url === '/config.js') {
    const cfg = { SUPABASE_URL: process.env.SUPABASE_URL || '', SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '' };
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('window.COMPANY_OS_CONFIG = ' + JSON.stringify(cfg) + ';');
  }
  // Health для мониторинга/диспетчера.
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }

  let file = path.join(PUBLIC, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); } // защита от traversal
  fs.readFile(file, (err, data) => {
    if (err) { // SPA-fallback на index.html
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(idx);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
};

// Self-signed TLS, если сертификат собран в образе.
let tls = null;
try {
  tls = { key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')), cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')) };
} catch (e) { tls = null; }

const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
server.listen(PORT, () => console.log((tls ? 'HTTPS' : 'HTTP') + ' COMPANY_OS panel on ' + PORT));
