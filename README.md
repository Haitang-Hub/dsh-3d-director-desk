# dsh-3d-director-desk（DSH Desktop 插件包）

把 3D 导演台接入 DeepSeek Harness（DSH Desktop）的插件包。本仓库就是插件包本身：
`npm pack` 直接出可安装的 `.tgz`。main 分支 `bridge/` 与 `site/` 产物已入库，克隆即打包；
full 分支（全量源码）上这两目录由 `npm run sync` 生成（gitignore 排除），先 build 再打包。

一个包同时是：

- **npm 包**：`dsh plugin add` 可安装的 `.tgz`；
- **DSH 插件（bundle）**：`cordis.patch.yml` 把服务端入口插入 Harness 插件树；
- **Desktop 右侧栏标签**：客户端经 `sidebarRightTabs.register()` 在右侧栏注册「3D 导演台」标签页；
- **MCP 工具来源**：patch 里的 `dsh-mcp-client` 条目把桥的 `/mcp` 门面注册为
  `mcp__director-desk__stage_* / camera_* / preview_*` 原生工具。

## 架构

```
DSH 会话（模型调用 mcp__director-desk__*）
  ▼
dsh-mcp-client（harness 进程，streamable-http → 127.0.0.1:17372/mcp，持续重连）
  ▼
director-mcp 桥（由 dsh/index.js spawn 并监管；数据目录 = dshHomePath('3d-director-desk')）
  │ SSE tool_call
  ▼
executor = 右侧栏「导演台」标签 iframe 里的导演台编辑器（用户实时看到摆场/运镜/出片）
```

- 桥进程生命周期归插件所有：插件停用/卸载/Harness 重启时随之退出；
- 数据落 `$DSH_HOME/3d-director-desk/`（`DIRECTOR_STORE_DIR`），卸载插件不删数据；
- 面板形态是 **DSH 右侧栏标签**，不是工作台分栏：会话保持整页宽度（宿主自己的布局
  不动），导演台画布停靠在右侧栏的一个标签页里，可拖动、可拆分、可全屏；从右侧栏
  「开始」引导页点「3D 导演台」打开，之后作为普通标签保留；标签顶部有
  「新窗口 / 重启服务 / 刷新」快捷操作（重启服务重建本地桥，无需重启应用）；
- 客户端外壳只用宿主基线 React（18.x）；React 19 + three.js 的应用跑在 iframe 里，
  桥地址经 `/api/director-desk.bridge-info` 动态发现；
- 端口单一事实来源：环境变量 `DIRECTOR_DESK_PORT`（默认 17372），
  `dsh/index.js` 的 `Config.port` 与 patch 里 mcp 条目的 `url` 都读它；
- 复用已有桥前先探测**站点能力**（`GET /` 必须是含 `id="root"` 的 HTML），
  spawn 时显式传 `DIRECTOR_SITE_DIR`，不再赌桥内部按相对路径上溯的猜测。

## 目录

```
（仓库根 = 插件包根）
├── package.json          # npm 与 dsh.bundle.patch / dsh.client 声明
├── cordis.patch.yml      # 工作台条目 + dsh-mcp-client 条目
├── dsh/index.js          # 服务端入口：拉起桥 + bridge-info / restart-bridge + 8s 心跳守护
├── lib/client.js         # 客户端单文件（右侧栏「导演台」标签：引导入口 + 快捷操作 + iframe）
├── bridge/               # 桥运行时（director-mcp 快照，已入库）
├── site/                 # 导演台前端构建产物（web/dist 快照，含本地 3D 资产库，已入库）
└── docs/                 # 桥协议文档
```

## 安装与更新

```bash
# 从 .tgz 安装（npm pack 或 GitHub Release 产物）
dsh plugin --profile web add /绝对路径/dsh-3d-director-desk-<版本>.tgz

# 从本仓库直接打包
git clone https://github.com/Haitang-Hub/dsh-3d-director-desk.git
cd dsh-3d-director-desk && npm pack    # 产出 .tgz，再按上行安装
```

**更新**：发布新版本只需改 `package.json` 的 `version` 并重新打包安装；
接入市场的分发（按包名 `dsh plugin add dsh-3d-director-desk`）依赖 npm registry
上的同名版本，`npm publish` 即可被市场索引与自动更新。安装/替换包后需完整退出
并重新打开 Desktop（新 JS 模块代要重启才载入）。

改端口时只设一处：`DIRECTOR_DESK_PORT=18000`（Harness 进程环境），patch 的 url 与
插件 `Config.port` 同步生效。

## 宿主接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/director-desk.bridge-info` | `{ ready, host, port, supervised, restarts, error? }`，标签页据此决定显示 iframe 还是离线引导 |
| `POST /api/director-desk.restart-bridge` | 强制杀掉插件托管的桥子进程并重建，面板「重启服务」按钮用 |
| `sidebarRightTabs.register({ id, kind, title, guide })` | 声明「导演台」标签类型，并在右侧栏「开始」引导页放入口 |
| `slots.register({ name: 'sidebar.right.pane.tab', key })` | 标签正文：快捷操作行 + 导演台 iframe |

右侧栏形态下会话由宿主直接渲染，插件不自建聊天界面。

## 发布（CI/CD）

发布由 GitHub Actions 全自动完成，本地只需三步：

1. 改 `dsh-plugin/package.json` 的 `version`；
2. 在 `CHANGELOG.md` 补一节变更记录；
3. 提交并推送 `full` 分支。

推送后两条流水线并行工作（`.github/workflows/`）：

- **CI**：每次 push / PR 到 `full` 都会跑 `web` 的 typecheck + build 和 `dsh-plugin sync`，不发布；
- **Release**：读取 `dsh-plugin/package.json` 的版本号，若远端不存在 `v<版本>` tag 则自动构建、把
  `dsh/ lib/ bridge/ site/ cordis.patch.yml package.json` 同步到 main 分支根目录、打 tag 并创建
  GitHub Release（附 `.tgz`，见 Releases 页）。版本号没变时只跑 CI，不会重复发版。

发布产物下载：

```bash
# GitHub Releases 页下载 dsh-3d-director-desk-<版本>.tgz 后：
dsh plugin --profile web add /绝对路径/dsh-3d-director-desk-<版本>.tgz
```

## 全量版本（可找回）

历史上本项目是独立全量工程：`web/`（Vite + React + three.js 源码，端口 5080）、
`director-mcp/`（常驻桥服务源码）、`start.bat/ps1` 一键启动等。这些**已归档**，
随时找回并继续开发：

```bash
git switch full          # full 分支（= full-v1.0 tag），全量布局
# 开发迭代后重新出包：
#   cd web && npm install && npm run build
#   cd ../dsh-plugin && npm run sync && npm pack   # sync 从 director-mcp/ 与 web/dist 同步生成 bridge/ 与 site/
```

全量版本的演进历史见 `CHANGELOG.md`。main 分支只保留插件包本体；
若全量侧有新迭代，把重新生成的 `bridge/`、`site/` 拷回 main 提交即可发布新版插件。

## 阶段状态（诚实边界）

| 能力 | 状态 |
| --- | --- |
| 包格式（第 3 节必须项） | 已实现：`dsh.bundle.patch` / `dsh.client.platform` / `dsh.client.inject` / `exports["./client"]` / 官方包仅在 peerDependencies |
| 服务端拉起桥 + bridge-info | 已实现；路由纳入 `ctx.effect`；复用前校验站点能力，不可用则报出可操作原因 |
| 面板形态 | DSH 右侧栏标签：与会话并排的「导演台」标签页（`dsh.client.inject` = `@deepseek-ai/dsh-client-ui-sidebar-right`） |
| 会话归属 | 右侧栏下会话由宿主渲染，插件不自建聊天（session-ownership 接口未实现，README 早期版本误标为已接） |
| 桥鉴权 | 已实现：/bootstrap 仅向回环 Origin 下发随机 token，数据端点要求 `x-director-token` 或 `?token=`；/health、/mcp 与静态站点豁免 |
| MCP 工具注册（streamable-http） | 配置已写；`reconnect` 放宽到近似无限（5s 退避 ×86400），桥晚于 Harness 就绪也能接上 |
| 桥伺服站点 + 标签 iframe | 已实现：显式 `DIRECTOR_SITE_DIR`，静态优先、无扩展名路径回退 index.html |
| iframe 内建 AI 助手 | 仍存在（页面直连模型配置），与原生会话并存；后续收敛到只保留一条 |
| 已知限制 | 端口/包更新需重启；17372 若被全量版 start.bat 起的桥占用，插件会复用它（数据落在仓库 `data/`） |

## 验收（按官方第 8 节，逐项留证据）

1. `npm pack` 后 `tar -tzf dsh-3d-director-desk-<版本>.tgz` 核对 `package.json`、`dsh/`、`lib/`、`bridge/`、`site/`、`cordis.patch.yml`；
2. `dsh --profile web --dump-config` 出现本包两层条目（只证明配置，不代表界面已加载）；
3. Desktop 插件市场「已安装」出现条目且运行中，右侧栏「开始」引导页出现「3D 导演台」入口，点开即见导演台标签；
4. 真实业务面板打开 + 原生会话里调用 `mcp__director-desk__stage_place_character` 全链路跑通。
