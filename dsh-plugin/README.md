# dsh-3d-director-desk（DSH 工作台插件包）

把本仓库的 3D 导演台接入 DeepSeek Harness（DSH Desktop）的工作台插件包。一个包同时是：

- **npm 包**：`dsh plugin add` 可安装的 `.tgz`；
- **DSH 插件（bundle）**：`cordis.patch.yml` 把服务端入口插入 Harness 插件树；
- **Desktop 工作台**：客户端经 `desktopWorkbenches.register()` 注册「3D 导演台」面板；
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
executor = 工作台面板 iframe 里的导演台编辑器（用户实时看到摆场/运镜/出片）
```

- 桥进程生命周期归插件所有：插件停用/卸载/Harness 重启时随之退出；
- 数据落 `$DSH_HOME/3d-director-desk/`（`DIRECTOR_STORE_DIR`），卸载插件不删数据；
- 面板形态是**宿主标准分栏**：左侧是 DSH 原生会话（宿主渲染），右侧业务区是导演台
  iframe；`layout: { businessSide: 'right', businessWidth: 0.6 }`；
- 客户端外壳只用宿主基线 React（18.x）；React 19 + three.js 的应用跑在 iframe 里，
  桥地址经 `/api/director-desk.bridge-info` 动态发现；
- 端口单一事实来源：环境变量 `DIRECTOR_DESK_PORT`（默认 17372），
  `dsh/index.js` 的 `Config.port` 与 patch 里 mcp 条目的 `url` 都读它；
- 复用已有桥前先探测**站点能力**（`GET /` 必须是含 `id="root"` 的 HTML），
  spawn 时显式传 `DIRECTOR_SITE_DIR`，不再赌桥内部按相对路径上溯的猜测。

## 目录

```
dsh-plugin/
├── package.json          # npm 与 dsh.bundle.patch / dsh.client 声明
├── cordis.patch.yml      # 工作台条目 + dsh-mcp-client 条目
├── dsh/index.js          # 服务端入口：拉起桥 + bridge-info / session-ownership + 健康检查
├── lib/client.js         # 客户端单文件（分栏业务面板：工具栏 + 导演台 iframe）
├── scripts/sync-assets.mjs  # 打包前同步 bridge/（director-mcp）与 site/（web/dist）
├── bridge/               # 生成目录（gitignore）：桥运行时
└── site/                 # 生成目录（gitignore）：web/dist 构建产物
```

## 宿主接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/director-desk.bridge-info` | `{ ready, host, port, error? }`，面板据此决定显示 iframe 还是离线引导 |
| `GET /api/director-desk.session-ownership` | 转述宿主只读服务 `desktopWorkbenchOwnership`：`{ ok, revision, installed, sessions }`；宿主未提供该服务时 503 |
| `desktopWorkbenches.register({ layout: { businessSide: 'right', businessWidth: 0.6 } })` | 标准分栏：左侧宿主原生会话，右侧导演台画布；按业务容器宽度自适应 |

会话归属：服务端用 `ctx.get('desktopWorkbenchOwnership')` **现查**（不写进 `inject`，
服务缺失时不能让工作台激活失败）。分栏形态下会话由宿主直接渲染，插件不自建聊天界面。

## 构建与安装

```bash
# 1. 构建前端（仓库根）
cd web && npm install && npm run build

# 2. 同步资产并打包（dsh-plugin/）
cd ../dsh-plugin && npm run pack:all   # = sync + npm pack，产出 dsh-3d-director-desk-0.1.4.tgz

# 3. 安装到 DSH Desktop
dsh plugin --profile web add /绝对路径/dsh-3d-director-desk-0.1.4.tgz
# 4. 完整退出并重新打开 Desktop（安装/替换包必须重启才载入新 JS 模块代）
```

改端口时只设一处：`DIRECTOR_DESK_PORT=18000`（Harness 进程环境），patch 的 url 与
插件 `Config.port` 同步生效。

## 阶段状态（诚实边界）

| 能力 | 状态 |
| --- | --- |
| 包格式（第 3 节必须项） | 已实现：`dsh.bundle.patch` / `dsh.client.platform` / `dsh.client.inject` / `exports["./client"]` / 官方包仅在 peerDependencies |
| 服务端拉起桥 + bridge-info | 已实现；路由纳入 `ctx.effect`；复用前校验站点能力，不可用则报出可操作原因 |
| 面板形态（0.1.8） | 宿主标准分栏：左原生会话 / 右导演台画布（`businessWidth 0.6`） |
| 会话归属 | 只读查询已接（`/api/director-desk.session-ownership`）；分栏下会话由宿主渲染，插件不自建聊天 |
| MCP 工具注册（streamable-http） | 配置已写；`reconnect` 放宽到约 10 分钟，桥晚于 Harness 就绪也能接上 |
| 桥伺服站点 + 面板 iframe | 已实现：显式 `DIRECTOR_SITE_DIR`，静态优先、无扩展名路径回退 index.html |
| iframe 内建 AI 助手 | 仍存在（页面直连模型配置），与原生会话并存；重构阶段 B 会收敛到只保留一条 |
| 已知限制 | 端口/包更新需重启；17372 若被 start.bat 起的桥占用，插件会复用它（数据落在仓库 `data/`） |

## 验收（按官方第 8 节，逐项留证据）

1. `tar -tzf dsh-3d-director-desk-0.1.4.tgz` 核对 `package.json`、`dsh/`、`lib/`、`bridge/`、`site/`、`cordis.patch.yml`；
2. `dsh --profile web --dump-config` 出现本包两层条目（只证明配置，不代表界面已加载）；
3. Desktop 工作台市场「已安装」出现条目且运行中，左侧模式切换器可切到「3D 导演台」；
4. 真实业务面板打开 + 原生会话里调用 `mcp__director-desk__stage_place_character` 全链路跑通。
