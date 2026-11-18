
// Harness that mounts the plugin's Host half against a real HTTP server and a
// minimal fake cordis context, then exercises the routes.
//
// The plugin resolves its state files from DSH_HOME (falling back to ~/.dsh) and
// this harness writes them. Point DSH_HOME at a throwaway directory first:
//
//   $env:DSH_HOME = "$env:TEMP\ragflow-harness"; mkdir $env:DSH_HOME
//   node tools/mount-host.mjs <abs path to lib/index.js>
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

console.log('exports=' + Object.keys(plugin).join(','))
console.log('inject=' + JSON.stringify(plugin.inject))
plugin.apply(ctx)
console.log('routes=' + [...routes.keys()].join(','))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = routes.get(url.pathname)
  if (!route) { res.writeHead(404); res.end('no route'); return }
  await route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log('port=' + port)

async function getJson(pathname) {
  const r = await fetch('http://127.0.0.1:' + port + pathname)
  return { status: r.status, body: await r.json() }
}
async function postJson(pathname, value) {
  const r = await fetch('http://127.0.0.1:' + port + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value)
  })
  return { status: r.status, body: await r.json() }
}

const state = await getJson('/ragflow-settings/state')
console.log('STATE status=' + state.status + ' ok=' + state.body.ok + ' datasets=' + state.body.datasets.length)
for (const row of state.body.datasets) console.log('  ' + JSON.stringify(row))
console.log('STATE selected=' + JSON.stringify(state.body.selected) + ' configPath=' + state.body.configPath)
console.log('STATE error=' + JSON.stringify(state.body.error || ''))
console.log('STATE_JSON=' + JSON.stringify(state.body))

// Save a two-dataset selection, then prove it landed on disk.
const ids = state.body.datasets.slice(0, 2).map((row) => row.id)
const saved = await postJson('/ragflow-settings/selection', { datasetIds: ids })
console.log('SAVE status=' + saved.status + ' body=' + JSON.stringify(saved.body))

const again = await getJson('/ragflow-settings/state')
console.log('REREAD selected=' + JSON.stringify(again.body.selected))

// A selection carrying an unknown id must be filtered against accessibility.
const bogus = await postJson('/ragflow-settings/selection', { datasetIds: [ids[0], 'not-a-real-dataset'] })
console.log('FILTER body=' + JSON.stringify(bogus.body))

// Restore the two-dataset selection for the MCP check.
await postJson('/ragflow-settings/selection', { datasetIds: ids })

for (const { dispose } of effects.reverse()) dispose()
console.log('disposed routes=' + routes.size)
server.close()
process.exit(0)
