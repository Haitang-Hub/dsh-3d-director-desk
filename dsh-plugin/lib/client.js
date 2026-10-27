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
  id: 'dsh-3d-director-desk',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    const TAB_ID = 'dsh-3d-director-desk'
    const TAB_KIND = 'director-desk'

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
      if (info === undefined) return '连接中…'
      return info.ready ? '画布已连接' : '画布未就绪'
    }

    /** 轮询本地桥状态；失败时降级，并把原因留给占位文案。 */
    function useBridgeInfo() {
      const [info, setInfo] = useState(undefined)
      useEffect(() => {
        let alive = true
        const load = () => fetch('/api/director-desk.bridge-info')
          .then(response => response.json())
          .then(data => { if (alive) setInfo(data) })
          .catch(() => { if (alive) setInfo({ ready: false, error: 'bridge-info unreachable' }) })
        load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return info
    }

    /** 右侧栏标签正文：工具栏 + 导演台画布。 */
    function DirectorDeskTab() {
      const info = useBridgeInfo()
      const [nonce, setNonce] = useState(0)

      return h('div', { style: SHELL_STYLE },
        h('div', { style: TOOLBAR_STYLE },
          h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '导演台'),
          h('span', { title: info?.error ? String(info.error) : '' }, statusText(info)),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            style: LINK_BUTTON_STYLE,
            onClick: () => setNonce(value => value + 1),
            title: '重新加载画布（不改场景数据）',
          }, '刷新'),
        ),
        info?.ready
          ? h('iframe', {
            key: nonce,
            src: `http://127.0.0.1:${info.port}/`,
            title: '3D 导演台',
            style: IFRAME_STYLE,
            'data-dsh-no-drag': '',
          })
          : h('div', { style: PLACEHOLDER_STYLE },
            h('div', null,
              h('p', { style: { margin: '0 0 6px' } }, '导演台服务未就绪。'),
              h('p', { style: { margin: 0 } },
                info?.error ? String(info.error).slice(0, 200) : '正在等待本地桥启动…'),
              h('p', { style: { margin: '6px 0 0' } },
                '画布就绪后，AI 才能通过 stage_* / camera_* / preview_* 工具改动场景。'),
            ),
          ),
      )
    }

    function apply(ctx) {
      // 1) 标签类型：右侧栏需要一个 kind 才认领这个标签；guide 数组决定「开始」引导页里的入口。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => '导演台',
        guide: [{
          order: 30,
          title: () => '3D 导演台',
          description: () => '摆场、运镜与预演导出，和对话并排使用',
        }],
      }), 'director-desk: sidebar tab type')

      // 2) 标签正文：按定义 id 注册，宿主在打开该 kind 的标签时渲染它。
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
      }, DirectorDeskTab))
    }

    return { apply, inject: ['sidebarRightTabs', 'slots'] }
  },
})
