# 3D Director Desk（3D 导演台）

从原 Canvas Director 项目拆分出的独立项目，只保留 3D 导演台核心功能：场景层级
管理、3D 视口（摆人物/道具、XYZ 变换）、镜头运镜（掌机/路线/成片预演）、时间轴
与参考视频导出。纯前端项目，无需任何后端服务即可使用。

## 目录结构

```
3d-director-desk/
├── web/           前端（Vite + React + three.js，端口 5080）
│   └── src/pages/director/
│       ├── index.tsx       导演台首页：新建/打开/删除导演台、快速上手
│       └── editor-page.tsx 全屏编辑器（/director/editor，不带顶部导航）
├── start.bat      Windows 一键启动
└── start.ps1      PowerShell 一键启动
```

## 启动

双击 `start.bat`（或 `powershell -ExecutionPolicy Bypass -File start.ps1`）。
首次运行会自动 `npm install`（使用 `--legacy-peer-deps`，因 antd 6 与
pro-components beta 的 peer 依赖声明冲突），然后启动 dev server。

打开 http://localhost:5080 ，点击「新建导演台」进入编辑器。

## 可选：接入 Canvas Agent

编辑器内置了一个无界面 Agent 桥（`use-director-agent-bridge`）：在 localStorage
配置 `canvas-agent-url` 与 `canvas-agent-token` 后，可由 Agent 以 director 角色
驱动 stage/camera/preview 工具自动摆场景、运镜、导出。未配置时该桥静默跳过，
不影响纯手动编辑。

## 开发

```bash
cd web
npm run dev        # 开发（端口 5080）
npm run typecheck  # 类型检查（存在少量上游遗留类型错误，为原项目子集）
npm run build      # 生产构建 → web/dist
```

## 后续：DeepSeek Harness 插件化

本项目即为此目标而拆分：导演台功能完整收敛在 `web/src/pages/director` +
共享层（`editor/`、`store/directorStore`、`schema/`、`motion/`、`io/`）中，
与已删除的图像/视频/提示词等页面无耦合，便于后续封装为 DeepSeek harness 插件。
