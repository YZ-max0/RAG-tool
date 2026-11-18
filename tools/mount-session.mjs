// Mount the Host half against a real HTTP server and exercise all the routes,
// including the per-session pair.
//
// The plugin resolves its state files from DSH_HOME (falling back to ~/.dsh), and
// this harness DOES write them. Point DSH_HOME at a throwaway directory first, or
// the fixture session lands in the user's real ragflow-session-selection.json:
//
//   $env:DSH_HOME = "$env:TEMP\ragflow-harness"; mkdir $env:DSH_HOME
//   node tools/mount-session.mjs <abs path to lib/index.js>
import http from 'node:http'

if (process.env.DSH_HOME === undefined || process.env.DSH_HOME.length === 0) {
  console.error('refusing to run: set DSH_HOME to a throwaway directory, this harness writes state files')
  process.exit(2)
}

const plugin = await import('file:///' + process.argv[2].replace(/\\/g, '/'))

const routes = new Map()
const effects = []
const tools = new Map()
const ctx = {
  tools: {
    register(definition) {
      if (tools.has(definition.name)) throw new Error('duplicate tool ' + definition.name)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    }
  },
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    }
  },
  effect(fn, label) {
    const dispose = fn()
    effects.push({ dispose, label })
    return dispose
  }
}

plugin.apply(ctx)
console.log('ROUTES=' + [...routes.keys()].join(','))
console.log('INJECT=' + JSON.stringify(plugin.inject))
console.log('TOOLS=' + [...tools.keys()].join(','))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = routes.get(url.pathname)
  if (!route) { res.writeHead(404); res.end('no route'); return }
  await route.handler(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

async function getJ(p) {
  const r = await fetch(base + p)
  return { status: r.status, body: await r.json() }
}
async function postJ(p, v) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) })
  return { status: r.status, body: await r.json() }
}
async function postRaw(p, text) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })
  return { status: r.status, body: await r.json() }
}

const state = await getJ('/ragflow-settings/state')
console.log('OLD_STATE ok=' + state.body.ok + ' datasets=' + state.body.datasets.length + ' selected=' + JSON.stringify(state.body.selected) + ' configPath=' + state.body.configPath)
const baseline = state.body.selected

const SID = 'test-session-abc123'
const ids = state.body.datasets.map((d) => d.id)
const two = ids.slice(0, 2)

// GET session, no override yet => inherits global
const g0 = await getJ('/ragflow-settings/session?sessionId=' + SID)
console.log('SESSION_GET_NOSTORE status=' + g0.status + ' ok=' + g0.body.ok + ' inherited=' + g0.body.inherited + ' selected=' + JSON.stringify(g0.body.selected) + ' matchesGlobal=' + (JSON.stringify(g0.body.selected) === JSON.stringify(baseline)) + ' path=' + g0.body.configPath)

// POST session override
const p1 = await postJ('/ragflow-settings/session', { sessionId: SID, datasetIds: two })
console.log('SESSION_POST status=' + p1.status + ' ok=' + p1.body.ok + ' selected=' + JSON.stringify(p1.body.selected) + ' inherited=' + p1.body.inherited)

// GET again => override wins, not global
const g1 = await getJ('/ragflow-settings/session?sessionId=' + SID)
console.log('SESSION_GET_OVERRIDE inherited=' + g1.body.inherited + ' selected=' + JSON.stringify(g1.body.selected) + ' equalsTwo=' + (JSON.stringify(g1.body.selected) === JSON.stringify(two)))

// empty array is a real choice: this session searches nothing
const p2 = await postJ('/ragflow-settings/session', { sessionId: SID, datasetIds: [] })
const g2 = await getJ('/ragflow-settings/session?sessionId=' + SID)
console.log('SESSION_EMPTY post=' + JSON.stringify(p2.body.selected) + ' reread=' + JSON.stringify(g2.body.selected) + ' inherited=' + g2.body.inherited)

// isolation: another session is untouched
const g3 = await getJ('/ragflow-settings/session?sessionId=other-session-xyz')
console.log('SESSION_ISOLATION inherited=' + g3.body.inherited + ' selected=' + JSON.stringify(g3.body.selected))

// global default unchanged by session writes
const stateAfter = await getJ('/ragflow-settings/state')
console.log('GLOBAL_UNCHANGED=' + (JSON.stringify(stateAfter.body.selected) === JSON.stringify(baseline)))

// validation
for (const [label, p] of [
  ['NO_SESSION_ID', '/ragflow-settings/session'],
  ['EMPTY_SESSION_ID', '/ragflow-settings/session?sessionId='],
  ['BAD_CHARS', '/ragflow-settings/session?sessionId=' + encodeURIComponent('../../etc/passwd')],
  ['TOO_LONG', '/ragflow-settings/session?sessionId=' + 'a'.repeat(201)]
]) {
  const r = await getJ(p)
  console.log('VALIDATE_' + label + ' status=' + r.status + ' ok=' + r.body.ok + ' err=' + JSON.stringify(r.body.error))
}

const b1 = await postJ('/ragflow-settings/session', { datasetIds: two })
console.log('POST_NO_SID status=' + b1.status + ' ok=' + b1.body.ok)
const b2 = await postJ('/ragflow-settings/session', { sessionId: SID, datasetIds: 'nope' })
console.log('POST_BAD_IDS status=' + b2.status + ' ok=' + b2.body.ok + ' err=' + JSON.stringify(b2.body.error))
const b3 = await postRaw('/ragflow-settings/session', '{not json')
console.log('POST_BAD_JSON status=' + b3.status + ' ok=' + b3.body.ok)

// method guard on POST-only /selection still intact
const m = await fetch(base + '/ragflow-settings/selection')
console.log('SELECTION_GET_METHOD status=' + m.status + ' body=' + JSON.stringify(await m.json()))

// bogus dataset filtered against accessibility
const filt = await postJ('/ragflow-settings/session', { sessionId: SID, datasetIds: [two[0], 'not-a-real-dataset'] })
console.log('SESSION_FILTER=' + JSON.stringify(filt.body.selected))

server.close()
process.exit(0)
