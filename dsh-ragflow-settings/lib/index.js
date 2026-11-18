/**
 * RAGFlow knowledge-base selection and retrieval, Host half.
 *
 * Serves same-origin routes the browser half uses:
 *   GET  /ragflow-settings/state      -> accessible datasets + the saved selection
 *   POST /ragflow-settings/selection  -> persist the global default dataset ids
 *   GET  /ragflow-settings/session    -> one session's datasets, override, effective ids
 *   POST /ragflow-settings/session    -> persist one session's override
 *
 * Registers two Host tools that call RAGFlow directly:
 *   ragflow_list_datasets  -> accessible datasets
 *   ragflow_retrieval      -> chunks, scoped by the calling Session
 *
 * Session scoping is the reason these are Host tools rather than MCP tools: an
 * MCP stdio server is one shared child process with a scrubbed environment, so
 * it can never see which Session called it. A Host tool receives that Session
 * as `exec.agent.id`, which is what makes per-conversation selection real.
 *
 * Node built-ins only: this package must install without a dependency tree.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'ragflow-settings'

/** Routes need the web server; the retrieval tools need the tool registry. */
export const inject = ['webServer', 'tools']

const CONFIG_FILE = 'ragflow-settings.json'
const SESSION_FILE = 'ragflow-session-selection.json'
const API_PREFIX = '/ragflow-settings'
/** Session ids are DSH-generated tokens; anything else is a caller bug, not a key. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/
const DEFAULT_BASE_URL = 'http://localhost:8060'

/** DSH home: the same resolution the MCP bridge uses, so both read one file. */
function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** Absolute path of the selection file shared with the MCP bridge. */
function configPath() {
  return join(dshHome(), CONFIG_FILE)
}

/** Absolute path of the per-session override file. */
function sessionPath() {
  return join(dshHome(), SESSION_FILE)
}

/**
 * Read one user-scoped environment variable on Windows, so a Harness started
 * before the variable was set can still reach RAGFlow.
 * @param variable - the variable name.
 * @returns its value, or an empty string when unset or unavailable.
 */
async function readWindowsUserEnv(variable) {
  if (process.platform !== 'win32') return ''
  try {
    const result = await execFileAsync('reg', ['query', 'HKCU\\Environment', '/v', variable], {
      windowsHide: true,
      timeout: 10000,
    })
    for (const line of String(result.stdout).split(/\r?\n/)) {
      const match = /^\s+\S+\s+REG_\w+\s+(.*)$/.exec(line)
      if (match !== null) return match[1].trim()
    }
  } catch {
    return ''
  }
  return ''
}

/** Cached credential resolution; the fallback shells out to Windows once. */
const credential = { settled: false, key: '', pending: undefined }

/**
 * The RAGFlow API key: the Host process environment first (which is what the
 * MCP client row passes through), then the Windows user environment.
 * @returns the key, or an empty string when no source supplies one.
 */
async function apiKey() {
  const fromEnv = process.env.RAGFLOW_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  if (credential.settled) return credential.key
  if (credential.pending === undefined) {
    credential.pending = readWindowsUserEnv('RAGFLOW_API_KEY').then((value) => {
      credential.key = value
      credential.settled = true
      credential.pending = undefined
      return value
    })
  }
  return await credential.pending
}

/** The RAGFlow base URL, without a trailing slash. */
function baseUrl() {
  const raw = process.env.RAGFLOW_BASE_URL
  const value = typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_BASE_URL
  return value.replace(/\/+$/, '')
}

/**
 * One RAGFlow REST call.
 * @param method - HTTP method.
 * @param path - path with query string.
 * @param key - bearer credential.
 * @returns the parsed JSON response.
 */
function apiCall(method, path, key) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(baseUrl() + path)
    } catch (error) {
      reject(new Error('RAGFLOW_BASE_URL is not a valid URL: ' + String((error && error.message) || error)))
      return
    }
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: { authorization: 'Bearer ' + key },
        timeout: 30000,
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error('RAGFlow returned non-JSON (' + String(res.statusCode) + '): ' + text.slice(0, 300)))
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('RAGFlow request timed out'))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Datasets the configured API key can read.
 * @returns the public dataset rows.
 */
async function listDatasets() {
  const key = await apiKey()
  if (key.length === 0) {
    throw new Error(
      'RAGFLOW_API_KEY is neither in the Host environment nor in the Windows user environment.',
    )
  }
  const response = await apiCall('GET', '/api/v1/datasets?page=1&page_size=100', key)
  if (response.code !== 0) {
    throw new Error('RAGFlow error ' + String(response.code) + ': ' + String(response.message))
  }
  const rows = Array.isArray(response.data) ? response.data : []
  return rows.map((row) => ({
    id: String(row.id || ''),
    name: String(row.name || ''),
    chunkCount: Number(row.chunk_count || 0),
    documentCount: Number(row.document_count || 0),
  }))
}

/**
 * The saved selection, or an empty array when the file is absent or unreadable.
 * @returns the dataset ids stored on disk.
 */
async function readSelection() {
  try {
    const text = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed && parsed.datasetIds) ? parsed.datasetIds : []
    return list.filter((id) => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

/**
 * Persist the selection atomically so the bridge never reads a half-written file.
 * @param datasetIds - the dataset ids to store.
 */
async function writeSelection(datasetIds) {
  const target = configPath()
  await mkdir(dshHome(), { recursive: true })
  const payload = JSON.stringify({ datasetIds, updatedAt: new Date().toISOString() }, null, 2) + '\n'
  const temp = target + '.tmp-' + String(process.pid)
  await writeFile(temp, payload, 'utf8')
  await rename(temp, target)
}

/** Serializes read-modify-write cycles on the session file (lost update guard). */
let sessionWriteChain = Promise.resolve()

/**
 * Run one session-file mutation after every earlier one settled, so two
 * overlapping POSTs cannot clobber each other's session entry.
 * @param task - the mutation to run.
 * @returns whatever the mutation returns.
 */
function withSessionLock(task) {
  const run = sessionWriteChain.then(task, task)
  sessionWriteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** True for a session id the Host could plausibly have minted. */
function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/** Keep only well-formed ids, de-duplicated, order preserved. */
function sanitizeIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200))]
}

/**
 * The whole session map, or an empty object when the file is absent or damaged.
 * @returns the parsed "sessions" object.
 */
async function readSessionMap() {
  try {
    const parsed = JSON.parse(await readFile(sessionPath(), 'utf8'))
    const sessions = parsed && parsed.sessions
    if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) return {}
    const clean = {}
    for (const [sessionId, ids] of Object.entries(sessions)) {
      if (!isValidSessionId(sessionId)) continue
      if (!Array.isArray(ids)) continue
      clean[sessionId] = sanitizeIds(ids)
    }
    return clean
  } catch {
    return {}
  }
}

/** Persist the session map atomically; the file keeps only the mandated shape. */
async function writeSessionMap(sessions) {
  const target = sessionPath()
  await mkdir(dshHome(), { recursive: true })
  const payload = JSON.stringify({ sessions }, null, 2) + '\n'
  const temp = target + '.tmp-' + String(process.pid)
  await writeFile(temp, payload, 'utf8')
  await rename(temp, target)
}

/**
 * One session's override.
 * @param sessionId - a validated session id.
 * @returns the stored ids, or undefined when this session never chose.
 */
async function readSessionSelection(sessionId) {
  const sessions = await readSessionMap()
  return Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined
}

/** Bound the file: drop the oldest entries beyond the cap (insertion order). */
const SESSION_CAP = 500

/**
 * Store one session's override. An empty array is a real choice (search
 * nothing), not "clear the entry", so it is written verbatim.
 * @param sessionId - a validated session id.
 * @param datasetIds - already-sanitized ids.
 */
async function writeSessionSelection(sessionId, datasetIds) {
  return await withSessionLock(async () => {
    const sessions = await readSessionMap()
    delete sessions[sessionId]
    sessions[sessionId] = datasetIds
    const keys = Object.keys(sessions)
    for (const stale of keys.slice(0, Math.max(0, keys.length - SESSION_CAP))) delete sessions[stale]
    await writeSessionMap(sessions)
    return datasetIds
  })
}

/**
 * One RAGFlow REST call that carries a JSON body.
 * @param method - HTTP method.
 * @param path - path with query string.
 * @param key - bearer credential.
 * @param body - the JSON request body.
 * @param signal - cancellation forwarded to the socket.
 * @returns the parsed JSON response.
 */
function apiCallJson(method, path, key, body, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl() + path)
    const payload = JSON.stringify(body)
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: 30000,
        signal,
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error('RAGFlow returned non-JSON (' + String(res.statusCode) + '): ' + text.slice(0, 300)))
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('RAGFlow request timed out'))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/**
 * Which datasets one retrieval searches, and why.
 *
 * Precedence: an explicit argument, then this Session's own choice, then the
 * global default, then every accessible dataset. A Session that deliberately
 * cleared its list searches nothing — that is a choice, not a fallback.
 * @param explicit - dataset ids the caller passed.
 * @param sessionId - the calling Session id, when the caller identified one.
 * @returns the ids to search plus the precedence rule that produced them.
 */
async function resolveDatasetIds(explicit, sessionId) {
  const accessible = (await listDatasets()).map((row) => row.id)
  if (explicit.length > 0) {
    return { ids: explicit.filter((id) => accessible.includes(id)), source: 'argument' }
  }
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const stored = await readSessionSelection(sessionId)
    if (stored !== undefined) {
      return { ids: stored.filter((id) => accessible.includes(id)), source: 'session' }
    }
  }
  const saved = (await readSelection()).filter((id) => accessible.includes(id))
  if (saved.length > 0) return { ids: saved, source: 'global' }
  return { ids: accessible, source: 'all' }
}

/** Send a JSON response. */
function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/** Read a request body as text, bounded. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > 1000000) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      resolve(text)
    })
    req.on('error', reject)
  })
}

/**
 * Start the Host half: the dataset-state route and the selection route.
 * @param ctx - the plugin context carrying the web server service.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: API_PREFIX + '/state',
        handler: async (req, res) => {
          try {
            const datasets = await listDatasets()
            const selected = await readSelection()
            const accessible = new Set(datasets.map((row) => row.id))
            sendJson(res, 200, {
              ok: true,
              datasets,
              selected: selected.filter((id) => accessible.has(id)),
              configPath: configPath(),
            })
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              datasets: [],
              selected: await readSelection(),
              configPath: configPath(),
              error: String((error && error.message) || error),
            })
          }
        },
      }),
    'ragflow-settings: dataset state route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: API_PREFIX + '/selection',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const parsed = JSON.parse((await readBody(req)) || '{}')
            const requested = Array.isArray(parsed.datasetIds) ? parsed.datasetIds : []
            const datasets = await listDatasets()
            const accessible = new Set(datasets.map((row) => row.id))
            const datasetIds = [...new Set(requested.filter((id) => typeof id === 'string' && accessible.has(id)))]
            await writeSelection(datasetIds)
            sendJson(res, 200, { ok: true, selected: datasetIds, configPath: configPath() })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    'ragflow-settings: selection route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: API_PREFIX + '/session',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost')
          if (req.method === 'GET') {
            const sessionId = url.searchParams.get('sessionId')
            if (!isValidSessionId(sessionId)) {
              sendJson(res, 400, { ok: false, error: 'sessionId is required and must be a valid session id' })
              return
            }
            try {
              const globalSelected = await readSelection()
              const stored = await readSessionSelection(sessionId)
              // No stored choice => this session inherits the global default.
              const effective = stored === undefined ? globalSelected : stored
              const datasets = await listDatasets().catch(() => null)
              const accessible = datasets === null ? undefined : new Set(datasets.map((row) => row.id))
              sendJson(res, 200, {
                ok: true,
                datasets: datasets === null ? [] : datasets,
                selected: accessible === undefined ? effective : effective.filter((id) => accessible.has(id)),
                inherited: stored === undefined,
                configPath: sessionPath(),
              })
            } catch (error) {
              sendJson(res, 200, { ok: false, datasets: [], selected: [], error: String((error && error.message) || error) })
            }
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const parsed = JSON.parse((await readBody(req)) || '{}')
            const sessionId = parsed.sessionId
            if (!isValidSessionId(sessionId)) {
              sendJson(res, 400, { ok: false, error: 'sessionId is required and must be a valid session id' })
              return
            }
            if (!Array.isArray(parsed.datasetIds)) {
              sendJson(res, 400, { ok: false, error: 'datasetIds must be an array' })
              return
            }
            const requested = sanitizeIds(parsed.datasetIds)
            // Accessibility is advisory: an unreachable RAGFlow must not block a
            // local preference, so an offline lookup keeps the requested ids.
            const datasets = await listDatasets().catch(() => null)
            const selected =
              datasets === null
                ? requested
                : [...new Set(requested.filter((id) => datasets.some((row) => row.id === id)))]
            await writeSessionSelection(sessionId, selected)
            sendJson(res, 200, { ok: true, selected, inherited: false, configPath: sessionPath() })
          } catch (error) {
            const status = error instanceof SyntaxError ? 400 : 200
            sendJson(res, status, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    'ragflow-settings: session selection route',
  )

  registerTools(ctx)
}

/** Session ids DSH mints; the same shape the session selection file keys on. */
const TOOL_SESSION_PATTERN = SESSION_ID_PATTERN

/**
 * The Session a call belongs to, read from the execution's owning Agent.
 * @param exec - the tool execution handed to a definition.
 * @returns the Session id, or undefined for an execution with no Agent.
 */
function sessionOf(exec) {
  const id = exec && exec.agent ? exec.agent.id : undefined
  return typeof id === 'string' && TOOL_SESSION_PATTERN.test(id) ? id : undefined
}

/** Render a canonical JSON value as the model-facing text block. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Register the RAGFlow tools on this Host.
 *
 * These replace the MCP bridge for retrieval because only a Host tool can see
 * its calling Session; the bridge stays for non-DSH clients that spawn it
 * themselves.
 * @param ctx - the plugin context carrying the tool registry.
 */
function registerTools(ctx) {
  ctx.tools.register({
    name: 'ragflow_list_datasets',
    description:
      'List the RAGFlow knowledge bases the configured API key can read, with document and chunk counts. '
      + 'Use it to pick dataset ids for ragflow_retrieval.',
    parameters: {},
    output: { schema: { type: 'array', items: { type: 'object' } }, render: renderJson },
    async execute(_args, exec) {
      return await listDatasets()
    },
  })

  ctx.tools.register({
    name: 'ragflow_retrieval',
    description:
      'Search the RAGFlow knowledge bases and return relevant chunks with source files and scores. '
      + 'The search scope follows the current conversation: pass dataset_ids to override it, '
      + 'otherwise the knowledge bases selected for this conversation are searched, then the '
      + 'plugin-page default, then every accessible dataset. The result echoes dataset_ids and '
      + 'dataset_source so the scope actually used is visible.',
    parameters: {
      question: { type: 'string', required: true, description: 'Natural-language query.' },
      dataset_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict to these dataset ids, overriding the conversation default.',
      },
      document_ids: { type: 'array', items: { type: 'string' }, description: 'Restrict to these document ids.' },
      page: { type: 'integer', description: 'Result page, default 1.' },
      page_size: { type: 'integer', description: 'Chunks per page, default 10, max 100.' },
      similarity_threshold: { type: 'number', description: '0.0-1.0, default 0.2.' },
      vector_similarity_weight: { type: 'number', description: '0.0-1.0, default 0.3.' },
    },
    output: { schema: { type: 'object' }, render: renderJson },
    timeoutMs: 60000,
    async execute(args, exec) {
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      if (question.length === 0) throw new Error('question is required')
      const explicit = Array.isArray(args.dataset_ids)
        ? args.dataset_ids.filter((id) => typeof id === 'string' && id.length > 0)
        : []
      const scope = await resolveDatasetIds(explicit, sessionOf(exec))
      if (scope.ids.length === 0) {
        throw new Error(
          scope.source === 'session'
            ? 'this conversation selects no knowledge base; tick at least one to search'
            : scope.source === 'argument'
              ? 'none of the given dataset_ids is readable with the configured API key'
              : 'no RAGFlow dataset is readable with the configured API key',
        )
      }
      const key = await apiKey()
      if (key.length === 0) {
        throw new Error('RAGFLOW_API_KEY is neither in the Host environment nor in the Windows user environment.')
      }
      const body = {
        question,
        dataset_ids: scope.ids,
        page: typeof args.page === 'number' ? args.page : 1,
        page_size: typeof args.page_size === 'number' ? Math.min(args.page_size, 100) : 10,
        similarity_threshold: typeof args.similarity_threshold === 'number' ? args.similarity_threshold : 0.2,
        vector_similarity_weight: typeof args.vector_similarity_weight === 'number' ? args.vector_similarity_weight : 0.3,
      }
      if (Array.isArray(args.document_ids) && args.document_ids.length > 0) body.document_ids = args.document_ids
      const response = await apiCallJson('POST', '/api/v1/retrieval', key, body, exec.signal)
      if (response.code !== 0) throw new Error('RAGFlow error ' + String(response.code) + ': ' + String(response.message))
      const data = response.data || {}
      const chunks = (Array.isArray(data.chunks) ? data.chunks : []).map((chunk, index) => ({
        citation_id: index + 1,
        source_file: chunk.document_keyword || chunk.docnm_kwd || chunk.document_id || 'unknown',
        score: chunk.similarity,
        chunk_text: String(chunk.content || '').slice(0, 600),
      }))
      return {
        query: question,
        dataset_ids: scope.ids,
        dataset_source: scope.source,
        total: data.total,
        returned: chunks.length,
        results: chunks,
      }
    },
  })
}
