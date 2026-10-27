/**
 * dsh-3d-director-desk 服务端入口（Cordis 插件，运行于 Harness 进程）。
 *
 * 职责：
 *   1. 托管本地桥（director-mcp，127.0.0.1:17372）：能复用就复用，不能就自己拉起；
 *      **8 秒心跳**复查，桥掉线自动重建 —— 之前只“复用不监管”，外部桥一退出面板就黑屏；
 *   2. 暴露 GET /api/director-desk.bridge-info，面板据此显示画布或恢复引导；
 *   3. 暴露 POST /api/director-desk.restart-bridge，让用户在面板上手动重建服务；
 *   4. 对外部桥做**能力探测**：/health 健康还不够，`GET /` 必须是含 `id="root"` 的 HTML，
 *      否则 iframe 只会拿到 JSON 404（实测踩过）。
 *
 * 工具注册不在本入口：cordis.patch.yml 里的 dsh-mcp-client 条目把桥的 /mcp 门面
 * 注册为 mcp__director-desk__* 原生工具。
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-3d-director-desk'
export const inject = ['connection']

/**
 * 端口单一事实来源：本插件的 Config.port 与 cordis.patch.yml 里 mcp 条目的 url
 * 共用 DIRECTOR_DESK_PORT。改端口只改这一处。
 */
const DEFAULT_PORT = Number(process.env.DIRECTOR_DESK_PORT ?? 17372)

/** 心跳间隔：桥掉线后最多 8 秒面板就能看到状态翻转并自动重建。 */
const HEARTBEAT_MS = 8000

export const Config = Schema.object({
  root: Schema.string().required().description('桥的数据目录（dshHomePath），存放导演台工程与资产'),
  port: Schema.number().default(DEFAULT_PORT).description('桥监听端口，仅本机回环；与 cordis.patch.yml 的 mcp url 共用 DIRECTOR_DESK_PORT'),
  host: Schema.string().default('127.0.0.1').description('桥绑定地址，保持回环；开放到外网前必须先给免 token 端点加鉴权'),
  spawn: Schema.boolean().default(true).description('插件是否托管桥进程；false 时只复用外部已启动的桥'),
  startupTimeoutMs: Schema.number().default(15000).description('等待桥 /health 就绪的超时'),
})

/** 与 dsh-mcp-client 同口径的环境清洗：去掉密钥类与 DSH_* 变量，避免把宿主侧敏感配置带给子进程。 */
function scrubbedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key) || key.startsWith('DSH_')) delete env[key]
  }
  // 宿主可能运行在 Electron utility process 中；此时 execPath 是 Electron，
  // 需要以 Node 模式执行桥脚本（与 dsh-image-generation 的子进程做法一致）。
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

async function waitForHealth(url, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('workbench disposed while waiting for bridge')
    try {
      // 单次尝试必须带超时：对端挂起（如 Windows 控制台 QuickEdit 冻结桥进程）时，
      // 无超时的 fetch 会阻塞整个插件加载。
      const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(2000) })
      if (response.ok) {
        const body = await response.json().catch(() => null)
        if (body?.ok) return body
        lastError = `health payload not ok: ${JSON.stringify(body)?.slice(0, 200)}`
      } else {
        lastError = `health HTTP ${response.status}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(250)
  }
  throw new Error(`bridge not healthy at ${url} within ${timeoutMs}ms: ${lastError}`)
}

/**
 * 探测端口上既有的 HTTP 服务：健康 + 站点能力。
 * `listening=true` 表示端口已被占用（哪怕对面不是我们的桥），调用方据此决定复用还是报错，
 * 而不是盲目 spawn 撞 EADDRINUSE。
 */
async function probeBridge(baseUrl) {
  let health
  try {
    health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
  } catch (error) {
    return { ok: false, listening: false, reason: `不可连接：${error instanceof Error ? error.message : String(error)}` }
  }
  const payload = await health.json().catch(() => null)
  if (!health.ok || !payload?.ok) {
    return { ok: false, listening: true, reason: `health 异常：HTTP ${health.status}` }
  }
  try {
    const site = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) })
    const type = site.headers.get('content-type') || ''
    const html = type.includes('text/html') ? await site.text() : ''
    if (!site.ok || !html.includes('id="root"')) {
      return { ok: false, listening: true, reason: `站点不可用（HTTP ${site.status}，content-type=${type || 'none'}）` }
    }
    return { ok: true, listening: true }
  } catch (error) {
    return { ok: false, listening: true, reason: `站点探测失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function apply(ctx, config) {
  const baseUrl = `http://${config.host}:${config.port}`
  const bridgeEntry = fileURLToPath(new URL('../bridge/index.js', import.meta.url))
  const siteDir = fileURLToPath(new URL('../site', import.meta.url))

  const state = {
    ready: false,
    starting: false,
    child: null,
    error: undefined,
    restarts: 0,
  }

  /** 面板读取的稳定快照：只含可 JSON 化的状态，不含子进程句柄。 */
  const snapshot = () => ({
    ready: state.ready,
    host: config.host,
    port: config.port,
    supervised: config.spawn,
    restarts: state.restarts,
    ...(state.error ? { error: state.error } : {}),
  })

  // 注册即 effect：面板任何时刻都能拿到状态；停用/HMR 时路由随之移除。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/director-desk.bridge-info',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Response.json(snapshot(), { headers: { 'Cache-Control': 'no-store' } }),
  }))

  /** 拉起打包内的桥，并等它健康。返回是否成功（失败原因写进 state.error）。 */
  async function spawnBridge() {
    await mkdir(config.root, { recursive: true })
    ctx.logger.info('director-desk: spawning bridge; port=%s dataDir=%s siteDir=%s', config.port, config.root, siteDir)
    const child = spawn(process.execPath, [bridgeEntry], {
      env: {
        ...scrubbedEnv(),
        DIRECTOR_STORE_DIR: config.root,
        // 显式传站点目录：不依赖桥内部按相对路径上溯的猜测（仓库布局与打包布局层数不同）
        DIRECTOR_SITE_DIR: siteDir,
        STORE_PORT: String(config.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let spawnError = null
    child.on('error', error => { spawnError = error })
    child.on('exit', code => {
      if (state.child !== child) return
      state.child = null
      state.ready = false
      if (code !== 0 && code !== null) state.error = `桥进程退出（code=${code}），稍后自动重启`
    })
    const pipe = (stream, level) => {
      stream?.on('data', chunk => {
        const text = String(chunk).trim()
        if (text) ctx.logger[level]('director-desk bridge: %s', text.slice(0, 2000))
      })
    }
    pipe(child.stdout, 'info')
    pipe(child.stderr, 'warn')
    state.child = child

    try {
      await waitForHealth(`${baseUrl}/health`, config.startupTimeoutMs, undefined)
      state.ready = true
      state.error = undefined
      return true
    } catch (error) {
      const cause = spawnError ? `spawn failed: ${spawnError.message}` : error.message
      try { child.kill() } catch { /* 已经退出 */ }
      if (state.child === child) state.child = null
      state.ready = false
      state.error = `桥启动失败：${cause}`
      ctx.logger.error('director-desk: bridge startup failed; port=%s cause=%s', config.port, cause)
      return false
    }
  }

  /**
   * 保证桥可用。`force` 为真时忽略现有桥（先杀掉自己托管的子进程再重建）。
   * 心跳与手动重启都走这里，避免两处逻辑漂移。
   */
  async function ensureBridge(force) {
    if (state.starting) return
    state.starting = true
    try {
      if (force && state.child) {
        try { state.child.kill() } catch { /* 已经退出 */ }
        state.child = null
        state.ready = false
      }
      if (!force) {
        const probe = await probeBridge(baseUrl)
        if (probe.ok) {
          if (!state.ready) ctx.logger.info('director-desk: reusing healthy bridge; url=%s', baseUrl)
          state.ready = true
          state.error = undefined
          return
        }
        state.ready = false
        if (probe.listening) {
          // 端口被别的进程占着且不能伺服站点：不要 spawn（只会 EADDRINUSE），给出可操作原因。
          state.error = `端口 ${config.port} 被占用，且该进程无法提供导演台站点（${probe.reason}）。关闭它后会自动重试。`
          return
        }
      }
      if (!config.spawn) {
        state.error = '插件配置 spawn=false，只复用外部桥；当前没有可用桥'
        return
      }
      if (await spawnBridge()) state.restarts += 1
    } finally {
      state.starting = false
    }
  }

  // 手动重启：给面板一个“不用重启应用就能恢复画布”的按钮。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/director-desk.restart-bridge',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      await ensureBridge(true)
      return Response.json(snapshot(), { headers: { 'Cache-Control': 'no-store' } })
    },
  }))

  await ensureBridge(false)

  // 心跳：桥退出 / 被外部杀掉 / 端口被占后释放，都会在这里被拉回。
  ctx.effect(() => {
    const timer = setInterval(() => { void ensureBridge(false) }, HEARTBEAT_MS)
    return () => {
      clearInterval(timer)
      if (state.child) {
        try { state.child.kill() } catch { /* 忽略 */ }
        state.child = null
      }
    }
  })
}
