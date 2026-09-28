// PC에서 미리 확인할 때 쓰는 간단한 로컬 서버: node server.js → http://localhost:8080 (web 폴더를 제공)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

// 배포용 _redirects 와 같은 규칙
function resolve(urlPath) {
  if (urlPath === '/') return 'index.html';
  if (urlPath === '/kiosk') return 'kiosk.html';
  if (urlPath === '/admin') return 'admin.html';
  if (urlPath.startsWith('/s/')) return 's.html';
  return urlPath;
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, resolve(urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`웨이팅 앱: http://localhost:${PORT}`));
