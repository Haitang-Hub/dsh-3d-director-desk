/**
 * dsh-3d-director-desk 服务端入口（Cordis 插件，运行于 Harness 进程）。
 *
 * 职责：
 *   1. 以子进程方式拉起 director-mcp 桥（127.0.0.1，默认 17372），
 *      数据目录指到 dshHomePath('3d-director-desk')，生命周期随本插件 effect 管理；
 *   2. 暴露 /api/director-desk.bridge-info，供客户端面板发现桥端口与就绪状态；
 *   3. 暴露 /api/director-desk.session-ownership，把宿主只读服务
 *      desktopWorkbenchOwnership 的归属快照转给面板（会话绑定数）；
 *   4. 就绪失败保留最内层错误（spawn 错误 / 端口占用 / 健康超时分别可定位）。
 *
 * 工具注册不在本入口：cordis.patch.yml 里的 dsh-mcp-client 条目把桥的
 * /mcp HTTP 门面注册为 mcp__director-desk__* 原生工具（streamable-http）。
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-3d-director-desk'
export const inject = ['connection']

/** 工作台身份（小写 owner/repo），与 Desktop 的归属登记同一口径。 */
const WORKBENCH_ID = 'haitang-hub/dsh-3d-director-desk'

/**
 * 端口单一事实来源：本插件的 Config.port 与 cordis.patch.yml 里 mcp 条目的 url
 * 共用 DIRECTOR_DESK_PORT。改端口只改这一处，避免两处写死后静默错配。
 */
const DEFAULT_PORT = Number(process.env.DIRECTOR_DESK_PORT ?? 17372)

export const Config = Schema.object({
  root: Schema.string().required().description('工作台数据目录（dshHomePath），存放导演台工程与资产'),
  port: Schema.number().default(DEFAULT_PORT).description('桥监听端口，仅本机回环；与 cordis.patch.yml 的 mcp url 共用 DIRECTOR_DESK_PORT'),
  host: Schema.string().default('127.0.0.1').description('桥绑定地址，保持回环；开放到外网前必须先给免 token 端点加鉴权'),
  spawn: Schema.boolean().default(true).description('是否由本插件拉起桥进程；false 时使用外部已启动的桥（开发态 start.bat 场景）'),
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
 * 探测端口上已存在的桥：不仅要 /health 健康，还要它真的能伺服工作台站点。
 * listening 表示端口已被占用（哪怕对面不是我们的桥），调用方据此决定“复用”还是“报错”，
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

/** 归属快照 -> 本工作台的会话数。旧数据可能是字符串 owner，也可能是 `{ id }`，两种都认。 */
function countOwnedSessions(snapshot) {  const bindings = snapshot?.sessionBindings ?? {}
  let count = 0
  for (const owner of Object.values(bindings)) {
    const id = typeof owner === 'string' ? owner : owner?.id ?? owner?.workbenchId
    if (id === WORKBENCH_ID) count += 1
  }
  return count
}

export async function apply(ctx, config) {
  const baseUrl = `http://${config.host}:${config.port}`
  const bridgeInfo = { ready: false, host: config.host, port: config.port }

  // 注册即 effect：面板在任何时刻都能拿到桥状态；停用/HMR 重载时路由随 effect 一起移除，
  // 避免同一进程里残留旧闭包（旧的 bridgeInfo 永远停在 ready=false）。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/director-desk.bridge-info',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Response.json(bridgeInfo, { headers: { 'Cache-Control': 'no-store' } }),
  }))

  // 会话归属：desktopWorkbenchOwnership 由 dsh-desktop-workbenches 以只读服务提供。
  // 不写进 inject —— 该服务缺失时不能让整个工作台激活失败；每次请求用 ctx.get 现查，
  // 服务晚到（工作台服务先加载）也能生效。缺失时返回 503，面板降级为只显示业务面板。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/director-desk.session-ownership',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      const service = ctx.get('desktopWorkbenchOwnership')
      if (!service) {
        return Response.json(
          { ok: false, reason: 'ownership-unavailable' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        )
      }
      try {
        const snapshot = await service.read()
        return Response.json({
          ok: true,
          revision: snapshot?.revision,
          installed: Array.isArray(snapshot?.added) ? snapshot.added.includes(WORKBENCH_ID) : undefined,
          sessions: countOwnedSessions(snapshot),
        }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (error) {
        return Response.json(
          { ok: false, reason: 'ownership-read-failed', detail: String(error?.message ?? error).slice(0, 200) },
          { status: 500, headers: { 'Cache-Control': 'no-store' } },
        )
      }
    },
  }))

  // 复用已有桥前必须确认它“能伺服工作台站点”：只看 /health 会误判。
  // 实测踩过：start.bat 起的旧桥 /health 正常，但站点路径探测失败，iframe 里只得到
  // {"ok":false,"error":"not found"} —— 面板一片空白，用户以为插件坏了。
  const existing = await probeBridge(`${baseUrl}`)
  if (existing.ok) {
    bridgeInfo.ready = true
    ctx.logger.info('director-desk: reusing healthy bridge; url=%s', baseUrl)
    return
  }

  if (!config.spawn) {
    bridgeInfo.error = `外部桥不可用：${existing.reason}`
    ctx.logger.warn('director-desk: external bridge unusable; url=%s reason=%s', baseUrl, existing.reason)
    return
  }

  if (existing.listening) {
    // 端口被占但对方不提供站点：不要再 spawn（只会 EADDRINUSE），给出可操作的原因。
    bridgeInfo.error = `端口 ${config.port} 已被其他进程占用，且该进程无法提供导演台站点（${existing.reason}）。请关闭先前启动的 director-mcp / start.bat 后重启 DSH。`
    ctx.logger.error('director-desk: port %s occupied by an incompatible bridge; reason=%s', config.port, existing.reason)
    return
  }

  const bridgeEntry = fileURLToPath(new URL('../bridge/index.js', import.meta.url))
  const siteDir = fileURLToPath(new URL('../site', import.meta.url))
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
  const pipe = (stream, level) => {
    stream?.on('data', chunk => {
      const text = String(chunk).trim()
      if (text) ctx.logger[level]('director-desk bridge: %s', text.slice(0, 2000))
    })
  }
  pipe(child.stdout, 'info')
  pipe(child.stderr, 'warn')

  ctx.effect(() => {
    // 桥是单进程（无孙进程），kill 即可；dispose 不等待退出，避免阻塞插件停用。
    child.kill()
  })

  try {
    await waitForHealth(`${baseUrl}/health`, config.startupTimeoutMs, undefined)
  } catch (error) {
    const cause = spawnError ? `spawn failed: ${spawnError.message}` : error.message
    child.kill()
    bridgeInfo.ready = false
    bridgeInfo.error = cause
    ctx.logger.error('director-desk: bridge startup failed; port=%s cause=%s', config.port, cause)
    throw new Error(`director-desk bridge failed to start: ${cause}`)
  }

  bridgeInfo.ready = true
  ctx.logger.info('director-desk: bridge ready; url=%s', baseUrl)
}
