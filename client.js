/**
 * Settings page: pick which cc-switch tool groups feed the model picker.
 *
 * Styled to sit inside the host's settings shell: theme tokens only, hairline-separated rows,
 * host type sizes (13/12), and the shell's switch language instead of custom controls.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cc-switch-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ENDPOINT = '/dsh-cc-switch/state'

    const CSS = `
.ccs-page { display: flex; flex-direction: column; gap: 28px; max-width: 660px; padding-bottom: 24px; }
.ccs-group { display: flex; flex-direction: column; gap: 8px; }
.ccs-group-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0 0 2px; }
.ccs-list { display: flex; flex-direction: column; }
.ccs-row { display: flex; align-items: center; gap: 16px; padding: 13px 0; cursor: pointer; }
.ccs-row + .ccs-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.ccs-row:hover .ccs-row-title { color: var(--dsw-alias-brand-primary); }
.ccs-row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.ccs-row-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); transition: color 120ms ease; }
.ccs-row-desc { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ccs-row-static { cursor: default; }
.ccs-row[draggable='true'] { cursor: grab; }
.ccs-row-dragging { opacity: 0.45; }
.ccs-row-over { box-shadow: inset 0 2px 0 var(--dsw-alias-brand-primary); }
.ccs-grip { flex: none; width: 12px; font-size: 12px; line-height: 1; letter-spacing: -1px; color: var(--dsw-alias-label-caption); user-select: none; }
@media (prefers-reduced-motion: reduce) { .ccs-row { transition: none; } }
.ccs-row-static:hover .ccs-row-title { color: var(--dsw-alias-label-primary); }
.ccs-tag { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ccs-switch { position: relative; flex: none; width: 34px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); padding: 0; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
.ccs-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.ccs-switch:disabled { opacity: 0.45; cursor: default; }
.ccs-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.ccs-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-bg-base); box-shadow: 0 1px 2px rgba(0,0,0,0.18); transition: transform 140ms ease; }
.ccs-switch[aria-checked='true']::after { transform: translateX(14px); }
.ccs-note { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin: 0; }
.ccs-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 4px; }
.ccs-status-text { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ccs-action { font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 5px 10px; cursor: pointer; transition: background 120ms ease, border-color 120ms ease; }
.ccs-action:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.ccs-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.ccs-action:disabled { color: var(--dsw-alias-label-secondary); cursor: default; }
.ccs-error { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-error-primary); margin: 0; }
.ccs-pending { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; }
@media (prefers-reduced-motion: reduce) { .ccs-row-title, .ccs-switch, .ccs-switch::after, .ccs-action { transition: none; } }
`

    async function request(method, payload) {
      const response = await fetch(ENDPOINT, {
        method,
        headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'ccs-switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: (event) => {
          event.stopPropagation()
          onChange(!checked)
        },
      })
    }

    function Group({ group, checked, busy, summary, onToggle }) {
      return h(
        'div',
        {
          className: 'ccs-row',
          onClick: (event) => {
            if (event.target.closest('.ccs-switch')) return
            if (!busy) onToggle(!checked)
          },
        },
        h(
          'div',
          { className: 'ccs-row-text' },
          h('span', { className: 'ccs-row-title' }, group.label),
          h('span', { className: 'ccs-row-desc' }, summary),
        ),
        h(Switch, { checked, disabled: busy, label: group.label, onChange: onToggle }),
      )
    }

    function Section({ title, note, children }) {
      return h(
        'section',
        { className: 'ccs-group' },
        h('h3', { className: 'ccs-group-title' }, title),
        h('div', { className: 'ccs-list' }, children),
        note ? h('p', { className: 'ccs-note' }, note) : null,
      )
    }

    function Page() {
      const [snapshot, setSnapshot] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [dragRoute, setDragRoute] = React.useState(undefined)
      const [overRoute, setOverRoute] = React.useState(undefined)

      React.useEffect(() => {
        let alive = true
        request('GET')
          .then((body) => alive && setSnapshot(body))
          .catch((cause) => alive && setError(String(cause?.message ?? cause)))
        return () => {
          alive = false
        }
      }, [])

      const save = (apps, order) => {
        setBusy(true)
        setError(undefined)
        request('POST', { apps, order })
          .then((body) => setSnapshot(body))
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false))
      }

      if (!snapshot) {
        return h(
          'div',
          { className: 'ccs-page' },
          h('style', {}, CSS),
          h('p', { className: 'ccs-pending' }, error ? `无法读取 cc-switch 配置：${error}` : '读取中…'),
        )
      }

      const importable = snapshot.groups.filter((group) => group.importable)
      const others = snapshot.groups.filter((group) => !group.importable)
      const selected = snapshot.selected ?? []
      const bridged = snapshot.bridged ?? []
      const codexCount = (snapshot.codex ?? []).length
      const modelCount = bridged.reduce((total, provider) => total + provider.models.length, 0)
      const thinkingCount = bridged.filter((provider) => provider.thinking).length

      const bridgedRoutes = bridged.map((provider) => provider.route)
      const codexRoutes = (snapshot.codex ?? []).map((provider) => provider.route)
      const orderNow = () => [...bridgedRoutes, ...codexRoutes]

      const withApp = (app, on) => {
        const next = selected.filter((item) => item !== app)
        if (on) next.push(app)
        save(next, orderNow())
      }

      // Rows stay inside their own section; the saved order is one list for the whole page.
      const moveTo = (routes, target) => {
        if (!dragRoute || dragRoute === target) return routes
        const next = routes.filter((route) => route !== dragRoute)
        const at = next.indexOf(target)
        if (at < 0) return routes
        next.splice(at, 0, dragRoute)
        return next
      }
      const dropClaude = (target) => save(selected, [...moveTo(bridgedRoutes, target), ...codexRoutes])
      const dropCodex = (target) => save(selected, [...bridgedRoutes, ...moveTo(codexRoutes, target)])
      const dragProps = (route, onDrop) => ({
        draggable: !busy,
        title: '拖动调整顺序',
        onDragStart: (event) => {
          event.dataTransfer?.setData('text/plain', route)
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
          setDragRoute(route)
        },
        onDragOver: (event) => {
          event.preventDefault()
          if (dragRoute && dragRoute !== route) setOverRoute(route)
        },
        onDragLeave: () => setOverRoute((current) => (current === route ? undefined : current)),
        onDrop: (event) => {
          event.preventDefault()
          onDrop(route)
          setDragRoute(undefined)
          setOverRoute(undefined)
        },
        onDragEnd: () => {
          setDragRoute(undefined)
          setOverRoute(undefined)
        },
      })
      const rowClass = (route) =>
        `ccs-row ccs-row-static${overRoute === route ? ' ccs-row-over' : ''}${dragRoute === route ? ' ccs-row-dragging' : ''}`

      const describe = (group) => {
        const formats = group.formats.filter((format) => format !== 'unknown')
        const parts = [`${group.count} 个供应商`]
        if (group.appType === 'codex') {
          parts.push(codexCount > 0 ? `已交给 pi-ai 的 ${codexCount} 组` : '由内置 pi-ai 适配器接入')
        } else if (selected.includes(group.appType)) {
          parts.push(`${bridged.length} 条路由已生效`)
        }
        if (formats.length > 0) parts.push(formats.join(' / '))
        return parts.join(' · ')
      }

      return h(
        'div',
        { className: 'ccs-page' },
        h('style', {}, CSS),
        h(
          Section,
          { title: '导入来源' },
          importable.length === 0
            ? h('p', { className: 'ccs-note' }, '这个 cc-switch 里没有可导入的分组。')
            : importable.map((group) =>
                h(Group, {
                  key: group.appType,
                  group,
                  checked: selected.includes(group.appType),
                  busy,
                  summary: describe(group),
                  onToggle: (on) => withApp(group.appType, on),
                }),
              ),
        ),
        others.length > 0
          ? h(
              Section,
              { title: '暂不支持', note: '这些分组使用 Harness 尚未实现的协议，因此列出来而不是隐藏。' },
              others.map((group) =>
                h(
                  'div',
                  { key: group.appType, className: 'ccs-row ccs-row-static' },
                  h(
                    'div',
                    { className: 'ccs-row-text' },
                    h('span', { className: 'ccs-row-title' }, group.label),
                    h('span', { className: 'ccs-row-desc' }, `${group.count} 个供应商 · ${group.formats.join(' / ')}`),
                  ),
                  h('span', { className: 'ccs-tag' }, '不可导入'),
                ),
              ),
            )
          : null,
        bridged.length > 0
          ? h(
              Section,
              {
                title: '已桥接',
                note: `共 ${bridged.length} 个 provider、${modelCount} 个模型，其中 ${thinkingCount} 个带思考等级。拖动行可调整它们在模型选择器里的分组顺序。`,
              },
              bridged.map((provider) =>
                h(
                  'div',
                  { key: provider.route, className: rowClass(provider.route), ...dragProps(provider.route, dropClaude) },
                  h('span', { className: 'ccs-grip', 'aria-hidden': 'true' }, '⠿'),
                  h(
                    'div',
                    { className: 'ccs-row-text' },
                    h('span', { className: 'ccs-row-title' }, provider.name),
                    h('span', { className: 'ccs-row-desc' }, provider.models.join('、')),
                  ),
                  h('span', { className: 'ccs-tag' }, `${provider.models.length} 个模型`),
                ),
              ),
            )
          : null,
        (snapshot.codex ?? []).length > 0
          ? h(
              Section,
              {
                title: '已交给 pi-ai',
                note: 'Codex 分组交给 Harness 内置的 pi-ai 适配器，模型选择器里按 provider 分组出现。',
              },
              snapshot.codex.map((provider) =>
                h(
                  'div',
                  { key: provider.route, className: rowClass(provider.route), ...dragProps(provider.route, dropCodex) },
                  h('span', { className: 'ccs-grip', 'aria-hidden': 'true' }, '⠿'),
                  h(
                    'div',
                    { className: 'ccs-row-text' },
                    h('span', { className: 'ccs-row-title' }, provider.name ?? provider.route),
                    h('span', { className: 'ccs-row-desc' }, (provider.models ?? []).join('、')),
                  ),
                  h('span', { className: 'ccs-tag' }, `${(provider.models ?? []).length} 个模型 · ${provider.api ?? 'codex'}`),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'ccs-status' },
          h(
            'span',
            { className: 'ccs-status-text' },
            snapshot.at ? `上次同步 ${new Date(snapshot.at).toLocaleString()}` : '尚未同步',
            codexCount > 0 ? ` · Codex ${codexCount} 组` : '',
          ),
          h(
            'button',
            { type: 'button', className: 'ccs-action', disabled: busy, onClick: () => save(selected, orderNow()) },
            busy ? '同步中…' : '重新同步',
          ),
        ),
        error ? h('p', { className: 'ccs-error' }, error) : null,
        (snapshot.errors ?? []).length > 0 ? h('p', { className: 'ccs-error' }, snapshot.errors.join('；')) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-cc-switch-bridge', order: 120, label: () => 'cc-switch-bridge' }, Page),
        )
      },
    }
  },
})
