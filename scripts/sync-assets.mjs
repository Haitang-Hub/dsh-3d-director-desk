#!/usr/bin/env node
/**
 * 同步插件包运行资产（打包前执行）：
 *   1. director-mcp（index.js + src/ + skills/）→ dsh-plugin/bridge/   —— 桥进程入口
 *   2. web/dist → dsh-plugin/site/                                     —— 前端构建产物
 *
 * bridge/ 与 site/ 是生成目录（.gitignore 排除），权威源在各自上游目录。
 * 缺 web/dist 一律硬失败：打出没有 site/ 的 tgz 装上面板 iframe 直接 404，
 * 比打包失败难排查得多。确要只同步桥时传 --skip-site（与 dsh-infinite-canvas 同口径）。
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pluginRoot, '..')
const skipSite = process.argv.includes('--skip-site')

const bridgeSource = join(repoRoot, 'director-mcp')
const bridgeTarget = join(pluginRoot, 'bridge')
const siteSource = join(repoRoot, 'web', 'dist')
const siteTarget = join(pluginRoot, 'site')

function mustExist(path, hint) {
  if (!existsSync(path)) {
    console.error(`[sync] 缺少 ${path} —— ${hint}`)
    process.exit(1)
  }
}

function replaceDir(source, target, hint) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const item of ['index.js', 'src', 'skills']) {
    const from = join(source, item)
    if (!existsSync(from)) continue
    cpSync(from, join(target, item), { recursive: true, dereference: true })
  }
}

mustExist(join(bridgeSource, 'index.js'), '先在 director-mcp/ 保留 index.js（零依赖，无需构建）')
replaceDir(bridgeSource, bridgeTarget)

const hasSite = existsSync(siteSource) && statSync(siteSource).isDirectory()
if (skipSite) {
  console.log('[sync] --skip-site：bridge/ 已更新，site/ 保持原样')
} else if (hasSite) {
  rmSync(siteTarget, { recursive: true, force: true })
  cpSync(siteSource, siteTarget, { recursive: true, dereference: true })
  console.log('[sync] bridge/ 与 site/ 已更新')
} else {
  console.error('[sync] web/dist 不存在 —— 先在 web/ 运行 npm run build。打出没有 site/ 的包会让面板 iframe 直接 404，已硬失败；确要跳过请传 --skip-site。')
  process.exit(1)
}
