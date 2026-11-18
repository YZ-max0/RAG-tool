/**
 * Verification harness for the composer session-knowledge seat.
 *
 * Supplies a minimal hooks runtime plus a react-dom stub (createPortal), runs the
 * factory, registers into 'conversation.input.left', and drives the picker
 * against the real Host routes for two different sessions.
 */
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import vm from 'node:vm'

const clientPath = process.argv[2]
const hostModulePath = process.argv[3]

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
  Fragment: 'Fragment',
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
    if (hookCells.length <= i) { hookCells[i] = { kind: 'effect' }; pendingEffects.push(effect) }
  },
  useCallback(fn) {
    const i = hookIndex++
    if (hookCells.length <= i) hookCells[i] = { kind: 'callback', value: fn }
    return hookCells[i].value
  },
}

let portalCalls = 0
const reactDom = {
  createPortal(node, target) {
    portalCalls += 1
    return { __portal: true, target: target === documentStub.body ? 'body' : 'other', node }
  },
}

const styles = []
const listeners = []
const documentStub = {
  head: { append: (element) => styles.push(element) },
  body: { tag: 'body' },
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  addEventListener: (type, fn) => listeners.push([type, fn]),
  removeEventListener: (type, fn) => {
    const i = listeners.findIndex((entry) => entry[0] === type && entry[1] === fn)
    if (i >= 0) listeners.splice(i, 1)
  },
}
const windowStub = {}
const registrations = {}
windowStub.__ModuleLoader__ = { load: (registration) => { registrations[registration.id] = registration } }

const sandboxRequire = (specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return reactDom
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
const plugin = registration.factory(sandboxRequire)

const dictionaries = {}
const slotRegistrations = []
const ctx = {
  effect(fn) { return fn() },
  locale: {
    register(ns, value) { dictionaries[ns] = value; return () => {} },
    bind(ns) {
      return (key) => {
        const entry = dictionaries[ns]
        if (entry === undefined) throw new Error('unbound namespace ' + ns)
        const d = entry.zh !== undefined ? entry.zh : entry.en
        if (d[key] === undefined) throw new Error('missing locale key ' + ns + '.' + key)
        return d[key]
      }
    },
  },
  slots: {
    inject(owner, register) { register(); return () => {} },
    register(options, component) { slotRegistrations.push({ options, component }); return { options, component } },
  },
}

plugin.apply(ctx)
console.log('SLOTS_REGISTERED=' + JSON.stringify(slotRegistrations.map((r) => r.options.name + '#' + (r.options.id || ''))))
const seat = slotRegistrations.find((r) => r.options.name === 'conversation.input.left')
if (seat === undefined) throw new Error("no registration into 'conversation.input.left'")
console.log('SEAT_SLOT=' + seat.options.name)
console.log('SEAT_OPTIONS=' + JSON.stringify(seat.options))
console.log('PLUGINS_CARD_PRESENT=' + String(slotRegistrations.some((r) => r.options.name === 'plugins.item')))

function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
  if (node.__portal === true) return expand(node.node)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  const children = node.props.children
  return { type: node.type, props: { ...node.props, children: children === undefined ? undefined : expand(children) } }
}

function walk(node, acc = []) {
  if (node === null || node === undefined) return acc
  if (typeof node === 'string') return acc
  if (Array.isArray(node)) { for (const child of node) walk(child, acc); return acc }
  acc.push(node)
  if (node.props.children !== undefined) walk(node.props.children, acc)
  return acc
}
const textOf = (node) => walk(node).flatMap((e) => (typeof e.props.children === 'string' ? [e.props.children] : [])).join(' | ')
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

const t = ctx.locale.bind('ragflowSettings')
let rendered = null
function render(props) {
  hookIndex = 0
  pendingEffects = []
  const element = seat.component({ ...props, t })
  rendered = expand(element)
  const effects = pendingEffects
  rerender = () => render(props)
  for (const effect of effects) effect()
  return rendered
}

const SID = 'harness-session-1'
render({ sessionId: SID, locked: false })
await settle()
render({ sessionId: SID, locked: false })
await settle()

const nodes = walk(rendered)
const trigger = nodes.find((e) => e.props && e.props['data-ragflow-session-trigger'] !== undefined)
console.log('TRIGGER_FOUND=' + String(trigger !== undefined))
console.log('TRIGGER_SESSION_ID=' + JSON.stringify(trigger.props['data-ragflow-session-trigger']))
console.log('TRIGGER_TEXT=' + JSON.stringify(textOf(trigger)))
console.log('TRIGGER_STATE=' + JSON.stringify(trigger.props['data-state']))
console.log('POPOVER_CLOSED=' + String(nodes.every((e) => e.props.className !== 'dsh-ragflow-pop')))

// open it
walk(rendered).find((e) => e.props && e.props['data-ragflow-session-trigger'] !== undefined).props.onClick()
await settle()
render({ sessionId: SID, locked: false })
await settle()

const openNodes = walk(rendered)
console.log('PORTAL_CALLS=' + portalCalls)
console.log('POPOVER_OPEN=' + String(openNodes.some((e) => e.props.className === 'dsh-ragflow-pop')))
console.log('MASK_PRESENT=' + String(openNodes.some((e) => e.props.className === 'dsh-ragflow-mask')))
console.log('DIALOG_ROLE=' + JSON.stringify((openNodes.find((e) => e.props.className === 'dsh-ragflow-pop') || {}).props.role))
const boxes = openNodes.filter((e) => e.props.type === 'checkbox')
console.log('CHECKBOX_COUNT=' + boxes.length)
console.log('CHECKBOX_STATES=' + JSON.stringify(boxes.map((b) => b.props.checked)))
console.log('DATASET_LABELS=' + JSON.stringify(openNodes.filter((e) => e.type === 'label').map((e) => e.props.children)))
console.log('DATASET_META=' + JSON.stringify(openNodes.filter((e) => e.props.className === 'dsh-ragflow-meta').map((e) => [].concat(e.props.children).join(''))))
console.log('STATUS_LINES=' + JSON.stringify(openNodes.filter((e) => e.props.className === 'dsh-ragflow-status').map((e) => textOf(e))))

// tick the first dataset -> writes for THIS session only
boxes[0].props.onChange()
await settle(); await settle()
render({ sessionId: SID, locked: false })
await settle()
const afterTick = walk(rendered)
console.log('AFTER_TICK=' + JSON.stringify(afterTick.filter((e) => e.props.type === 'checkbox').map((b) => b.props.checked)))
console.log('AFTER_TICK_STATUS=' + JSON.stringify(afterTick.filter((e) => e.props.className === 'dsh-ragflow-status').map((e) => textOf(e))))

// a different session must not see that choice
render({ sessionId: 'harness-session-2', locked: false })
await settle()
render({ sessionId: 'harness-session-2', locked: false })
await settle()
const other = walk(rendered)
console.log('OTHER_TRIGGER_SESSION=' + JSON.stringify((other.find((e) => e.props && e.props['data-ragflow-session-trigger'] !== undefined) || {}).props['data-ragflow-session-trigger']))

// clear everything for session 1 -> "searches nothing"
render({ sessionId: SID, locked: false })
await settle()
// Ensure open: only click when the popover is actually closed.
const isOpen = () => walk(rendered).some((e) => e.props.className === 'dsh-ragflow-pop')
if (!isOpen()) {
  walk(rendered).find((e) => e.props && e.props['data-ragflow-session-trigger'] !== undefined).props.onClick()
  await settle()
}
render({ sessionId: SID, locked: false })
await settle()
console.log('PRE_CLEAR_OPEN=' + String(isOpen()))
render({ sessionId: SID, locked: false })
await settle()
const clearing = walk(rendered)
const clearButton = clearing.filter((e) => e.type === 'button').find((b) => textOf(b) === ctx.locale.bind('ragflowSettings')('selectNone'))
console.log('CLEAR_BUTTON_FOUND=' + String(clearButton !== undefined))
if (clearButton !== undefined) {
  clearButton.props.onClick()
  await settle(); await settle()
  render({ sessionId: SID, locked: false })
  await settle()
  const cleared = walk(rendered)
  console.log('CLEARED_STATES=' + JSON.stringify(cleared.filter((e) => e.props.type === 'checkbox').map((b) => b.props.checked)))
  console.log('CLEARED_TRIGGER_STATE=' + JSON.stringify((cleared.find((e) => e.props && e.props['data-ragflow-session-trigger'] !== undefined) || {}).props['data-state']))
  console.log('CLEARED_STATUS=' + JSON.stringify(cleared.filter((e) => e.props.className === 'dsh-ragflow-status').map((e) => textOf(e))))
}

// Escape closes the popover
const closer = walk(rendered).filter((e) => e.type === 'button').find((b) => textOf(b) === ctx.locale.bind('ragflowSettings')('sessionClose'))
if (closer !== undefined) { closer.props.onClick(); await settle(); render({ sessionId: SID, locked: false }); await settle() }
console.log('AFTER_CLOSE_POPOVER=' + String(walk(rendered).some((e) => e.props.className === 'dsh-ragflow-pop')))

// locked composer disables the trigger
render({ sessionId: SID, locked: true })
await settle()
const lockedTrigger = walk(rendered).find((e) => e.props && e.props['data-ragflow-session-trigger'] !== undefined)
console.log('LOCKED_DISABLED=' + String(lockedTrigger.props.disabled))

// no sessionId => disabled, no fetch
render({ sessionId: undefined, locked: false })
await settle()
const noSession = walk(rendered).find((e) => e.props && e.props['data-ragflow-session-trigger'] !== undefined)
console.log('NO_SESSION_DISABLED=' + String(noSession.props.disabled))

hostServer.close()
process.exit(0)
