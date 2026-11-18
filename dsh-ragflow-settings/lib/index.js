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
const SETTINGS_FILE = 'ragflow-config.json'
const API_PREFIX = '/ragflow-settings'
/** Session ids are DSH-generated tokens; anything else is a caller bug, not a key. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/
const DEFAULT_BASE_URL = 'http://localhost:8060'
/** Credential reference this plugin stores its key under in the DSH credential provider. */
const CREDENTIAL_REF = 'ragflow'

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

/** Absolute path of the connection settings written by the plugin page. */
function settingsPath() {
  return join(dshHome(), SETTINGS_FILE)
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

/**
 * The connection settings saved by the plugin page.
 *
 * Every field is optional: an absent file means "fall back to the environment",
 * which is how a deployment configured before this page existed keeps working.
 * @returns the parsed settings, or an empty object when absent or unreadable.
 */
async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const settings = {}
    if (typeof parsed.baseUrl === 'string' && parsed.baseUrl.length > 0) settings.baseUrl = parsed.baseUrl
    if (typeof parsed.timeoutMs === 'number' && Number.isFinite(parsed.timeoutMs)) settings.timeoutMs = parsed.timeoutMs
    // The key may live inline (no credential provider) or behind a reference.
    if (typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0) settings.apiKey = parsed.apiKey
    if (typeof parsed.apiKeyRef === 'string' && parsed.apiKeyRef.length > 0) settings.apiKeyRef = parsed.apiKeyRef
    return settings
  } catch {
    return {}
  }
}

/**
 * Persist the connection settings atomically.
 * @param settings - the complete settings object to store.
 */
async function writeSettings(settings) {
  const target = settingsPath()
  await mkdir(dshHome(), { recursive: true })
  const payload = JSON.stringify(settings, null, 2) + '\n'
  const temp = target + '.tmp-' + String(process.pid)
  await writeFile(temp, payload, 'utf8')
  await rename(temp, target)
}

/** Cached credential resolution; the fallback shells out to Windows once. */
const credential = { settled: false, key: '', pending: undefined }

/**
 * The RAGFlow API key, most specific source first: the plugin page's saved key
 * (inline or through the DSH credential provider), then the Host process
 * environment, then the Windows user environment.
 * @param settings - already-read connection settings.
 * @returns the key, or an empty string when no source supplies one.
 */
async function apiKey(settings) {
  const resolved = settings === undefined ? {} : settings
  if (typeof resolved.apiKey === 'string' && resolved.apiKey.length > 0) return resolved.apiKey
  if (typeof resolved.apiKeyRef === 'string' && resolved.apiKeyRef.length > 0) {
    const fromProvider = await credentialProvider()?.resolve(resolved.apiKeyRef)
    if (fromProvider !== undefined && typeof fromProvider.value === 'string' && fromProvider.value.length > 0) {
      return fromProvider.value
    }
  }
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

/**
 * The DSH credential provider, when the Host mounts one.
 *
 * Resolved on every use rather than captured at apply() time, the way
 * @deepseek-ai/dsh-mcp-client does it: the provider is a separate plugin and
 * may mount after this one.
 * @returns the provider, or undefined on a Host that mounts no credential service.
 */
function credentialProvider() {
  const ctx = pluginContext
  if (ctx === undefined || typeof ctx.get !== 'function') return undefined
  const provider = ctx.get('credentials')
  return provider !== undefined && typeof provider.resolve === 'function' ? provider : undefined
}

/** The plugin context, kept so the credential provider can be looked up lazily. */
let pluginContext

/**
 * The RAGFlow base URL, most specific source first: the plugin page's saved
 * address, then the Host process environment, then the loopback default.
 * @param settings - already-read connection settings.
 * @returns the base URL without a trailing slash.
 */
function baseUrl(settings) {
  const saved = settings === undefined ? undefined : settings.baseUrl
  if (typeof saved === 'string' && saved.length > 0) return saved.replace(/\/+$/, '')
  const raw = process.env.RAGFLOW_BASE_URL
  const value = typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_BASE_URL
  return value.replace(/\/+$/, '')
}

/**
 * One RAGFlow REST call.
 * @param method - HTTP method.
 * @param path - path with query string.
 * @param key - bearer credential.
 * @param settings - connection settings supplying the base URL and timeout.
 * @returns the parsed JSON response.
 */
function apiCall(method, path, key, settings) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(baseUrl(settings) + path)
    } catch (error) {
      reject(new Error('the RAGFlow address is not a valid URL: ' + String((error && error.message) || error)))
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
        timeout: settings !== undefined && settings.timeoutMs !== undefined ? settings.timeoutMs : 30000,
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
  const settings = await readSettings()
  const key = await apiKey(settings)
  if (key.length === 0) {
    throw new Error(
      'no RAGFlow API key is configured: fill it in on the RAGFlow plugin page, or set RAGFLOW_API_KEY.',
    )
  }
  const response = await apiCall('GET', '/api/v1/datasets?page=1&page_size=100', key, settings)
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
 * @param settings - connection settings supplying the base URL and timeout.
 * @returns the parsed JSON response.
 */
function apiCallJson(method, path, key, body, signal, settings) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl(settings) + path)
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
        timeout: settings !== undefined && settings.timeoutMs !== undefined ? settings.timeoutMs : 30000,
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

/** A fresh multipart boundary. */
function multipartBoundary() {
  return '----dshragflow' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10)
}

/**
 * Upload one text document to a dataset.
 *
 * RAGFlow's documents endpoint only accepts multipart/form-data, so a chat
 * message has to become a file part before it can be stored.
 * @param datasetId - target dataset.
 * @param filename - name the document will carry.
 * @param content - UTF-8 text.
 * @param key - bearer credential.
 * @param settings - connection settings.
 * @param signal - cancellation.
 * @returns the parsed RAGFlow response.
 */
function uploadTextDocument(datasetId, filename, content, key, settings, signal) {
  return new Promise((resolve, reject) => {
    const boundary = multipartBoundary()
    const safeName = String(filename).replace(/[\r\n"]/g, '_')
    const payload = Buffer.concat([
      Buffer.from(
        '--' + boundary + '\r\n'
        + 'Content-Disposition: form-data; name="file"; filename="' + safeName + '"\r\n'
        + 'Content-Type: text/markdown; charset=utf-8\r\n\r\n',
        'utf8',
      ),
      Buffer.from(content, 'utf8'),
      Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'),
    ])
    const url = new URL(baseUrl(settings) + '/api/v1/datasets/' + encodeURIComponent(datasetId) + '/documents')
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'multipart/form-data; boundary=' + boundary,
          'content-length': payload.length,
        },
        timeout: settings !== undefined && settings.timeoutMs !== undefined ? settings.timeoutMs : 30000,
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
      req.destroy(new Error('RAGFlow upload timed out'))
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
  pluginContext = ctx

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

  registerConfigRoutes(ctx)
  registerTools(ctx)
}

/** Shape check for an http(s) address the user typed. */
function normalizeBaseUrl(value) {
  if (typeof value !== 'string') throw new Error('serviceUrl must be a string')
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) throw new Error('serviceUrl is required')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('serviceUrl is not a valid URL: ' + trimmed)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('serviceUrl must start with http:// or https://')
  }
  return trimmed
}

/** A masked form of a key: never the middle, only enough to recognise it. */
function maskKey(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value.length <= 8) return '****'
  return value.slice(0, 4) + '…' + value.slice(-4)
}

/**
 * Where the effective key comes from, for the settings page to report.
 * @param settings - already-read connection settings.
 * @returns a source tag and whether a key is available.
 */
async function keyStatus(settings) {
  const key = await apiKey(settings)
  if (key.length === 0) return { configured: false, source: 'none', masked: '' }
  const source =
    typeof settings.apiKey === 'string' && settings.apiKey.length > 0
      ? 'plugin-page'
      : typeof settings.apiKeyRef === 'string' && settings.apiKeyRef.length > 0
        ? 'credential-provider'
        : process.env.RAGFLOW_API_KEY !== undefined && process.env.RAGFLOW_API_KEY.length > 0
          ? 'environment'
          : 'windows-user-environment'
  return { configured: true, source, masked: maskKey(key) }
}

/**
 * Try one RAGFlow connection and report what happened, without saving anything.
 * @param baseUrlValue - address to test.
 * @param key - bearer credential to test.
 * @param timeoutMs - request timeout.
 * @returns datasets count on success, a readable error otherwise.
 */
async function probeConnection(baseUrlValue, key, timeoutMs) {
  try {
    const response = await apiCall('GET', '/api/v1/datasets?page=1&page_size=100', key, {
      baseUrl: baseUrlValue,
      timeoutMs,
    })
    if (response.code !== 0) {
      return { ok: false, error: 'RAGFlow error ' + String(response.code) + ': ' + String(response.message) }
    }
    const rows = Array.isArray(response.data) ? response.data : []
    return { ok: true, datasetCount: rows.length }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/**
 * Register the connection-settings routes: read, save, and test.
 * @param ctx - the plugin context carrying the web server service.
 */
function registerConfigRoutes(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: API_PREFIX + '/config',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            try {
              const settings = await readSettings()
              const status = await keyStatus(settings)
              sendJson(res, 200, {
                ok: true,
                baseUrl: baseUrl(settings),
                baseUrlSource: settings.baseUrl !== undefined ? 'plugin-page' : process.env.RAGFLOW_BASE_URL ? 'environment' : 'default',
                timeoutMs: settings.timeoutMs !== undefined ? settings.timeoutMs : 30000,
                apiKeyConfigured: status.configured,
                apiKeySource: status.source,
                apiKeyMasked: status.masked,
                credentialProvider: credentialProvider() !== undefined,
                settingsPath: settingsPath(),
              })
            } catch (error) {
              sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
            }
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const parsed = JSON.parse((await readBody(req)) || '{}')
            const next = {}
            if (parsed.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(parsed.baseUrl)
            if (parsed.timeoutMs !== undefined) {
              const timeout = Number(parsed.timeoutMs)
              if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000) {
                sendJson(res, 400, { ok: false, error: 'timeoutMs must be between 1000 and 300000' })
                return
              }
              next.timeoutMs = Math.round(timeout)
            }
            if (parsed.apiKey !== undefined) {
              const value = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : ''
              if (value.length === 0) {
                // An explicit empty string clears a stored key.
                next.apiKey = undefined
              } else if (credentialProvider() !== undefined) {
                await credentialProvider().set(CREDENTIAL_REF, value)
                next.apiKeyRef = CREDENTIAL_REF
              } else {
                next.apiKey = value
              }
            }
            const current = await readSettings()
            const merged = { ...current, ...next }
            for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
            // Never persist both shapes at once: the reference wins when it exists.
            if (merged.apiKeyRef !== undefined) delete merged.apiKey
            await writeSettings(merged)
            const status = await keyStatus(merged)
            sendJson(res, 200, {
              ok: true,
              baseUrl: baseUrl(merged),
              timeoutMs: merged.timeoutMs !== undefined ? merged.timeoutMs : 30000,
              apiKeyConfigured: status.configured,
              apiKeySource: status.source,
              apiKeyMasked: status.masked,
              settingsPath: settingsPath(),
            })
          } catch (error) {
            const status = error instanceof SyntaxError ? 400 : 200
            sendJson(res, status, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    'ragflow-settings: connection config route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: API_PREFIX + '/test',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const parsed = JSON.parse((await readBody(req)) || '{}')
            const saved = await readSettings()
            // Unsaved values let the page test before saving.
            const url = parsed.baseUrl !== undefined ? normalizeBaseUrl(parsed.baseUrl) : baseUrl(saved)
            const timeoutMs = typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : saved.timeoutMs
            const typed = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : ''
            const key = typed.length > 0 ? typed : await apiKey(saved)
            if (key.length === 0) {
              sendJson(res, 200, { ok: false, error: 'no API key: fill it in or set RAGFLOW_API_KEY' })
              return
            }
            const result = await probeConnection(url, key, timeoutMs)
            sendJson(res, 200, { ...result, baseUrl: url })
          } catch (error) {
            const status = error instanceof SyntaxError ? 400 : 200
            sendJson(res, status, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    'ragflow-settings: connection test route',
  )
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
      const settings = await readSettings()
      const key = await apiKey(settings)
      if (key.length === 0) {
        throw new Error(
          'no RAGFlow API key is configured: fill it in on the RAGFlow plugin page, or set RAGFLOW_API_KEY.',
        )
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
      const response = await apiCallJson('POST', '/api/v1/retrieval', key, body, exec.signal, settings)
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

  ctx.tools.register({
    name: 'ragflow_add_document',
    description:
      'Store a piece of text as a new document in a RAGFlow knowledge base and start indexing it. '
      + 'Use this only when the user explicitly asks to save something into a knowledge base: name the '
      + 'target dataset plainly and confirm which one before writing. dataset_id is required — never '
      + 'guess it from the current conversation. Indexing runs asynchronously on the RAGFlow side, so '
      + 'the document is not searchable the instant this returns.',
    parameters: {
      dataset_id: {
        type: 'string',
        required: true,
        description: 'Target knowledge-base id, as reported by ragflow_list_datasets.',
      },
      content: { type: 'string', required: true, description: 'UTF-8 text to store.' },
      title: {
        type: 'string',
        description: 'Document name shown in RAGFlow; defaults to a timestamped name.',
      },
    },
    output: { schema: { type: 'object' }, render: renderJson },
    timeoutMs: 120000,
    async execute(args, exec) {
      const datasetId = typeof args.dataset_id === 'string' ? args.dataset_id.trim() : ''
      if (datasetId.length === 0) throw new Error('dataset_id is required')
      const content = typeof args.content === 'string' ? args.content : ''
      if (content.trim().length === 0) throw new Error('content is required')

      const settings = await readSettings()
      const key = await apiKey(settings)
      if (key.length === 0) {
        throw new Error(
          'no RAGFlow API key is configured: fill it in on the RAGFlow plugin page, or set RAGFLOW_API_KEY.',
        )
      }

      // Refuse an id the key cannot see, so a typo cannot create a stray dataset.
      const accessible = await listDatasets()
      const target = accessible.find((row) => row.id === datasetId)
      if (target === undefined) {
        throw new Error(
          'no readable knowledge base with id ' + datasetId
          + '; call ragflow_list_datasets for the ids this key can write to',
        )
      }

      const rawTitle = typeof args.title === 'string' ? args.title.trim() : ''
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
      const base = rawTitle.length > 0 ? rawTitle : 'note-' + stamp
      const filename = (/\.(md|txt|markdown)$/i.test(base) ? base : base + '.md').replace(/[\\/:*?"<>|]/g, '_')

      const uploaded = await uploadTextDocument(datasetId, filename, content, key, settings, exec.signal)
      if (uploaded.code !== 0) {
        throw new Error('RAGFlow refused the upload: ' + String(uploaded.message || uploaded.code))
      }
      const created = Array.isArray(uploaded.data) ? uploaded.data : []
      const documentIds = created.map((row) => String(row && row.id)).filter((id) => id.length > 0)

      // Chunking is a separate call; a failure here leaves the document uploaded.
      let indexed = false
      let indexError = ''
      if (documentIds.length > 0) {
        try {
          const parsed = await apiCallJson(
            'POST',
            '/api/v1/datasets/' + encodeURIComponent(datasetId) + '/chunks',
            key,
            { document_ids: documentIds },
            exec.signal,
            settings,
          )
          if (parsed.code === 0) indexed = true
          else indexError = 'RAGFlow error ' + String(parsed.code) + ': ' + String(parsed.message)
        } catch (error) {
          indexError = String((error && error.message) || error)
        }
      }

      return {
        dataset_id: datasetId,
        dataset_name: target.name,
        documents: created.map((row) => ({
          id: row && row.id,
          name: row && row.name,
          size: row && row.size,
        })),
        indexed,
        ...(indexError.length > 0 ? { index_error: indexError } : {}),
        note: indexed
          ? 'saved and chunking started; searchable once RAGFlow finishes indexing'
          : 'saved, but chunking did not start — run another parse from the RAGFlow UI',
      }
    },
  })
}
