# 3D Director Desk（3D 导演台）

从原 Canvas Director 项目拆分出的独立项目，只保留 3D 导演台核心功能：场景层级
管理、3D 视口（摆人物/道具、XYZ 变换）、镜头运镜（掌机/路线/成片预演）、时间轴
与参考视频导出。纯前端项目，无需任何后端服务即可使用；同时以 `dsh-plugin/`
打包为 DeepSeek Harness（DSH Desktop）的右侧栏插件（发布物在 main 分支）。

## 目录结构

```
3d-director-desk/
├── web/           前端（Vite + React + three.js，端口 5080）
│   └── src/pages/director/
│       ├── index.tsx       导演台首页：新建/打开/删除导演台、快速上手
│       └── editor-page.tsx 全屏编辑器（/director/editor，不带顶部导航）
├── director-mcp/  常驻本地服务（端口 17372）：文件存储 + AI 桥 + stdio MCP 门面
├── dsh-plugin/    DSH Desktop 插件包（dsh/ lib/ 入口与声明；bridge/ site/ 由 sync 生成，不入库）
├── docs/          桥协议等文档（docs/archive/ 为历史方案）
├── start.bat      Windows 一键启动
└── start.ps1      PowerShell 一键启动
```

## 启动

双击 `start.bat`（或 `powershell -ExecutionPolicy Bypass -File start.ps1`）。
首次运行会自动 `npm install`（使用 `--legacy-peer-deps`，因 antd 6 与
pro-components beta 的 peer 依赖声明冲突），然后启动 dev server。

打开 http://localhost:5080 ，点击「新建导演台」进入编辑器。

## 本地文件存储

工程数据默认落盘到项目根目录 `data/`（已 gitignore），不再受浏览器 origin 隔离与清库影响：

- `data/kv/`：导演台列表、场景工程等 localStorage 键值（写透镜像，防抖同步）
- `data/assets/`：导入的模型/动画等二进制资产（磁盘优先，IndexedDB 回退）

存储由 `director-mcp/` 常驻服务承担（零依赖 Node，端口 17372，仅绑本机，由
`start.bat` 自动启动）。服务不在线时自动回退浏览器存储；启动时自动把磁盘上缺失的
键值**拉回** localStorage（跨浏览器/跨端口数据找回）；IndexedDB 中的旧资产在读取时
**懒迁移**上盘。换浏览器或换机器时拷贝 `data/` 目录即可找回全部工程。

## AI 桥与 DeepSeek Harness 接入

`director-mcp` 把 17 个导演台能力（stage_* 摆场、camera_* 运镜、preview_* 出图/出片）
以标准 MCP 工具暴露给 DeepSeek harness。编辑器内置的无界面 Agent 桥
（`use-director-agent-bridge`）自动探测本机桥（`GET 127.0.0.1:17372/bootstrap`），
也可以在 localStorage 显式配置 `director-bridge-url` / `director-bridge-token`
（旧 `canvas-agent-*` 键仍兼容读取）；探测失败时静默跳过，**纯前端手动编辑不受影响**。
导演台首页右上有「AI 桥在线/离线」徽标。

编辑器顶栏还有「AI 助手」内置聊天面板：直连「模型配置」（设置齿轮）里的 text 渠道，
不依赖外部 harness 也能在页面内对话编排；工具执行与 MCP 同源。

harness 侧注册（前提：`start.bat` 已启动）：

```json
{ "mcpServers": {
    "director-desk": {
      "command": "node",
      "args": ["F:/Code_Project/New_AIGC/3d-director-desk/director-mcp/index.js", "mcp"]
    }
}}
```

无法拉起 stdio 进程的 harness 可改用 HTTP 传输：`POST http://127.0.0.1:17372/mcp`
（无状态 JSON-RPC）；编排技能文档在 `GET http://127.0.0.1:17372/skills/director-desk`。

典型工作流：`stage_list_presets` 查预设 → `stage_place_character`/`stage_place_prop`
摆场 → `camera_apply_preset`/`camera_set_keyframe` 设运镜 → `preview_render_frame`
看构图 → `preview_export_animatic` 出片。渲染/导出类工具需要导演台页面在浏览器中
打开（executor 离线时返回 `executor_offline`）；导出耗时可达数分钟，调用方需设置
足够超时。协议细节见 `docs/bridge-protocol.md`。

## 开发

```bash
cd web
npm run dev        # 开发（端口 5080）
npm run typecheck  # 类型检查（存在少量上游遗留类型错误，为原项目子集）
npm run build      # 生产构建 → web/dist
```

## 开发（director-mcp）

```bash
cd director-mcp
npm run doctor   # 自检：桥端口 / executor 在线 / data 可写
npm run mcp      # 单独起 stdio MCP 门面（harness 接入形态）
node bridge-selftest.js  # 桥全回路自测
```

## 后续演进

- 配置与工程文件支持导入导出（设置弹窗与首页卡片）
- 状态类工具的服务端直写（executor 离线时直接改写 `data/kv/` 场景工程）
- 常驻无头浏览器作为渲染 worker（批量出片编排），见 `docs/archive/修改方案.md` 阶段三。
