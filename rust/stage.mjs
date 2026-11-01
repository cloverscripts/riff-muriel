// Copies Muriel's web UI into dist/ (what the window shows) and its Node backend into backend/ (the sidecar
// main.rs starts), straight from the repo root, so the Rust app always runs the current Muriel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(here, 'dist');
const backend = path.join(here, 'backend');

const copy = (rel, to) => {
  const src = path.join(root, rel);
  const dst = path.join(to, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
};

// UI: index.html and every local file it references, plus the folders loaded at runtime
fs.rmSync(dist, { recursive: true, force: true });
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const refs = new Set(['index.html', 'assets', 'vendor']);
for (const m of html.matchAll(/(?:src|href)="([^"#:?]+)"/g)) {
  const top = m[1].replace(/^\.\//, '').split('/')[0];
  if (top && fs.existsSync(path.join(root, top))) refs.add(top);
}
for (const r of refs) if (fs.existsSync(path.join(root, r))) copy(r, dist);

// backend: server.js and everything it requires (no npm packages), plus the sidecar entry
const keep = fs.existsSync(path.join(backend, 'node.exe')) ? fs.readFileSync(path.join(backend, 'node.exe')) : null;
fs.rmSync(backend, { recursive: true, force: true });
fs.mkdirSync(backend, { recursive: true });
const seen = new Set();
const walk = (rel) => {
  if (seen.has(rel)) return;
  seen.add(rel);
  copy(rel, backend);
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    let p = path.join(path.dirname(rel), m[1]);
    if (!/\.(js|json)$/.test(p)) p += '.js';
    if (p.endsWith('.js') && fs.existsSync(path.join(root, p))) walk(p);
  }
};
walk('server.js');
fs.copyFileSync(path.join(here, 'backend-entry.js'), path.join(backend, 'entry.js'));
if (keep) fs.writeFileSync(path.join(backend, 'node.exe'), keep);
console.log(`staged ${refs.size} UI entries, ${seen.size} backend files`);
