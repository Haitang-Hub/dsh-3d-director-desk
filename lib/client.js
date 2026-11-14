/**
 * dsh-3d-director-desk 客户端入口（可直接加载的单文件模块，无 JSX、无构建依赖）。
 *
 * 形态：DSH **右侧栏面板**，不是工作台分栏。
 *   - 会话保持整页宽度（宿主自己的布局不动）；
 *   - 导演台画布停靠在右侧栏的一个标签页里，可拖动、可拆分、可全屏；
 *   - 用户从右侧栏「开始」引导页点「3D 导演台」即可打开，之后作为普通标签保留。
 *
 * 扩展面（与宿主自带 panel 一致）：
 *   ctx.sidebarRightTabs.register(definition)   ← 声明标签类型与引导页入口
 *   ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id })  ← 标签正文
 *
 * 画布本体仍是 iframe（React 19 + three.js 应用跑在桥自伺服的站点上）；
 * iframe 内部 DOM 不参与宿主拖拽协议，所以面板不设工具栏标记。
 */

window.__ModuleLoader__.load({
  id: '@haitang-hub/dsh-3d-director-desk',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const TAB_ID = 'dsh-3d-director-desk'
    const TAB_KIND = 'director-desk'

    // 快捷键「主键+Shift+D 打开导演台」：id 即命令 id，guide 条目按登记结果带 commandId。
    // Web 白名单允许「主键+Shift/Alt+字母」，与 dsh-pet 的 Ctrl+Shift+P 同族不冲突。
    const DESK_COMMAND_ID = 'director-desk.open'
    const DESK_BINDING = { code: 'KeyD', modifiers: ['primary', 'shift'] }
    const SHORTCUT_PROFILES = ['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows']

    // 开始页入口图标：宿主按 entry.icon ?? CubeGlyph 渲染，不传就退化成通用立方体。
    // 内联 SVG 用 currentColor，跟随宿主明暗主题。
    function DirectorGuideIcon({ size = 24 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 3, y: 7, width: 12.5, height: 10, rx: 2.5 }),
        h('path', { d: 'M15.5 10.4 21 7.8v8.4l-5.5-2.6' }),
        h('circle', { cx: 9.25, cy: 12, r: 2.1 }),
      )
    }

    const SHELL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      minHeight: 0,
      minWidth: 0,
      overflow: 'hidden',
      background: '#0b0b0d',
    }
    const TOOLBAR_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 10px',
      flex: '0 0 auto',
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)',
      borderBottom: '1px solid var(--dsw-alias-border-l2)',
    }
    const IFRAME_STYLE = {
      flex: '1 1 auto',
      width: '100%',
      border: 'none',
      minHeight: 0,
      minWidth: 0,
      background: '#0b0b0d',
    }
    const PLACEHOLDER_STYLE = {
      flex: 1,
      display: 'grid',
      placeItems: 'center',
      color: 'var(--dsw-alias-label-tertiary)',
      padding: 24,
      textAlign: 'center',
      lineHeight: 1.6,
      fontSize: 12,
    }
    const LINK_BUTTON_STYLE = {
      cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l3)',
      borderRadius: 6,
      padding: '2px 8px',
      background: 'transparent',
      color: 'inherit',
      fontSize: 12,
    }

    function statusText(info) {
      if (info === undefined) return '导演台连接中…'
      return info.ready ? '导演台已连接' : '导演台未就绪'
    }

    /** 桥 origin：host 由 bridge-info 下发（默认 127.0.0.1），不要写死。 */
    function bridgeOrigin(info) {
      return `http://${info?.host || '127.0.0.1'}:${info?.port}`
    }

    /** 轮询本地桥状态；失败时降级，并把原因留给占位文案。与服务端 8s 心跳同节奏。 */
    function useBridgeInfo() {
      const [info, setInfo] = useState(undefined)
      useEffect(() => {
        let alive = true
        const load = () => fetch('/api/director-desk.bridge-info')
          .then(response => response.json())
          .then(data => { if (alive) setInfo(data) })
          .catch(() => { if (alive) setInfo({ ready: false, error: 'bridge-info unreachable' }) })
        load()
        const timer = setInterval(load, 8000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return info
    }

    /** 右侧栏标签正文：工具栏 + 导演台画布。 */
    function DirectorDeskTab({ useTabInfo }) {
      const info = useBridgeInfo()
      const iframeRef = useRef(null)
      // 画布插件经 sidebarRight.openTab('director-desk', { params: { instanceId } }) 打开本标签时，
      // 导航参数带目标实例：iframe 据此加载 /director/editor?instanceId=...（无参保持根路径旧行为）。
      const tabInfo = useTabInfo()
      const instanceId = tabInfo?.tab?.navigation?.params?.instanceId
      const [nonce, setNonce] = useState(0)
      // 设置同步令牌：写进 iframe URL，只有携带它的消息才会被接受/回发。
      // 独立打开的页面没有令牌，设置桥保持惰性。
      const [settingsToken] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36))
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState('')

      // Harness 模型代理：iframe 里的 AI 助手经 postMessage 请求宿主模型目录/代发对话，
      // 这里转成同源 /api/director-desk.harness-* 请求（密钥只在宿主进程内）。
      // 只认本标签 iframe 发来的消息（event.source 校验），响应按消息来源 origin 回发。
      // 中继 origin：桌面端 shell 的 origin 是 dsh-app:// 自定义协议，node 进程无法直连；
      // 插件若经 bridge-info 下发回环中继地址（harnessRelayOrigin）则优先使用。
      const relayOriginRef = useRef(window.location.origin)
      const relayOrigin = info?.harnessRelayOrigin
      useEffect(() => {
        if (relayOrigin) relayOriginRef.current = relayOrigin
      }, [relayOrigin])
      useEffect(() => {
        const API = '/api/director-desk'
        const onMessage = (event) => {
          const iframe = iframeRef.current
          if (!iframe || event.source !== iframe.contentWindow) return
          const data = event.data
          if (!data || typeof data !== 'object' || data.type !== 'dsh-harness:request') return
          const requestId = String(data.requestId || '')
          const reply = (payload) => {
            try {
              // sourceOrigin：iframe 里的页面据此拼出桥可直连的 harness 端点绝对地址
              iframe.contentWindow?.postMessage({ type: 'dsh-harness:response', requestId, sourceOrigin: relayOriginRef.current, ...payload }, event.origin || '*')
            } catch { /* iframe 已卸载 */ }
          }
          if (data.action === 'models') {
            fetch(`${API}.harness-models`)
              .then((response) => response.json())
              .then((body) => reply(body && typeof body === 'object' ? body : { ok: false, error: 'invalid response' }))
              .catch((error) => reply({ ok: false, error: String(error?.message ?? error) }))
            return
          }
          if (data.action === 'chat') {
            fetch(`${API}.harness-chat`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(data.payload && typeof data.payload === 'object' ? data.payload : {}),
            })
              .then((response) => response.json())
              .then((body) => reply(body && typeof body === 'object' ? body : { ok: false, error: 'invalid response' }))
              .catch((error) => reply({ ok: false, error: String(error?.message ?? error) }))
            return
          }
          reply({ ok: false, error: `unknown action: ${String(data.action)}` })
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      // 导演台注册表中继：iframe 里的编辑器在新建/重命名/删除/打开工程后上报
      // { type: 'storyai:director-desk-registry-sync', payload: { desks } }，这里经宿主页内
      // 的 BroadcastChannel 扇出给画布插件（画布节点名称与导演台保持一致）；
      // 画布加载时经同一频道发 query，这里转成对 iframe 的查询消息让它立即回推全量。
      useEffect(() => {
        let channel
        try { channel = new BroadcastChannel(DESKS_CHANNEL) } catch { return }
        const iframeMessage = (payload) => {
          try { iframeRef.current?.contentWindow?.postMessage(payload, '*') } catch { /* iframe 已卸载 */ }
        }
        const onMessage = (event) => {
          const iframe = iframeRef.current
          if (!iframe || event.source !== iframe.contentWindow) return
          const data = event.data
          if (!data || typeof data !== 'object' || data.type !== 'storyai:director-desk-registry-sync') return
          try { channel.postMessage({ type: 'director-desks:sync', desks: Array.isArray(data.payload?.desks) ? data.payload.desks : [] }) } catch { /* 忽略 */ }
        }
        channel.onmessage = (event) => {
          const data = event.data
          if (data && typeof data === 'object' && data.type === 'director-desks:query') {
            iframeMessage({ type: 'storyai:director-desk-registry-query' })
          }
        }
        window.addEventListener('message', onMessage)
        return () => {
          window.removeEventListener('message', onMessage)
          try { channel?.close() } catch { /* 忽略 */ }
        }
      }, [])

      // 共享设置同步：设置页保存后宿主把 settings.json 下发到 iframe；页面内的应用
      // 只在令牌匹配时接收/上报（独立打开页面没有令牌，完全惰性）。
      useEffect(() => {
        if (!info?.ready) return
        let putTimer = 0
        let pending = null
        const iframeMessage = (payload) => {
          try { iframeRef.current?.contentWindow?.postMessage(payload, bridgeOrigin(info)) } catch { /* iframe 已卸载 */ }
        }
        const pushHostSettings = () => {
          fetch(SHARED_SETTINGS_API, { cache: 'no-store' })
            .then(response => response.json())
            .then(body => {
              if (!body?.ok) return
              iframeMessage({ type: 'dsh-settings:apply', token: settingsToken, project: SHARED_PROJECT_ID, settings: body.settings })
            })
            .catch(() => { /* 宿主不可用时由应用本地配置兜底 */ })
        }
        const flushReport = () => {
          const body = pending
          pending = null
          if (!body) return
          fetch(SHARED_SETTINGS_API, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then(response => response.json())
            .then(result => { if (result?.ok) notifySettingsChanged() })
            .catch(() => { /* 下次编辑会再上报 */ })
        }
        const onMessage = (event) => {
          const iframe = iframeRef.current
          if (!iframe || event.source !== iframe.contentWindow) return
          const data = event.data
          if (!data || typeof data !== 'object' || data.token !== settingsToken) return
          if (data.type === 'dsh-settings:ready' || data.type === 'dsh-settings:request') {
            pushHostSettings()
            return
          }
          if (data.type === 'dsh-settings:report') {
            if (data.dshSettingsProject && data.dshSettingsProject !== SHARED_PROJECT_ID) return
            const now = Date.now()
            const project = data.project && typeof data.project === 'object' ? data.project : null
            const patch = { ...(project || {}) }
            // 渠道只写回本项目的分区；顶层 channels 会被服务端扇出到两个项目。
            if (Array.isArray(data.channels)) {
              patch.channels = data.channels
              patch.channelsUpdatedAt = now
            }
            if (Object.keys(patch).length === 0) return
            pending = { projects: { [SHARED_PROJECT_ID]: { ...patch, updatedAt: now } } }
            clearTimeout(putTimer)
            putTimer = setTimeout(flushReport, 600)
          }
        }
        window.addEventListener('message', onMessage)
        window.addEventListener(SETTINGS_CHANGED_EVENT, pushHostSettings)
        let channel
        try { channel = new BroadcastChannel(SETTINGS_CHANNEL); channel.onmessage = pushHostSettings } catch { /* 忽略 */ }
        if (iframeRef.current) pushHostSettings()
        return () => {
          window.removeEventListener('message', onMessage)
          window.removeEventListener(SETTINGS_CHANGED_EVENT, pushHostSettings)
          try { channel?.close() } catch { /* 忽略 */ }
          clearTimeout(putTimer)
        }
      }, [info?.ready, info?.host, info?.port, settingsToken])

      // 手动重建桥：宿主端 POST 会杀子进程并重新拉起，随后状态由 5s 轮询刷新。
      const restartBridge = () => {
        setBusy(true)
        setActionError('')
        fetch('/api/director-desk.restart-bridge', { method: 'POST' })
          .then(response => response.json())
          .then(data => {
            if (data && data.ready === false) setActionError(String(data.error || '桥仍未就绪'))
            setNonce(value => value + 1)
          })
          .catch(error => setActionError(String(error?.message ?? error)))
          .finally(() => setBusy(false))
      }

      // 新窗口带 dshWindow=1：页面经同源 BroadcastChannel 跟随本 iframe 的共享设置、Harness 模型与实例。
      const openExternal = () => {
        if (!info?.port) return
        const base = `${bridgeOrigin(info)}/${instanceId ? `director/editor?instanceId=${encodeURIComponent(instanceId)}` : ''}`
        const query = `dshWindow=1&dshSettingsProject=${SHARED_PROJECT_ID}`
        window.open(`${base}${base.includes('?') ? '&' : '?'}${query}`, '_blank', 'noopener')
      }

      return h('div', { style: SHELL_STYLE },
        h('div', { style: TOOLBAR_STYLE },
          h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '导演台'),
          h('span', { title: info?.error ? String(info.error) : '' }, statusText(info)),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            style: LINK_BUTTON_STYLE,
            disabled: !info?.ready,
            onClick: openExternal,
            title: '在独立窗口打开画布（面板太窄时更好用）',
          }, '新窗口'),
          h('button', {
            type: 'button',
            style: LINK_BUTTON_STYLE,
            disabled: busy,
            onClick: restartBridge,
            title: '重建本地导演台服务（不用重启应用）',
          }, busy ? '重启中…' : '重启服务'),
          h('button', {
            type: 'button',
            style: LINK_BUTTON_STYLE,
            onClick: () => setNonce(value => value + 1),
            title: '重新加载画布（不改场景数据）',
          }, '刷新'),
        ),
        info?.ready
          ? h('iframe', {
            key: `${instanceId || 'root'}#${nonce}`,
            ref: iframeRef,
            src: (() => {
              const base = `${bridgeOrigin(info)}/${instanceId ? `director/editor?instanceId=${encodeURIComponent(instanceId)}` : ''}`
              const query = `dshSettingsToken=${encodeURIComponent(settingsToken)}&dshSettingsProject=${SHARED_PROJECT_ID}`
              return `${base}${base.includes('?') ? '&' : '?'}${query}`
            })(),
            title: '3D 导演台',
            style: IFRAME_STYLE,
            'data-dsh-no-drag': '',
          })
          : h('div', { style: PLACEHOLDER_STYLE },
            h('div', null,
              h('p', { style: { margin: '0 0 6px' } }, '导演台服务未就绪。'),
              h('p', { style: { margin: 0 } },
                info?.error ? String(info.error).slice(0, 200) : '正在启动本地服务（首次约几秒）…'),
              h('p', { style: { margin: '6px 0 0' } },
                '插件每 8 秒自动重试一次；也可以点上方「重启服务」立刻重建。'),
              actionError ? h('p', { style: { margin: '6px 0 0', color: '#d25555' } }, actionError) : null,
            ),
          ),
      )
    }

    // ── 「3D 导演台」设置页 ──────────────────────────────────────────────────
    // 每个插件只注册自己的分区（id 带项目后缀）：导航里分别出现「3D 导演台」与
    // 「3D 导演台」，两边渠道与默认值互不影响。数据同存
    // ~/.dsh/haitang-aigc/settings.json 的 projects.<id>。
    // 两个客户端里的这段代码保持同构，由项目 id / 端点占位符与 TEXT_MODELS_ONLY 区分。
    const SHARED_PROJECT_ID = 'director-desk'
    const SETTINGS_SECTION_ID = `haitang-aigc-${SHARED_PROJECT_ID}`
    const SETTINGS_ORDER = 32
    const SETTINGS_LABEL = '3D 导演台'
    const SETTINGS_ICON = DirectorGuideIcon
    const TEXT_MODELS_ONLY = true
    const SHARED_SETTINGS_API = '/api/director-desk.shared-settings'
    const HARNESS_MODELS_API = '/api/director-desk.harness-models'
    const SETTINGS_CHANGED_EVENT = 'haitang-aigc:settings-changed'
    const SETTINGS_CHANNEL = 'haitang-aigc:settings'
    // 导演台工程注册表扇出频道：导演台 iframe → 本插件 → 画布插件 iframe（节点名称跟随导演台）。
    const DESKS_CHANNEL = 'haitang-aigc:director-desks'
    const SETTINGS_CSS_ID = 'haitang-aigc/settings.css'

    const SETTINGS_SERVICES = [
      { id: SHARED_PROJECT_ID, name: SETTINGS_LABEL, info: '/api/director-desk.bridge-info', restart: '/api/director-desk.restart-bridge' },
    ]
    const CAPABILITIES = [
      { value: 'text', label: '文本' },
      { value: 'image', label: '图片' },
      { value: 'video', label: '视频' },
      { value: 'audio', label: '语音' },
    ]
    const API_FORMATS = [
      { value: 'openai', label: 'OpenAI 兼容' },
      { value: 'gemini', label: 'Gemini' },
      { value: 'anthropic', label: 'Anthropic' },
    ]
    const IMAGE_RATIOS = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9']
      .map(value => ({ value, label: value === 'auto' ? '自动' : value }))
    const VIDEO_RATIOS = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
      .map(value => ({ value, label: value === 'auto' ? '自动' : value }))

    const SETTINGS_CSS = [
      '.dsh-aigc-cfg{display:flex;flex-direction:column;gap:14px;max-width:720px;padding:4px 2px 32px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}',
      '.dsh-aigc-cfg__title{margin:0;font-size:18px;font-weight:600;line-height:1.4}',
      '.dsh-aigc-cfg__lead{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-aigc-cfg__card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-aigc-cfg__cardHead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.dsh-aigc-cfg__cardTitle{font-size:14px;font-weight:600}',
      '.dsh-aigc-cfg__hint,.dsh-aigc-cfg__note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-word}',
      '.dsh-aigc-cfg__grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 16px}',
      '.dsh-aigc-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dsh-aigc-cfg__flabel{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-aigc-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
      '.dsh-aigc-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-aigc-cfg__toggle{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;min-width:0}',
      '.dsh-aigc-cfg__toggle input{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-aigc-cfg__btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dsh-aigc-cfg__btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}',
      '.dsh-aigc-cfg__btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dsh-aigc-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}',
      '.dsh-aigc-cfg__btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}',
      '.dsh-aigc-cfg__btn.is-sm{height:24px;padding:0 8px}',
      '.dsh-aigc-cfg__btn.is-ghost{border-color:transparent}',
      '.dsh-aigc-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-aigc-cfg__services{display:flex;flex-direction:column;gap:10px}',
      '.dsh-aigc-cfg__service{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-interactive-bg-active)}',
      '.dsh-aigc-cfg__serviceHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-aigc-cfg__serviceName{font-weight:600}',
      '.dsh-aigc-cfg__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}',
      '.dsh-aigc-cfg__dot.is-ok{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-aigc-cfg__serviceState{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-aigc-cfg__serviceMeta{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dsh-aigc-cfg__warn{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;word-break:break-word}',
      '.dsh-aigc-cfg__row{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}',
      '.dsh-aigc-cfg__channel{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
      '.dsh-aigc-cfg__channelHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-aigc-cfg__channelName{font-weight:600;word-break:break-all}',
      '.dsh-aigc-cfg__badge{padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;white-space:nowrap}',
      '.dsh-aigc-cfg__spacer{flex:1}',
      '.dsh-aigc-cfg__models{display:flex;flex-direction:column;gap:6px}',
      '.dsh-aigc-cfg__modelsHead{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-aigc-cfg__modelRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-aigc-cfg__modelRow .dsh-aigc-cfg__inp{flex:1;min-width:140px}',
      '.dsh-aigc-cfg__modelRow select{flex:none;width:110px}',
      '.dsh-aigc-cfg__tabs{display:flex;gap:6px;flex-wrap:wrap}',
      '.dsh-aigc-cfg__tab{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-aigc-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '.dsh-aigc-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}',
      '.dsh-aigc-cfg__msg{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.dsh-aigc-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}',
    ].join('\n')

    function injectSettingsCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${SETTINGS_CSS_ID}"]`)) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', SETTINGS_CSS_ID)
      style.textContent = SETTINGS_CSS
      document.head.appendChild(style)
    }

    function cloneJson(value) {
      try { return JSON.parse(JSON.stringify(value)) } catch { return value }
    }

    function emptySettingsDraft() {
      return {
        channels: [],
        channelsUpdatedAt: 0,
        global: { autoStart: true, autoRestart: true, updatedAt: 0 },
        projects: {},
      }
    }

    function normalizeSettingsDraft(settings) {
      const base = emptySettingsDraft()
      if (!settings || typeof settings !== 'object') return base
      const project = settings.projects?.[SHARED_PROJECT_ID]
      // v2 起渠道与本地服务开关都按项目独立；旧宿主只给顶层 channels / global 时继续兼容。
      const scopedChannels = project && Array.isArray(project.channels) ? project.channels : settings.channels
      const legacyGlobal = settings.global && typeof settings.global === 'object' ? settings.global : {}
      return {
        channels: Array.isArray(scopedChannels) ? cloneJson(scopedChannels) : [],
        channelsUpdatedAt: Number(settings.channelsUpdatedAt) || 0,
        global: {
          autoStart: typeof project?.autoStart === 'boolean' ? project.autoStart : legacyGlobal.autoStart !== false,
          autoRestart: typeof project?.autoRestart === 'boolean' ? project.autoRestart : legacyGlobal.autoRestart !== false,
          updatedAt: Number(legacyGlobal.updatedAt) || 0,
        },
        projects: settings.projects && typeof settings.projects === 'object' ? cloneJson(settings.projects) : {},
      }
    }

    function projectSettingsOf(draft, id) {
      const project = draft.projects[id]
      return project && typeof project === 'object' ? project : {}
    }

    function cardHead(title, hint) {
      return h('div', { className: 'dsh-aigc-cfg__cardHead' },
        h('span', { className: 'dsh-aigc-cfg__cardTitle' }, title),
        hint ? h('span', { className: 'dsh-aigc-cfg__hint' }, hint) : null,
      )
    }

    function settingsField(label, control) {
      return h('div', { className: 'dsh-aigc-cfg__field' },
        h('span', { className: 'dsh-aigc-cfg__flabel' }, label),
        control,
      )
    }

    function textInput(value, onChange, placeholder, type) {
      return h('input', {
        className: 'dsh-aigc-cfg__inp',
        type: type || 'text',
        value: value ?? '',
        placeholder: placeholder || '',
        autoComplete: 'off',
        spellCheck: false,
        onChange: event => onChange(event.target.value),
      })
    }

    function selectControl(options, value, onChange) {
      const current = value ?? ''
      const list = options.slice()
      if (!list.some(option => option.value === current)) list.unshift({ value: current, label: current || '（未设置）' })
      return h('select', {
        className: 'dsh-aigc-cfg__inp',
        value: current,
        onChange: event => onChange(event.target.value),
      }, list.map(option => h('option', { key: option.value, value: option.value }, option.label)))
    }

    function groupedModelSelect(groups, value, onChange, emptyLabel) {
      const current = value || ''
      const known = groups.some(group => group.options.some(option => option.value === current))
      return h('select', {
        className: 'dsh-aigc-cfg__inp',
        value: current,
        onChange: event => onChange(event.target.value),
      },
        h('option', { value: '' }, emptyLabel || '（未设置）'),
        !known && current ? h('option', { value: current }, `${current}（当前值）`) : null,
        groups.map(group => h('optgroup', { key: group.label, label: group.label },
          group.options.map(option => h('option', { key: option.value, value: option.value }, option.label)),
        )),
      )
    }

    function settingsToggle(label, checked, onChange) {
      return h('label', { className: 'dsh-aigc-cfg__toggle' },
        h('input', { type: 'checkbox', checked: Boolean(checked), onChange: event => onChange(event.target.checked) }),
        h('span', null, label),
      )
    }

    /** 导演台只需要文本模型：编辑时只展示文本能力，其余模型保留原样。 */
    function visibleChannelModels(channel) {
      return (channel.models || [])
        .map((model, index) => ({ model, index }))
        .filter(({ model }) => !TEXT_MODELS_ONLY || (model.capability || 'text') === 'text')
    }

    /** 渠道模型按能力分组；harness 组只用于文本（llm 服务提供的是对话模型）。 */
    function modelGroups(draft, groups, capability) {
      const result = []
      for (const channel of draft.channels) {
        const options = (channel.models || [])
          .filter(model => (capability ? model.capability === capability : true))
          .map(model => ({ value: `${channel.id}::${model.name}`, label: `${model.name}（${channel.name || channel.id}）` }))
        if (options.length) result.push({ label: channel.name || channel.id, options })
      }
      if (capability === 'text') {
        for (const group of groups) {
          if (!group.models?.length) continue
          result.push({
            label: `Harness · ${group.providerName || group.provider}`,
            options: group.models.map(model => ({
              value: `harness::${group.provider}::${model.id}`,
              label: model.name || model.id,
            })),
          })
        }
      }
      return result
    }

    function useSettingsServices(refreshKey) {
      const [services, setServices] = useState({})
      useEffect(() => {
        let alive = true
        const load = () => {
          for (const service of SETTINGS_SERVICES) {
            fetch(service.info, { cache: 'no-store' })
              .then(response => (response.ok ? response.json() : null))
              .then(info => { if (alive) setServices(prev => ({ ...prev, [service.id]: info })) })
              .catch(() => { if (alive) setServices(prev => ({ ...prev, [service.id]: null })) })
          }
        }
        load()
        const timer = setInterval(load, 8000)
        return () => { alive = false; clearInterval(timer) }
      }, [refreshKey])
      return services
    }

    function useHarnessModelGroups() {
      const [state, setState] = useState({ groups: [], error: '' })
      useEffect(() => {
        let alive = true
        fetch(HARNESS_MODELS_API, { cache: 'no-store' })
          .then(response => response.json())
          .then(body => {
            if (!alive) return
            if (body?.ok && Array.isArray(body.groups)) setState({ groups: body.groups, error: '' })
            else setState({ groups: [], error: String(body?.error || '宿主模型目录不可用') })
          })
          .catch(error => { if (alive) setState({ groups: [], error: String(error?.message ?? error) }) })
        return () => { alive = false }
      }, [])
      return state
    }

    function notifySettingsChanged() {
      try { window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT)) } catch { /* 忽略 */ }
      try {
        const channel = new BroadcastChannel(SETTINGS_CHANNEL)
        channel.postMessage({ at: Date.now() })
        channel.close()
      } catch { /* 不支持 BroadcastChannel 时只靠同窗口事件 */ }
    }

    function SharedSettingsSection() {
      const [draft, setDraft] = useState(null)
      const [serviceMeta, setServiceMeta] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [dirty, setDirty] = useState({})
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      const [messageError, setMessageError] = useState(false)
      const [refreshKey, setRefreshKey] = useState(0)
      const dirtyRef = useRef(false)
      const services = useSettingsServices(refreshKey)
      const harness = useHarnessModelGroups()

      useEffect(() => { dirtyRef.current = Object.keys(dirty).length > 0 }, [dirty])

      const load = useCallback(() => {
        fetch(SHARED_SETTINGS_API, { cache: 'no-store' })
          .then(response => response.json())
          .then(body => {
            if (!body?.ok) throw new Error(body?.error || '设置读取失败')
            setDraft(normalizeSettingsDraft(body.settings))
            setServiceMeta(body.service || null)
            setDirty({})
            setLoadError('')
          })
          .catch(error => setLoadError(String(error?.message ?? error)))
      }, [])

      useEffect(() => {
        injectSettingsCss()
        load()
      }, [load])

      // 保存后同窗口面板 / 其它窗口的同一设置页都会重新拉取；有未保存修改时不覆盖草稿。
      useEffect(() => {
        const onChanged = () => { if (!dirtyRef.current) load() }
        window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged)
        let channel
        try {
          channel = new BroadcastChannel(SETTINGS_CHANNEL)
          channel.onmessage = onChanged
        } catch { /* 忽略 */ }
        return () => {
          window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged)
          try { channel?.close() } catch { /* 忽略 */ }
        }
      }, [load])

      const updateChannels = (updater) => {
        setDraft(prev => (prev ? { ...prev, channels: updater(cloneJson(prev.channels)) } : prev))
        setDirty(prev => ({ ...prev, channels: true }))
        setMessage('')
      }
      const updateGlobal = (key, value) => {
        setDraft(prev => (prev ? { ...prev, global: { ...prev.global, [key]: value } } : prev))
        setDirty(prev => ({ ...prev, global: true }))
        setMessage('')
      }
      const updateProject = (key, value) => {
        setDraft(prev => {
          if (!prev) return prev
          const current = projectSettingsOf(prev, SHARED_PROJECT_ID)
          return { ...prev, projects: { ...prev.projects, [SHARED_PROJECT_ID]: { ...current, [key]: value } } }
        })
        setDirty(prev => ({
          ...prev,
          projects: { ...(prev.projects || {}), [SHARED_PROJECT_ID]: true },
        }))
        setMessage('')
      }

      const addChannel = () => updateChannels(channels => [
        ...channels,
        { id: `channel-${Date.now().toString(36)}`, name: '新渠道', baseUrl: '', apiKey: '', apiFormat: 'openai', models: [] },
      ])
      const removeChannel = (index) => updateChannels(channels => channels.filter((_, position) => position !== index))
      const patchChannel = (index, key, value) => updateChannels(channels =>
        channels.map((channel, position) => (position === index ? { ...channel, [key]: value } : channel)))
      const addModel = (index) => updateChannels(channels => channels.map((channel, position) =>
        (position === index ? { ...channel, models: [...(channel.models || []), { name: '', capability: 'text' }] } : channel)))
      const patchModel = (index, modelIndex, key, value) => updateChannels(channels => channels.map((channel, position) => {
        if (position !== index) return channel
        return {
          ...channel,
          models: (channel.models || []).map((model, modelPosition) =>
            (modelPosition === modelIndex ? { ...model, [key]: value } : model)),
        }
      }))
      const removeModel = (index, modelIndex) => updateChannels(channels => channels.map((channel, position) => {
        if (position !== index) return channel
        return { ...channel, models: (channel.models || []).filter((_, modelPosition) => modelPosition !== modelIndex) }
      }))

      const save = () => {
        if (!draft || busy) return
        setBusy(true)
        setMessage('')
        const now = Date.now()
        const body = {}
        const project = projectSettingsOf(draft, SHARED_PROJECT_ID)
        const projectDirty = dirty.channels || dirty.global || dirty.projects?.[SHARED_PROJECT_ID]
        if (projectDirty) {
          body.projects = {
            [SHARED_PROJECT_ID]: {
              ...project,
              ...(dirty.channels ? { channels: draft.channels, channelsUpdatedAt: now } : {}),
              ...(dirty.global ? { autoStart: draft.global.autoStart, autoRestart: draft.global.autoRestart } : {}),
              updatedAt: now,
            },
          }
        }
        fetch(SHARED_SETTINGS_API, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(response => response.json())
          .then(result => {
            if (!result?.ok) throw new Error(result?.error || '保存失败')
            setDraft(normalizeSettingsDraft(result.settings))
            setServiceMeta(result.service || null)
            setDirty({})
            setMessage(`已保存；正在运行的${SETTINGS_LABEL}会自动同步`)
            setMessageError(false)
            notifySettingsChanged()
            setRefreshKey(value => value + 1)
          })
          .catch(error => {
            setMessage(String(error?.message ?? error))
            setMessageError(true)
          })
          .finally(() => setBusy(false))
      }

      const restartService = (service) => {
        setBusy(true)
        setMessage('')
        fetch(service.restart, { method: 'POST' })
          .then(response => response.json())
          .then(info => {
            if (info && info.ready === false) {
              setMessage(String(info.error || `${service.name}仍未就绪`))
              setMessageError(true)
            } else {
              setMessage(`${service.name}已重启`)
              setMessageError(false)
            }
            setRefreshKey(value => value + 1)
          })
          .catch(error => {
            setMessage(String(error?.message ?? error))
            setMessageError(true)
          })
          .finally(() => setBusy(false))
      }

      const openService = (info) => {
        if (info?.port) window.open(`http://${info.host || '127.0.0.1'}:${info.port}/`, '_blank', 'noopener')
      }

      if (loadError) {
        return h('section', { className: 'dsh-aigc-cfg' },
          h('h2', { className: 'dsh-aigc-cfg__title' }, SETTINGS_LABEL),
          h('p', { className: 'dsh-aigc-cfg__warn' }, `设置读取失败：${loadError}`),
          h('div', { className: 'dsh-aigc-cfg__row' },
            h('button', { type: 'button', className: 'dsh-aigc-cfg__btn', onClick: load }, '重试'),
          ),
        )
      }
      if (!draft) {
        return h('section', { className: 'dsh-aigc-cfg' },
          h('h2', { className: 'dsh-aigc-cfg__title' }, SETTINGS_LABEL),
          h('p', { className: 'dsh-aigc-cfg__note' }, '正在读取设置…'),
        )
      }

      const project = projectSettingsOf(draft, SHARED_PROJECT_ID)
      const textGroups = modelGroups(draft, harness.groups, 'text')
      const dirtyCount = Object.keys(dirty).length

      return h('section', { className: 'dsh-aigc-cfg' },
        h('h2', { className: 'dsh-aigc-cfg__title' }, SETTINGS_LABEL),
        h('p', { className: 'dsh-aigc-cfg__lead' },
          TEXT_MODELS_ONLY
            ? '3D 导演台的 AI 渠道与 Agent 使用的文本模型。保存后，正在运行的导演台会自动同步。'
            : '3D 导演台的 AI 渠道、文本模型与生成默认值。保存后，正在运行的导演台会自动同步。'),

        h('div', { className: 'dsh-aigc-cfg__card' },
          cardHead('本地服务', '插件托管的回环服务；面板刷新时也会自动探测'),
          h('div', { className: 'dsh-aigc-cfg__services' },
            SETTINGS_SERVICES.map(service => {
              const state = services[service.id]
              const info = state
              return h('div', { className: 'dsh-aigc-cfg__service', key: service.id },
                h('div', { className: 'dsh-aigc-cfg__serviceHead' },
                  h('span', { className: 'dsh-aigc-cfg__serviceName' }, service.name),
                  h('span', { className: `dsh-aigc-cfg__dot${info?.ready ? ' is-ok' : ''}` }),
                  h('span', { className: 'dsh-aigc-cfg__serviceState' },
                    state === undefined ? '检查中…' : info ? (info.ready ? '运行中' : '未就绪') : '未安装或未启用'),
                ),
                info
                  ? h('div', { className: 'dsh-aigc-cfg__serviceMeta' },
                    `${info.host}:${info.port} · 重启 ${info.restarts ?? 0} 次 · ${info.supervised ? '插件托管' : '外部复用'}`)
                  : null,
                info?.error ? h('div', { className: 'dsh-aigc-cfg__warn' }, String(info.error)) : null,
                h('div', { className: 'dsh-aigc-cfg__row' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-aigc-cfg__btn',
                    disabled: !info || busy,
                    onClick: () => restartService(service),
                  }, '重启服务'),
                  h('button', {
                    type: 'button',
                    className: 'dsh-aigc-cfg__btn',
                    disabled: !info?.ready,
                    onClick: () => openService(info),
                  }, '打开'),
                ),
              )
            }),
          ),
          h('p', { className: 'dsh-aigc-cfg__note' },
            serviceMeta?.settingsPath ? `设置文件：${serviceMeta.settingsPath}` : '设置文件：~/.dsh/haitang-aigc/settings.json'),
        ),

        h('div', { className: 'dsh-aigc-cfg__card' },
          cardHead('本地服务开关', `只影响${SETTINGS_LABEL}自己的服务`),
          h('div', { className: 'dsh-aigc-cfg__grid2' },
            settingsToggle('插件加载时自动启动本地服务', draft.global.autoStart, value => updateGlobal('autoStart', value)),
            settingsToggle('服务掉线后自动重启', draft.global.autoRestart, value => updateGlobal('autoRestart', value)),
          ),
          h('p', { className: 'dsh-aigc-cfg__note' },
            '关闭自动启动后，插件只复用已在运行的服务；仍可在上方「重启服务」手动拉起。关闭自动重启后，服务掉线只提示不补拉。两个项目的开关互不影响。'),
        ),

        h('div', { className: 'dsh-aigc-cfg__card' },
          cardHead('连接 Token', '网页与脚本访问本地服务用的 Connect token'),
          h('div', { className: 'dsh-aigc-cfg__grid2' },
            settingsField('Connect token', textInput(project.bridgeToken || '', value => updateProject('bridgeToken', value.trim()), '留空 = 自动（已默认填充当前 token）', 'password')),
          ),
          h('p', { className: 'dsh-aigc-cfg__note' },
            '服务启动后会把当前 token 默认填充到这里。改成自定义值并「重启服务」后，插件以固定 token 拉起服务；清空再重启则恢复自动 token。网页端始终经 /bootstrap 自动领取，无需手动填写。'),
        ),

        h('div', { className: 'dsh-aigc-cfg__card' },
          cardHead('AI 渠道', TEXT_MODELS_ONLY
            ? '3D 导演台专用，仅需文本模型；密钥只存本机，不写日志'
            : '3D 导演台专用；密钥只存本机，不写日志'),
          draft.channels.length === 0
            ? h('p', { className: 'dsh-aigc-cfg__note' },
              TEXT_MODELS_ONLY ? '还没有渠道。新增后即可在导演台里使用。' : '还没有渠道。新增后即可在画布里使用。')
            : null,
          draft.channels.map((channel, index) => h('div', { className: 'dsh-aigc-cfg__channel', key: channel.id || index },
            h('div', { className: 'dsh-aigc-cfg__channelHead' },
              h('span', { className: 'dsh-aigc-cfg__channelName' }, channel.name || channel.id || `渠道 ${index + 1}`),
              h('span', { className: 'dsh-aigc-cfg__badge' }, channel.apiFormat || 'openai'),
              h('span', { className: 'dsh-aigc-cfg__badge' },
                TEXT_MODELS_ONLY ? `${visibleChannelModels(channel).length} 个文本模型` : `${(channel.models || []).length} 个模型`),
              h('span', { className: 'dsh-aigc-cfg__spacer' }),
              h('button', {
                type: 'button',
                className: 'dsh-aigc-cfg__btn is-danger is-sm',
                onClick: () => removeChannel(index),
              }, '删除渠道'),
            ),
            h('div', { className: 'dsh-aigc-cfg__grid2' },
              settingsField('名称', textInput(channel.name, value => patchChannel(index, 'name', value), '如 火山方舟')),
              settingsField('API 格式', selectControl(API_FORMATS, channel.apiFormat || 'openai', value => patchChannel(index, 'apiFormat', value))),
            ),
            settingsField('Base URL', textInput(channel.baseUrl, value => patchChannel(index, 'baseUrl', value), 'https://…')),
            settingsField('API Key', h('input', {
              className: 'dsh-aigc-cfg__inp',
              type: 'password',
              value: channel.apiKey || '',
              placeholder: '（未填写）',
              autoComplete: 'off',
              spellCheck: false,
              onChange: event => patchChannel(index, 'apiKey', event.target.value),
            })),
            h('div', { className: 'dsh-aigc-cfg__models' },
              h('span', { className: 'dsh-aigc-cfg__modelsHead' }, TEXT_MODELS_ONLY ? '文本模型' : '模型'),
              visibleChannelModels(channel).map(({ model, index: modelIndex }) => h('div', {
                className: 'dsh-aigc-cfg__modelRow',
                key: `${modelIndex}-${model.name}`,
              },
                textInput(model.name, value => patchModel(index, modelIndex, 'name', value), '模型名，如 deepseek-chat'),
                TEXT_MODELS_ONLY
                  ? null
                  : selectControl(CAPABILITIES, model.capability || 'text', value => patchModel(index, modelIndex, 'capability', value)),
                model.script ? h('span', { className: 'dsh-aigc-cfg__badge', title: '该模型带自定义调用脚本，设置页不改写脚本' }, '脚本') : null,
                h('button', {
                  type: 'button',
                  className: 'dsh-aigc-cfg__btn is-ghost is-sm',
                  onClick: () => removeModel(index, modelIndex),
                }, '移除'),
              )),
              h('button', { type: 'button', className: 'dsh-aigc-cfg__btn is-sm', onClick: () => addModel(index) }, '+ 添加模型'),
            ),
          )),
          h('div', { className: 'dsh-aigc-cfg__row' },
            h('button', { type: 'button', className: 'dsh-aigc-cfg__btn', onClick: addChannel }, '+ 新增渠道'),
          ),
        ),

        h('div', { className: 'dsh-aigc-cfg__card' },
          cardHead(`${SETTINGS_LABEL}默认值`, TEXT_MODELS_ONLY
            ? '文本默认模型就是 Agent 使用的模型，可用本页渠道或 Harness 渠道'
            : '文本默认模型与图片/视频/语音模型来自本页渠道；文本与 Agent 默认模型还可以用 Harness 渠道，Agent 未设置时跟随文本默认模型'),
          TEXT_MODELS_ONLY
            ? settingsField('文本默认模型', groupedModelSelect(textGroups, project.textModel || '', value => updateProject('textModel', value)))
            : h('div', { className: 'dsh-aigc-cfg__grid2' },
              settingsField('文本默认模型', groupedModelSelect(textGroups, project.textModel || '', value => updateProject('textModel', value))),
              settingsField('Agent 默认模型', groupedModelSelect(textGroups, project.agentModel || '', value => updateProject('agentModel', value), '（未设置，跟随文本默认模型）')),
            ),
          TEXT_MODELS_ONLY ? null : h('div', { className: 'dsh-aigc-cfg__grid2' },
            settingsField('图片模型', groupedModelSelect(modelGroups(draft, [], 'image'), project.imageModel || '', value => updateProject('imageModel', value))),
            settingsField('视频模型', groupedModelSelect(modelGroups(draft, [], 'video'), project.videoModel || '', value => updateProject('videoModel', value))),
            settingsField('语音模型', groupedModelSelect(modelGroups(draft, [], 'audio'), project.audioModel || '', value => updateProject('audioModel', value))),
            settingsField('图片比例', selectControl(IMAGE_RATIOS, project.imageRatio || 'auto', value => updateProject('imageRatio', value))),
            settingsField('视频比例', selectControl(VIDEO_RATIOS, project.videoRatio || 'auto', value => updateProject('videoRatio', value))),
            settingsField('视频时长（秒）', textInput(project.videoSeconds || '6', value => updateProject('videoSeconds', value), '4–15', 'number')),
            settingsField('画布图片张数', textInput(project.canvasImageCount || '3', value => updateProject('canvasImageCount', value), '1–8', 'number')),
            settingsField('视频分辨率', selectControl([
              { value: '480', label: '480p' },
              { value: '720', label: '720p' },
              { value: '1080', label: '1080p' },
            ], project.vquality || '720', value => updateProject('vquality', value))),
            settingsField('视频生成模式', selectControl([
              { value: 'frames', label: '首尾帧' },
              { value: 'reference', label: '参考图' },
            ], project.videoMode || 'frames', value => updateProject('videoMode', value))),
            settingsField('重绘节点行为', selectControl([
              { value: 'new-node', label: '新建节点' },
              { value: 'overwrite', label: '覆盖原节点' },
            ], project.nodeRegenerateBehavior || 'new-node', value => updateProject('nodeRegenerateBehavior', value))),
          ),
          TEXT_MODELS_ONLY ? null : h('div', { className: 'dsh-aigc-cfg__grid2' },
            settingsToggle('视频生成音频', project.videoGenerateAudio !== 'false', value => updateProject('videoGenerateAudio', value ? 'true' : 'false')),
            settingsToggle('视频水印', project.videoWatermark === 'true', value => updateProject('videoWatermark', value ? 'true' : 'false')),
            settingsToggle('选中节点时自动聚焦', project.autoFocusOnSelect === true, value => updateProject('autoFocusOnSelect', value)),
          ),
          harness.error ? h('p', { className: 'dsh-aigc-cfg__warn' }, `Harness 模型目录不可用：${harness.error}`) : null,
          project.updatedAt
            ? h('p', { className: 'dsh-aigc-cfg__note' }, `上次同步：${new Date(project.updatedAt).toLocaleString()}`)
            : h('p', { className: 'dsh-aigc-cfg__note' }, '本项目还没有保存过设置；首次保存会写入当前值。'),
        ),

        h('div', { className: 'dsh-aigc-cfg__actions' },
          h('button', {
            type: 'button',
            className: 'dsh-aigc-cfg__btn is-primary',
            disabled: busy || dirtyCount === 0,
            onClick: save,
          }, busy ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            className: 'dsh-aigc-cfg__btn',
            disabled: busy || dirtyCount === 0,
            onClick: load,
          }, '放弃修改'),
          h('button', {
            type: 'button',
            className: 'dsh-aigc-cfg__btn is-ghost',
            disabled: busy,
            onClick: () => { load(); setRefreshKey(value => value + 1) },
          }, '重新载入'),
          message ? h('span', { className: `dsh-aigc-cfg__msg${messageError ? ' is-err' : ''}` }, message) : null,
        ),
      )
    }

    function apply(ctx) {
      // 0) 快捷键：主键+Shift+D 打开导演台标签。shortcuts 是可选服务——ctx.get 探测，
      //    绝不进 inject（同 desktopWorkbenches 教训）；没登记成功就不带 commandId，
      //    指向不存在的命令会让侧栏注册抛错。
      let deskCommandReady = false
      ctx.effect(() => {
        const shortcuts = typeof ctx.get === 'function' ? ctx.get('shortcuts') : undefined
        if (!shortcuts || typeof shortcuts.register !== 'function') {
          console.warn('[dsh-3d-director-desk] 快捷键服务不可用，「打开 3D 导演台」未注册')
          return
        }
        try {
          const dispose = shortcuts.register({
            id: DESK_COMMAND_ID,
            // label 必须是函数：宿主 locale 订阅器会调用 label() 做本地化，字符串会炸掉订阅器
            label: () => '打开 3D 导演台',
            aliases: [],
            defaults: Object.fromEntries(SHORTCUT_PROFILES.map(profile => [profile, DESK_BINDING])),
            regions: ['page', 'editable'],
            modals: [],
            resolve: () => ({
              status: 'handled',
              run: () => {
                // 本插件 inject 只声明 sidebarRightTabs/slots；sidebarRight 运行时探测拿。
                const sidebarRight = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
                if (sidebarRight && typeof sidebarRight.openTab === 'function') sidebarRight.openTab(TAB_KIND)
              },
            }),
          })
          deskCommandReady = true
          return dispose
        } catch (error) {
          console.warn('[dsh-3d-director-desk] 快捷键注册失败（已忽略，不影响启动）：', error instanceof Error ? error.message : String(error))
        }
      }, 'director-desk: open-desk shortcut')

      // 1) 标签类型：右侧栏需要一个 kind 才认领这个标签；guide 数组决定「开始」引导页里的入口。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => '导演台',
        guide: [{
          order: 30,
          title: () => '3D 导演台',
          description: () => '摆场、运镜与预演导出，和对话并排使用',
          icon: DirectorGuideIcon,
          ...(deskCommandReady ? { commandId: DESK_COMMAND_ID } : {}),
        }],
      }), 'director-desk: sidebar tab type')

      // 2) 标签正文：按定义 id 注册，宿主在打开该 kind 的标签时渲染它。
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
      }, DirectorDeskTab))

      // 设置页：「3D 导演台」——只注册本项目的分区，画布由另一个插件注册自己的。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SETTINGS_SECTION_ID,
        order: SETTINGS_ORDER,
        label: () => SETTINGS_LABEL,
      }, SharedSettingsSection))

      // 导航图标：注册 id 必须与 settings.section 的 id 相同，宿主才会采用。
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: SETTINGS_SECTION_ID,
      }, ({ size = 16 }) => h(SETTINGS_ICON, { size })))
    }

    return { apply, inject: ['sidebarRightTabs', 'slots'] }
  },
})
