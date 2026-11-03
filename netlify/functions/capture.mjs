import { importArticle, importImage } from '../../article.js';

const headers = { 'Cache-Control': 'no-store' };
const json = (value, status = 200) => Response.json(value, { status, headers });

export default async function capture(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (Number(request.headers.get('content-length')) > 4096) return json({ error: 'The request is too large.' }, 413);

  let url;
  try {
    const body = await request.text();
    if (body.length > 4096) return json({ error: 'The request is too large.' }, 413);
    url = JSON.parse(body).url;
    if (typeof url !== 'string') return json({ error: 'Enter an article URL.' }, 400);
  } catch {
    return json({ error: 'Enter an article URL.' }, 400);
  }

  try {
    if (new URL(request.url).pathname === '/api/asset') {
      const asset = await importImage(url);
      return new Response(asset.bytes, { headers: { ...headers, 'Content-Type': asset.mime } });
    }
    return json(await importArticle(url));
  } catch (error) {
    return json({ error: error.message || 'The article could not be imported.' }, 400);
  }
}

export const config = {
  path: ['/api/import', '/api/asset'],
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] }
};
