/**
 * RAGFlow knowledge-base selection, browser half.
 *
 * Registers one card on the Plugins page ("plugins.item") that lists the
 * RAGFlow datasets the configured API key can read, lets the user tick the ones
 * ragflow_retrieval should search by default, and persists that choice through
 * the Host half's /ragflow-settings routes.
 *
 * Classic script registered through the client module loader; the factory is
 * lazy, so every side effect lives inside apply().
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ragflow-settings',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'ragflowSettings'

    const zh = {
      title: 'RAGFlow 知识库',
      description: '选择 ragflow_retrieval 默认检索哪些知识库。',
      hint: '勾选的知识库作为检索时的默认 dataset_ids。未选择任何知识库时，检索全部可访问的知识库。',
      selectAll: '全选',
      selectNone: '全不选',
      refresh: '刷新列表',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      loading: '正在读取知识库…',
      empty: '没有可访问的知识库。',
      chunks: '块',
      documents: '文档',
      configPath: '配置文件',
      saveFailed: '保存失败',
      loadFailed: '读取知识库失败',
      retry: '重试',
      selectionSummary: '已选 {count} 个知识库',
      sessionButton: '知识库',
      sessionTitle: '本会话检索的知识库',
      sessionHint: '只对本会话生效，覆盖设置页的默认值。全部取消勾选时，本会话不检索任何知识库。',
      sessionInherited: '未单独设置，正在使用默认值',
      sessionOverride: '本会话已单独设置',
      sessionEmpty: '不检索任何知识库',
      sessionSaveFailed: '保存失败',
      sessionLoadFailed: '读取失败',
      sessionClose: '关闭'
    }

    const en = {
      title: 'RAGFlow knowledge bases',
      description: 'Choose which datasets ragflow_retrieval searches by default.',
      hint: 'Ticked datasets become the default dataset_ids for retrieval. With nothing ticked, retrieval searches every accessible dataset.',
      selectAll: 'Select all',
      selectNone: 'Clear selection',
      refresh: 'Refresh list',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      loading: 'Reading knowledge bases…',
      empty: 'No accessible knowledge bases.',
      chunks: 'chunks',
      documents: 'documents',
      configPath: 'Configuration file',
      saveFailed: 'Save failed',
      loadFailed: 'Could not read the knowledge bases',
      retry: 'Retry',
      selectionSummary: '{count} selected',
      sessionButton: 'Knowledge bases',
      sessionTitle: 'Knowledge bases for this session',
      sessionHint: 'Applies to this session only and overrides the default from the settings page. With every box cleared, this session searches no knowledge base.',
      sessionInherited: 'No session override — using the default',
      sessionOverride: 'Overridden for this session',
      sessionEmpty: 'Searches nothing',
      sessionSaveFailed: 'Save failed',
      sessionLoadFailed: 'Could not load',
      sessionClose: 'Close'
    }

    const CSS = [
      '.dsh-ragflow{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dsh-ragflow-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-ragflow-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.dsh-ragflow-btn{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;height:28px;padding:0 12px;cursor:pointer}',
      '.dsh-ragflow-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ragflow-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-ragflow-btn[data-primary]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-ragflow-btn[data-primary]:hover:not(:disabled){background:var(--dsw-alias-state-business-primary)}',
      '.dsh-ragflow-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}',
      '.dsh-ragflow-row{display:flex;align-items:center;gap:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:8px 12px}',
      '.dsh-ragflow-row input{width:16px;height:16px;flex:none;margin:0;accent-color:var(--dsw-alias-brand-primary)}',
      '.dsh-ragflow-name{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.dsh-ragflow-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}',
      '.dsh-ragflow-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-ragflow-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-ragflow-status[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-ragflow-path{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}',
      '.dsh-ragflow-trigger{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;height:28px;padding:0 10px;cursor:pointer;white-space:nowrap}',
      '.dsh-ragflow-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ragflow-trigger:disabled{opacity:.55;cursor:default}',
      '.dsh-ragflow-trigger[data-state="none"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-ragflow-trigger-badge{flex:none;min-width:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);padding:0 5px;font-size:11px;line-height:16px;text-align:center}',
      '.dsh-ragflow-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.28)}',
      '.dsh-ragflow-pop{display:flex;flex-direction:column;gap:10px;width:min(520px,calc(100vw - 32px));max-height:min(70vh,560px);margin-bottom:96px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px rgba(0,0,0,.28);padding:14px;overflow:auto}',
      '.dsh-ragflow-pop-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsh-ragflow-pop-title{margin:0;font-size:13.5px;font-weight:600}',
      '.dsh-ragflow-pop-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;border-top:.5px solid var(--dsw-alias-border-l3);padding-top:10px}'
    ].join('\n')

    function injectStyle() {
      const el = document.createElement('style')
      el.setAttribute('data-plugin', 'dsh-ragflow-settings')
      el.textContent = CSS
      document.head.append(el)
      return () => {
        el.remove()
      }
    }

    async function readState() {
      const response = await fetch('/ragflow-settings/state', { headers: { accept: 'application/json' } })
      return await response.json()
    }

    async function writeSelection(datasetIds) {
      const response = await fetch('/ragflow-settings/selection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ datasetIds })
      })
      return await response.json()
    }

    function formatSummary(t, count) {
      return String(t('selectionSummary')).replace('{count}', String(count))
    }

    async function readSession(sessionId) {
      const response = await fetch('/ragflow-settings/session?sessionId=' + encodeURIComponent(sessionId), {
        headers: { accept: 'application/json' }
      })
      return await response.json()
    }

    async function writeSession(sessionId, datasetIds) {
      const response = await fetch('/ragflow-settings/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, datasetIds })
      })
      return await response.json()
    }

    function RagflowCard(props) {
      const t = props.t
      const view = props.view
      const [state, setState] = React.useState({ status: 'loading', datasets: [], selected: [], configPath: '', error: '' })
      const [draft, setDraft] = React.useState([])
      const [saveState, setSaveState] = React.useState('idle')

      const load = React.useCallback(async () => {
        setState((previous) => ({ ...previous, status: 'loading', error: '' }))
        try {
          const data = await readState()
          const datasets = Array.isArray(data.datasets) ? data.datasets : []
          const selected = Array.isArray(data.selected) ? data.selected : []
          setState({
            status: data.ok === true ? 'ready' : 'error',
            datasets,
            selected,
            configPath: String(data.configPath || ''),
            error: data.ok === true ? '' : String(data.error || '')
          })
          setDraft(selected)
        } catch (error) {
          setState({ status: 'error', datasets: [], selected: [], configPath: '', error: String((error && error.message) || error) })
        }
      }, [])

      React.useEffect(() => {
        if (view === 'summary') return
        void load()
      }, [view, load])

      if (view === 'summary') {
        if (state.status !== 'ready') return h('span', null, t('description'))
        return h('span', null, formatSummary(t, state.selected.length) + ' / ' + String(state.datasets.length))
      }

      const toggle = (id) => {
        setSaveState('idle')
        setDraft((previous) => (previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id]))
      }

      const save = async () => {
        setSaveState('saving')
        try {
          const result = await writeSelection(draft)
          if (result && result.ok === true) {
            const selected = Array.isArray(result.selected) ? result.selected : draft
            setDraft(selected)
            setState((previous) => ({ ...previous, selected }))
            setSaveState('saved')
          } else {
            setSaveState('error')
          }
        } catch {
          setSaveState('error')
        }
      }

      const dirty = draft.length !== state.selected.length || draft.some((id) => !state.selected.includes(id))

      const rows = state.datasets.map((row) =>
        h(
          'li',
          { className: 'dsh-ragflow-row', key: row.id },
          h('input', {
            type: 'checkbox',
            id: 'ragflow-dataset-' + row.id,
            checked: draft.includes(row.id),
            disabled: saveState === 'saving',
            onChange: () => {
              toggle(row.id)
            }
          }),
          h('label', { className: 'dsh-ragflow-name', htmlFor: 'ragflow-dataset-' + row.id }, row.name),
          h(
            'span',
            { className: 'dsh-ragflow-meta' },
            String(row.chunkCount) + ' ' + String(t('chunks')) + ' · ' + String(row.documentCount) + ' ' + String(t('documents'))
          )
        )
      )

      let statusLine = null
      if (saveState === 'error') statusLine = h('p', { className: 'dsh-ragflow-status', 'data-tone': 'error' }, String(t('saveFailed')))
      else if (saveState === 'saved' && !dirty) statusLine = h('p', { className: 'dsh-ragflow-status', 'data-tone': 'success' }, String(t('saved')))
      else if (state.status === 'loading') statusLine = h('p', { className: 'dsh-ragflow-status' }, String(t('loading')))
      else if (state.status === 'error')
        statusLine = h('p', { className: 'dsh-ragflow-status', 'data-tone': 'error' }, String(t('loadFailed')) + ': ' + state.error)

      return h(
        'div',
        { className: 'dsh-ragflow', 'data-ragflow-settings': true },
        h('p', { className: 'dsh-ragflow-hint' }, String(t('hint'))),
        h(
          'div',
          { className: 'dsh-ragflow-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ragflow-btn',
              disabled: state.status !== 'ready',
              onClick: () => {
                setSaveState('idle')
                setDraft(state.datasets.map((row) => row.id))
              }
            },
            String(t('selectAll'))
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ragflow-btn',
              disabled: state.status !== 'ready',
              onClick: () => {
                setSaveState('idle')
                setDraft([])
              }
            },
            String(t('selectNone'))
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ragflow-btn',
              disabled: saveState === 'saving',
              onClick: () => {
                void load()
              }
            },
            String(t('refresh'))
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ragflow-btn',
              'data-primary': true,
              disabled: state.status !== 'ready' || saveState === 'saving' || !dirty,
              onClick: () => {
                void save()
              }
            },
            String(saveState === 'saving' ? t('saving') : t('save'))
          )
        ),
        statusLine,
        state.datasets.length === 0 && state.status === 'ready'
          ? h('p', { className: 'dsh-ragflow-status' }, String(t('empty')))
          : h('ul', { className: 'dsh-ragflow-list' }, rows),
        state.configPath.length > 0
          ? h('p', { className: 'dsh-ragflow-path' }, String(t('configPath')) + ': ' + state.configPath)
          : null
      )
    }

    /**
     * The composer seat: a compact trigger beside the permission selector that
     * opens a per-session checklist. Everything is scoped to one sessionId, so
     * two conversations never share a choice.
     */
    function SessionKnowledgePicker(props) {
      const t = props.t
      const sessionId = props.sessionId
      const [state, setState] = React.useState({ status: 'idle', datasets: [], selected: [], inherited: true, error: '' })
      const [draft, setDraft] = React.useState([])
      const [open, setOpen] = React.useState(false)
      const [saveState, setSaveState] = React.useState('idle')

      const load = React.useCallback(async () => {
        if (!sessionId) return
        setState((previous) => ({ ...previous, status: 'loading', error: '' }))
        try {
          const data = await readSession(sessionId)
          if (data.ok !== true) throw new Error(String(data.error || 'request failed'))
          const selected = Array.isArray(data.selected) ? data.selected : []
          setState({
            status: 'ready',
            datasets: Array.isArray(data.datasets) ? data.datasets : [],
            selected,
            inherited: data.inherited !== false,
            error: ''
          })
          setDraft(selected)
        } catch (error) {
          setState({ status: 'error', datasets: [], selected: [], inherited: true, error: String((error && error.message) || error) })
        }
      }, [sessionId])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event && event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      const commit = async (next) => {
        setSaveState('saving')
        setDraft(next)
        try {
          const result = await writeSession(sessionId, next)
          if (result && result.ok === true) {
            const selected = Array.isArray(result.selected) ? result.selected : next
            setState((previous) => ({ ...previous, selected, inherited: false }))
            setDraft(selected)
            setSaveState('saved')
          } else {
            setSaveState('error')
          }
        } catch {
          setSaveState('error')
        }
      }

      const toggle = (id) => {
        const next = draft.includes(id) ? draft.filter((value) => value !== id) : [...draft, id]
        void commit(next)
      }

      const count = state.selected.length
      const none = state.status === 'ready' && count === 0
      const triggerLabel = String(t('sessionButton'))

      const rows = state.datasets.map((row) =>
        h(
          'li',
          { className: 'dsh-ragflow-row', key: row.id },
          h('input', {
            type: 'checkbox',
            id: 'ragflow-session-' + row.id,
            checked: draft.includes(row.id),
            disabled: saveState === 'saving',
            onChange: () => {
              toggle(row.id)
            }
          }),
          h('label', { className: 'dsh-ragflow-name', htmlFor: 'ragflow-session-' + row.id }, row.name),
          h('span', { className: 'dsh-ragflow-meta' }, String(row.chunkCount) + ' ' + String(t('chunks')))
        )
      )

      let statusLine = null
      if (state.status === 'loading' || state.status === 'idle') statusLine = h('p', { className: 'dsh-ragflow-status' }, String(t('loading')))
      else if (state.status === 'error')
        statusLine = h('p', { className: 'dsh-ragflow-status', 'data-tone': 'error' }, String(t('sessionLoadFailed')) + ': ' + state.error)
      else if (saveState === 'error') statusLine = h('p', { className: 'dsh-ragflow-status', 'data-tone': 'error' }, String(t('sessionSaveFailed')))
      else if (state.inherited) statusLine = h('p', { className: 'dsh-ragflow-status' }, String(t('sessionInherited')))
      else if (none) statusLine = h('p', { className: 'dsh-ragflow-status', 'data-tone': 'error' }, String(t('sessionEmpty')))
      else statusLine = h('p', { className: 'dsh-ragflow-status', 'data-tone': 'success' }, String(t('sessionOverride')))

      const trigger = h(
        'button',
        {
          type: 'button',
          className: 'dsh-ragflow-trigger',
          'data-state': none ? 'none' : 'some',
          'data-ragflow-session-trigger': sessionId || '',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: String(t('sessionTitle')),
          disabled: !sessionId || props.locked === true,
          onClick: () => {
            setOpen(!open)
            if (!open) void load()
          }
        },
        h('span', null, triggerLabel),
        state.status === 'ready' ? h('span', { className: 'dsh-ragflow-trigger-badge' }, String(count)) : null
      )

      if (!open) return trigger

      // Fixed overlays must portal to the document body: the docked composer
      // contains (and would clip) a position:fixed child.
      const panel = h(
        'div',
        {
          className: 'dsh-ragflow-mask',
          onClick: () => {
            setOpen(false)
          }
        },
        h(
          'div',
          {
            className: 'dsh-ragflow-pop',
            role: 'dialog',
            'aria-modal': true,
            'aria-label': String(t('sessionTitle')),
            onClick: (event) => {
              event.stopPropagation()
            }
          },
          h('div', { className: 'dsh-ragflow-pop-head' }, h('p', { className: 'dsh-ragflow-pop-title' }, String(t('sessionTitle')))),
          h('p', { className: 'dsh-ragflow-hint' }, String(t('sessionHint'))),
          statusLine,
          state.datasets.length === 0 && state.status === 'ready'
            ? h('p', { className: 'dsh-ragflow-status' }, String(t('empty')))
            : h('ul', { className: 'dsh-ragflow-list' }, rows),
          h(
            'div',
            { className: 'dsh-ragflow-pop-foot' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ragflow-btn',
                disabled: saveState === 'saving',
                onClick: () => {
                  void commit([])
                }
              },
              String(t('selectNone'))
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ragflow-btn',
                'data-primary': true,
                disabled: saveState === 'saving',
                onClick: () => {
                  setOpen(false)
                }
              },
              String(t('sessionClose'))
            )
          )
        )
      )

      let mounted = panel
      try {
        mounted = require('react-dom').createPortal(panel, document.body)
      } catch {
        // No react-dom in this module table: render inline rather than vanish.
        mounted = null
      }
      return h(React.Fragment, null, trigger, mounted)
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ragflow-settings: dictionaries')
      ctx.effect(injectStyle, 'ragflow-settings: styles')
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.item', () =>
            ctx.slots.register(
              {
                name: 'plugins.item',
                id: 'ragflow-settings',
                order: 60,
                label: () => String(t('title')),
                locale: NS
              },
              (props) => h(RagflowCard, { ...props, t: props.t || t })
            )
          ),
        'ragflow-settings: plugins page card'
      )
      // 'conversation.input.permission' is declared kind:"single" and is already
      // taken by client-ui-permission-presets, so a second registration there is
      // silently dropped (or shadows their UI). 'conversation.input.left' is the
      // list slot on the same composer tool row, directly beside that control.
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'ragflow-session-knowledge',
                order: 40,
                locale: NS
              },
              (props) => h(SessionKnowledgePicker, { ...props, t: props.t || t })
            )
          ),
        'ragflow-settings: composer session knowledge base seat'
      )
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
