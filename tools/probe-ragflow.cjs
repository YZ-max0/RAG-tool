
const http = require('http');
const key = process.env.RAGFLOW_API_KEY || '';
const base = process.env.RAGFLOW_BASE_URL || 'http://localhost:8060';
function get(p) {
  return new Promise((res, rej) => {
    const u = new URL(base + p);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + key }, timeout: 20000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
  });
}
(async () => {
  console.log('keyLen=' + key.length + ' base=' + base);
  const r = await get('/api/v1/datasets?page=1&page_size=100');
  const j = JSON.parse(r.body);
  console.log('status=' + r.status + ' code=' + j.code + ' count=' + (j.data || []).length);
  for (const d of (j.data || [])) console.log(JSON.stringify({ id: d.id, name: d.name, chunk_count: d.chunk_count, doc: d.document_count }));
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
