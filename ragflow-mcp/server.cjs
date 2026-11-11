#!/usr/bin/env node
// RAGFlow MCP bridge - zero dependency, newline-delimited JSON-RPC over stdio.
// Speaks MCP to DSH, calls RAGFlow REST (/api/v1/retrieval, /api/v1/datasets).

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.RAGFLOW_BASE_URL || 'http://localhost:8060';

// Resolve the API key from a file, a process env var, or the Windows user
// registry. Third-party MCP clients (Codex, OpenCode, Claude Desktop) spawn
// this bridge themselves and do not forward the DSH process environment, so a
// bare process.env read leaves them unauthenticated.
function resolveApiKey() {
  if (process.env.RAGFLOW_API_KEY) return process.env.RAGFLOW_API_KEY;
  const fromFile = readKeyFile();
  if (fromFile) return fromFile;
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'RAGFLOW_API_KEY'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true
      });
      const m = out.match(/RAGFLOW_API_KEY\s+REG_SZ\s+(.+)/);
      if (m) return m[1].trim();
    } catch { /* not present in the user registry */ }
  }
  return '';
}

function readKeyFile() {
  const candidates = [
    path.join(__dirname, 'ragflow-key.txt'),
    path.join(dshHome(), 'ragflow-key.txt')
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    } catch { /* try the next candidate */ }
  }
  return '';
}
const SERVER = { name: 'ragflow', version: '1.0.0' };
const PROTOCOL = '2025-06-18';

// ── Knowledge-base selection written by the @local/dsh-ragflow-settings page ──
// The settings card persists the ticked datasets to <DSH_HOME>/ragflow-settings.json.
// Read it on every retrieval so a change in the UI takes effect without restarting
// this bridge. Absent or empty selection keeps the original behavior: all datasets.
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

function selectionFilePath() {
  return path.join(dshHome(), 'ragflow-settings.json');
}

// @returns {{ datasetIds: string[], source: string, error: string|null }}
function readSelection() {
  const file = selectionFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { datasetIds: [], source: file, error: null };
    return { datasetIds: [], source: file, error: String((e && e.message) || e) };
  }
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed && parsed.datasetIds) ? parsed.datasetIds : [];
    return { datasetIds: list.filter((id) => typeof id === 'string' && id.length > 0), source: file, error: null };
  } catch (e) {
    return { datasetIds: [], source: file, error: 'unreadable JSON: ' + String((e && e.message) || e) };
  }
}

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const key = resolveApiKey();
  if (!key) {
    reject(new Error('RAGFLOW_API_KEY is not set: provide it in the environment, in ragflow-key.txt beside server.cjs, or as a Windows user environment variable.'));
    return;
  }
  const headers = { 'Authorization': 'Bearer ' + key };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: 60000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Non-JSON from RAGFlow (' + res.statusCode + '): ' + d.slice(0, 300))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('RAGFlow request timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function listDatasets(args) {
  const page = args.page || 1, size = args.page_size || 100;
  const r = await apiCall('GET', '/api/v1/datasets?page=' + page + '&page_size=' + size);
  if (r.code !== 0) throw new Error('RAGFlow error ' + r.code + ': ' + r.message);
  const rows = (r.data || []).map(d => ({
    id: d.id, name: d.name, chunk_count: d.chunk_count,
    document_count: d.document_count, description: d.description
  }));
  return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
}

async function retrieval(args) {
  const q = args.question;
  if (!q || !String(q).trim()) throw new Error('question is required');
  let dsIds = Array.isArray(args.dataset_ids) ? args.dataset_ids.slice() : [];
  let selection;
  if (!dsIds.length) {
    // Prefer the knowledge bases ticked in the settings page.
    selection = readSelection();
    if (selection.error) process.stderr.write('ragflow-mcp: ignoring ' + selection.source + ' (' + selection.error + ')\n');
    const all = await apiCall('GET', '/api/v1/datasets?page=1&page_size=100');
    if (all.code !== 0) throw new Error('RAGFlow error ' + all.code + ': ' + all.message);
    const accessible = (all.data || []).map(d => d.id);
    const saved = selection.datasetIds.filter(id => accessible.includes(id));
    dsIds = saved.length ? saved : accessible;
    if (!dsIds.length) throw new Error('No datasets available to the configured API key.');
  }
  const body = {
    question: String(q),
    dataset_ids: dsIds,
    page: args.page || 1,
    page_size: args.page_size || 10,
    similarity_threshold: typeof args.similarity_threshold === 'number' ? args.similarity_threshold : 0.2,
    vector_similarity_weight: typeof args.vector_similarity_weight === 'number' ? args.vector_similarity_weight : 0.3
  };
  if (Array.isArray(args.document_ids) && args.document_ids.length) body.document_ids = args.document_ids;
  const r = await apiCall('POST', '/api/v1/retrieval', body);
  if (r.code !== 0) throw new Error('RAGFlow error ' + r.code + ': ' + r.message);
  const d = r.data || {};
  const chunks = (d.chunks || []).map((c, i) => ({
    citation_id: i + 1,
    source_file: c.document_keyword || c.docnm_kwd || c.document_id || 'unknown',
    score: c.similarity,
    chunk_text: String(c.content || '').slice(0, 600)
  }));
  const out = { query: q, dataset_ids: dsIds, total: d.total, returned: chunks.length, results: chunks };
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}

const TOOLS = [
  {
    name: 'ragflow_retrieval',
    description: 'Search the user RAGFlow knowledge bases and return relevant document chunks. Omit dataset_ids to use the knowledge bases selected in the RAGFlow settings page (all accessible datasets when none is selected).',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural-language query.' },
        dataset_ids: { type: 'array', items: { type: 'string' }, description: 'Restrict to these dataset ids. Omit for all.' },
        document_ids: { type: 'array', items: { type: 'string' }, description: 'Restrict to these document ids.' },
        page: { type: 'integer', description: 'Page number, default 1.' },
        page_size: { type: 'integer', description: 'Chunks per page, default 10, max 100.' },
        similarity_threshold: { type: 'number', description: '0.0-1.0, default 0.2.' },
        vector_similarity_weight: { type: 'number', description: '0.0-1.0, default 0.3.' }
      },
      required: ['question']
    }
  },
  {
    name: 'ragflow_list_datasets',
    description: 'List RAGFlow knowledge bases available to the configured API key.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Page number, default 1.' },
        page_size: { type: 'integer', description: 'Max 100, default 100.' }
      }
    }
  }
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER
    }});
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let r;
      if (name === 'ragflow_retrieval') r = await retrieval(args);
      else if (name === 'ragflow_list_datasets') r = await listDatasets(args);
      else throw new Error('Unknown tool: ' + name);
      return send({ jsonrpc: '2.0', id, result: r });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } });
    }
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { process.stderr.write('parse error: ' + e.message + '\n'); }
  }
});
process.stdin.on('end', () => process.exit(0));
