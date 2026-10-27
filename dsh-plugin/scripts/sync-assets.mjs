#!/usr/bin/env node
/**
 * 同步插件包运行资产（打包前执行）：
 *   1. director-mcp（index.js + src/ + skills/）→ dsh-plugin/bridge/   —— 桥进程入口
 *   2. web/dist → dsh-plugin/site/                                     —— 前端构建产物
 *
 * bridge/ 与 site/ 是生成目录（.gitignore 排除），权威源在各自上游目录。
 * site/ 的静态伺服由桥在阶段二提供（/app/ 路由）；当前先随包携带。
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pluginRoot, '..')

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
if (hasSite) {
  rmSync(siteTarget, { recursive: true, force: true })
  cpSync(siteSource, siteTarget, { recursive: true, dereference: true })
  console.log('[sync] bridge/ 与 site/ 已更新')
} else {
  console.warn('[sync] web/dist 不存在，跳过 site/（阶段二站点伺服需要；先在 web/ 运行 npm run build）')
  console.log('[sync] bridge/ 已更新')
}
