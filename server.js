import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importArticle } from './article.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

http.createServer(async (request, response) => {
  const fail = (status, message) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: message }));
  };
  if (request.url === '/api/import' && request.method === 'POST') {
    let body = '';
    try {
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4096) return fail(413, 'The request is too large.');
      }
      const url = JSON.parse(body).url;
      if (typeof url !== 'string') return fail(400, 'Enter an article URL.');
      const article = await importArticle(url);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(article));
    } catch (error) { fail(400, error.message || 'The article could not be imported.'); }
    return;
  }
  if (request.url?.startsWith('/api/')) return fail(404, 'Not found.');
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed.');
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { return fail(400, 'Invalid path.'); }
  const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + path.sep)) return fail(403, 'Forbidden.');
  try {
    if (!(await stat(file)).isFile()) return fail(404, 'Not found.');
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch { fail(404, 'Not found.'); }
}).listen(port, '127.0.0.1', () => console.log(`Kornu Web: http://127.0.0.1:${port}`));
