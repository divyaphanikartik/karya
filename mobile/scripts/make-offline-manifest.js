// After `expo export`: list every built script/asset for the service worker to save (precache.json), and stamp
// the build id into sw.js so a new deploy installs a new copy. Usage: node scripts/make-offline-manifest.js <dist>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.resolve(process.argv[2] || 'dist');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
for (const folder of ['_expo', 'assets']) if (fs.existsSync(path.join(dist, folder))) walk(path.join(dist, folder));
const urls = files.map((f) => '/' + path.relative(dist, f).split(path.sep).map(encodeURIComponent).join('/')).sort();
if (fs.existsSync(path.join(dist, 'favicon.ico'))) urls.push('/favicon.ico');
const hash = crypto.createHash('md5');
for (const f of files) hash.update(f).update(String(fs.statSync(f).size));
const version = hash.digest('hex').slice(0, 12);

fs.writeFileSync(path.join(dist, 'precache.json'), JSON.stringify({ version, files: urls }));
const sw = path.join(dist, 'sw.js');
if (!fs.existsSync(sw)) throw new Error(`${sw} is missing: expected the service worker from public/`);
const source = fs.readFileSync(sw, 'utf8');
if (!source.includes("'__BUILD__'")) throw new Error('sw.js has no __BUILD__ placeholder to stamp');
fs.writeFileSync(sw, source.replace("'__BUILD__'", `'${version}'`));
console.log(`offline manifest: ${urls.length} files, version ${version}`);
