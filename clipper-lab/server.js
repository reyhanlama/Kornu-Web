import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4185);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/' || pathname === '/clipper-lab') {
    response.writeHead(302, { Location: '/clipper-lab/' }).end();
    return;
  }
  const relative = pathname === '/clipper-lab/' ? 'clipper-lab/index.html' : pathname.slice(1);
  if (!relative.startsWith('clipper-lab/') && !relative.startsWith('extension/')) {
    response.writeHead(404).end();
    return;
  }
  const folder = relative.startsWith('clipper-lab/') ? resolve(root, 'clipper-lab') : resolve(root, 'extension');
  const file = resolve(root, relative);
  if (file !== folder && !file.startsWith(`${folder}${sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(file);
    const extension = file.slice(file.lastIndexOf('.'));
    response.writeHead(200, { 'Content-Type': `${types[extension] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Clipper preview: http://127.0.0.1:${port}/clipper-lab/`));
