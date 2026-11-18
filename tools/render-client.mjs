/**
 * Verification harness for the plugin's browser half.
 *
 * React is a browser module-table seed rather than an installed package, so this
 * supplies a minimal hooks runtime (useState/useEffect/useCallback) just good
 * enough to run the factory, register the slot entry, and render both views
 * against the real Host routes. It is not a React conformance test; it proves
 * the module format, the registration, and the render logic do not throw.
 */
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import vm from 'node:vm'

const clientPath = process.argv[2]
const hostModulePath = process.argv[3]

// ── the plugin's own Host half, mounted on a throwaway server ──────────────
const pluginModule = await import('file:///' + hostModulePath.split('\\').join('/'))
const hostRoutes = new Map()
pluginModule.apply({
  tools: { register() { return () => {} } },
  webServer: {
    register(route) {
      if (hostRoutes.has(route.path)) throw new Error('duplicate route ' + route.path)
      hostRoutes.set(route.path, route)
      return () => hostRoutes.delete(route.path)
    },
  },
  effect(fn) { return fn() },
})
const hostServer = http.createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  const route = hostRoutes.get(path)
  if (route === undefined) { response.writeHead(404); response.end('no route'); return }
  await route.handler(request, response)
})
await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
const hostOrigin = 'http://127.0.0.1:' + String(hostServer.address().port)
const pageFetch = (input, init) => fetch(new URL(input, hostOrigin), init)
console.log('HOST_ROUTES=' + [...hostRoutes.keys()].join(','))

let rerender = () => {}
const hookCells = []
let hookIndex = 0
let pendingEffects = []

function createElement(type, props, ...children) {
  const flat = children.flat(Infinity)
  return { type, props: { ...(props || {}), children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat } }
}

const React = {
  createElement,
  useState(initial) {
    const i = hookIndex++
    if (hookCells.length <= i) hookCells[i] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    const cell = hookCells[i]
    const setValue = (next) => {
      cell.value = typeof next === 'function' ? next(cell.value) : next
      rerender()
    }
    return [cell.value, setValue]
  },
  useEffect(effect) {
    const i = hookIndex++
    if (hookCells.length <= i) {
      hookCells[i] = { kind: 'effect' }
      pendingEffects.push(effect)
    }
  },
  useCallback(fn) {
    const i = hookIndex++
    if (hookCells.length <= i) hookCells[i] = { kind: 'callback', value: fn }
    return hookCells[i].value
  },
}

const styles = []
const documentStub = {
  head: { append: (element) => styles.push(element) },
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
}
const windowStub = {}
const registrations = {}
windowStub.__ModuleLoader__ = { load: (registration) => { registrations[registration.id] = registration } }

const sandboxRequire = (specifier) => {
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
}

const source = await readFile(clientPath, 'utf8')
const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  Symbol, Object, Array, Set, Map, String, Number, Boolean, JSON, Math, Promise, Error, Date,
  console, fetch: pageFetch, URL, setTimeout, clearTimeout, encodeURIComponent,
})
vm.runInContext(source, context, { filename: clientPath })

const registration = registrations['@local/dsh-ragflow-settings']
if (registration === undefined) throw new Error('factory not registered under the expected id')
console.log('REGISTERED_IDS=' + Object.keys(registrations).join(','))

const plugin = registration.factory(sandboxRequire)
console.log('FACTORY_EXPORTS=' + Object.keys(plugin).join(','))
console.log('FACTORY_INJECT=' + JSON.stringify(plugin.inject))

const dictionaries = {}
const slotRegistrations = []
let slotOwner = null
let slotEntry = null
const ctx = {
  effect(fn) { return fn() },
  locale: {
    register(ns, value) { dictionaries[ns] = value; return () => {} },
    bind(ns) {
      return (key) => {
        const entry = dictionaries[ns]
        if (entry === undefined) throw new Error('unbound namespace ' + ns)
        const dictionary = entry.zh !== undefined ? entry.zh : entry.en
        if (dictionary[key] === undefined) throw new Error('missing locale key ' + ns + '.' + key)
        return dictionary[key]
      }
    },
  },
  slots: {
    inject(owner, register) { slotOwner = owner; slotRegistrations.push(register()); return () => {} },
    register(options, component) { return { options, component } },
  },
}

plugin.apply(ctx)
// This harness exercises the Plugins-page card; the plugin now also contributes a
// composer seat, so pick plugins.item by name instead of taking the last one.
const card = slotRegistrations.find((entry) => entry.options.name === 'plugins.item')
if (card === undefined) throw new Error("no registration into 'plugins.item'")
slotEntry = card
slotOwner = card.options.name
console.log('ALL_SLOTS=' + JSON.stringify(slotRegistrations.map((entry) => entry.options.name)))
console.log('SLOT_OWNER=' + slotOwner)
console.log('SLOT_OPTIONS=' + JSON.stringify({ ...slotEntry.options, label: slotEntry.options.label() }))
console.log('LOCALE_NS=' + Object.keys(dictionaries).join(','))
console.log('IMPORTED_BUILTINS=' + JSON.stringify({ stylesInjected: styles.length }))

// ── renderer ───────────────────────────────────────────────────────────────
function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  const children = node.props.children
  return { type: node.type, props: { ...node.props, children: children === undefined ? undefined : expand(children) } }
}

let rendered = null
function render(view) {
  hookIndex = 0
  pendingEffects = []
  const element = slotEntry.component({ view })
  rendered = expand(element)
  const effects = pendingEffects
  rerender = () => { render(view) }
  for (const effect of effects) effect()
  return rendered
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

function walk(node, acc = []) {
  if (node === null || node === undefined) return acc
  if (typeof node === 'string') return acc
  if (Array.isArray(node)) { for (const child of node) walk(child, acc); return acc }
  acc.push(node)
  if (node.props.children !== undefined) walk(node.props.children, acc)
  return acc
}

function textOf(node) {
  return walk(node)
    .flatMap((element) => (typeof element.props.children === 'string' ? [element.props.children] : []))
    .join(' | ')
}

render('page')
await settle()
render('page')
await settle()

const nodes = walk(rendered)
console.log('ELEMENT_COUNT=' + nodes.length)
const checkboxes = nodes.filter((element) => element.props.type === 'checkbox')
console.log('CHECKBOX_COUNT=' + checkboxes.length)
console.log('CHECKBOX_STATES=' + JSON.stringify(checkboxes.map((box) => box.props.checked)))
const buttons = nodes.filter((element) => element.type === 'button')
console.log('BUTTON_LABELS=' + JSON.stringify(buttons.map((button) => textOf(button))))
console.log('DATASET_LABELS=' + JSON.stringify(nodes.filter((element) => element.type === 'label').map((element) => element.props.children)))
console.log('DATASET_META=' + JSON.stringify(nodes.filter((element) => element.props.className === 'dsh-ragflow-meta').map((element) => [].concat(element.props.children).join(''))))
console.log('STATUS_LINES=' + JSON.stringify(nodes.filter((element) => element.props.className === 'dsh-ragflow-status').map((element) => textOf(element))))
console.log('PATH_LINE=' + JSON.stringify(nodes.filter((element) => element.props.className === 'dsh-ragflow-path').map((element) => textOf(element))))

// Interact: tick everything, save, and re-read the Host state.
const selectAll = buttons[0]
selectAll.props.onClick()
await settle()
console.log('AFTER_SELECT_ALL=' + JSON.stringify(walk(rendered).filter((element) => element.props.type === 'checkbox').map((box) => box.props.checked)))
const reRenderedButtons = walk(rendered).filter((element) => element.type === 'button')
const save = reRenderedButtons[3]
console.log('SAVE_DISABLED_BEFORE=' + String(save.props.disabled))
save.props.onClick()
await settle()
await settle()
const afterSave = walk(rendered)
console.log('SAVE_STATUS=' + JSON.stringify(afterSave.filter((element) => element.props.className === 'dsh-ragflow-status').map((element) => textOf(element))))

render('summary')
console.log('SUMMARY=' + JSON.stringify(textOf(rendered)))
hostServer.close()
process.exit(0)
