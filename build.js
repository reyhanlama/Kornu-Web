import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.KORNU_SUPABASE_URL?.trim() || '';
const key = process.env.KORNU_SUPABASE_PUBLISHABLE_KEY?.trim() || '';
if (Boolean(url) !== Boolean(key)) {
  throw new Error('Set both KORNU_SUPABASE_URL and KORNU_SUPABASE_PUBLISHABLE_KEY, or neither.');
}
if (url && new URL(url).protocol !== 'https:') {
  throw new Error('KORNU_SUPABASE_URL must use HTTPS.');
}

await mkdir('public/vendor', { recursive: true });
await build({
  entryPoints: ['src/supabase-client.js'],
  outfile: 'public/vendor/supabase-client.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true
});
await build({
  entryPoints: { 'book-view': 'src/book-view.js' },
  outdir: 'public/ebook',
  bundle: true,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true
});
await writeFile('public/config.js', `export const cloudConfig = ${JSON.stringify({ url, key })};\n`);
console.log(url ? 'Kornu account client is configured.' : 'Kornu is ready in browser-only mode.');
