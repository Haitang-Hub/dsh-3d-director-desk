# 导演台桥协议（Bridge Protocol v7）

3D 导演台（本仓库）与 infinite-canvas（canvas-agent）共享同一套桥协议设计，两边各自
维护一份实现（刻意不共享代码，保证项目独立）。**格式变更时两边同步递增版本号。**

- `protocolVersion`（当前 **7**）：hello 事件携带，executor 不一致时主动断开。
- `dv`（当前 **6**）：executor 桥实现版本，服务端多页面同时在线时优先路由到最新版本。

## 角色

- **executor**：导演台编辑器页面（`web/src/pages/director/editor`），挂载
  `DirectorAgentBridge`，以 `role=director` 接入 SSE，真正执行 stage/camera/preview 工具。
- **桥**：`director-mcp/`（端口 17372，仅绑 127.0.0.1），管理 executor 注册表，
  接收 MCP/HTTP 工具调用并路由、计时、审计。
- **调用方**：MCP stdio 门面（`node director-mcp/index.js mcp`）或直接 HTTP
  `POST /director/tool`。

## Executor 侧端点（web → 桥）

| 端点 | 说明 |
| ---- | ---- |
| `GET /events?clientId=&role=director&dv=&desk=` | SSE 注册。`desk` 为导演台实例 ID（`instanceId` URL 参数），空表示任意。 |
| `POST /director/ready` | body `{ clientId, deskId }`。编辑器完全加载后上报；未就绪页面不参与路由。 |
| `POST /director/result?clientId=` | body `{ requestId, result }` 或 `{ requestId, error }`。 |

SSE 下行事件：

| 事件 | 载荷 | 说明 |
| ---- | ---- | ---- |
| `hello` | `{ ok, protocolVersion, clientId }` | 注册应答；protocolVersion 不匹配时 executor 主动断开。 |
| `ping` | `{ time }` | 每 15s 心跳，维持在线判定。 |
| `tool_call` | `{ requestId, name, input }` | 工具调用下发。 |

连接断开时，桥清理该 executor 并拒绝其所有在途调用（`executor_disconnected`）。

## 调用方端点（MCP 门面 / 外部 → 桥）

| 端点 | 说明 |
| ---- | ---- |
| `GET /bootstrap` | 自动发现：`{ ok, name: "director-desk", version, protocolVersion }`。web 端未显式配置时探测此端点。 |
| `POST /director/tool` | body `{ name, input, desk? }`。同步等待 executor 回传。`desk` 空表示任意可用 executor。 |
| `GET /director/status` | executor 在线概况（doctor / 状态徽标用）。 |
| `POST /mcp` | MCP over HTTP（streamable HTTP 的无状态子集）：initialize / tools/list / tools/call / ping。外部 harness 无法拉起 stdio 进程时用这个门面。 |
| `GET /skills` / `GET /skills/:name` | skill 文档下发（随包内置 `director-mcp/skills/`，当前含 director-desk 编排技能）。 |

### 路由与并发

- 只路由到 **ready** 的 executor；指定 `desk` 时仅匹配该 desk，未指定时选最近活跃的。
- 同 desk 的调用 **FIFO 串行**（避免场景状态竞态），不同 desk 并行。
- **分级超时**：state 类 10s / render 类（截图）120s / export 类（成片）600s，
  超时返回 `{"code":"timeout"}`。

### 结构化错误

所有失败返回 HTTP 200 + `{ ok: false, error, code, hint? }`：

| code | 含义 |
| ---- | ---- |
| `executor_offline` | 没有就绪的导演台页面，hint 提示打开 http://localhost:5080 |
| `timeout` | executor 执行超时（分级超时） |
| `executor_disconnected` | executor 在调用中途断开 |
| `unknown_tool` | 工具名不在 tools.js 注册表 |
| `tool_error` | executor 执行报错（error.message 为原文） |

### 审计

每次工具调用追加一行 JSON 到 `data/logs/tool-audit.jsonl`：
`{ ts, desk, tool, inputSummary, durationMs, status, error? }`。

## 工具表

单一事实来源：`director-mcp/src/schema/tools.js`（17 个工具：stage_* 8、camera_* 7、
preview_* 2，JSON Schema 入参 + 描述）。web 端执行器为
`web/src/pages/director/editor/hooks/use-director-agent-bridge.tsx` 的
`runDirectorTool`（复制对齐，靠 dv/protocolVersion 防错配）。

渲染/导出类工具（`preview_render_frame`、`preview_export_animatic`）依赖浏览器
three.js 实时渲染，必须由 executor 执行；executor 离线时返回 `executor_offline`。

## MCP 接入（DeepSeek harness）

```json
{ "mcpServers": {
    "director-desk": {
      "command": "node",
      "args": ["F:/Code_Project/New_AIGC/3d-director-desk/director-mcp/index.js", "mcp"]
    }
}}
```

MCP 门面有两种传输：stdio（`node director-mcp/index.js mcp`，DeepSeek harness 可拉起
进程时用）与 HTTP（`POST 127.0.0.1:17372/mcp`，浏览器内嵌 harness 用），实现相同的
`initialize` / `tools/list` / `tools/call` / `ping`，工具调用都转发到常驻桥
`/director/tool`。环境变量：`DIRECTOR_BRIDGE_URL`、`DIRECTOR_DESK`（固定路由 desk）。
注意 `preview_export_animatic` 可达数分钟，调用方需设置足够超时。

编排方法论以 skill 形式提供：`GET http://127.0.0.1:17372/skills/director-desk`
（同一份内容也是编辑器内置 Agent 的 system prompt 蓝本）。

## 编辑器内置 Agent（web 内直连模型）

除 MCP 外，编辑器顶栏「AI 助手」提供页面内聊天面板
（`web/src/pages/director/editor/agent/`）：直连「模型配置」中 text 渠道
（OpenAI 兼容 chat/completions，function calling 循环），工具执行复用与 SSE 桥
相同的 `runDirectorTool`，因此内置 Agent、外部 harness、MCP 三条链路行为一致。
工具表的 web 侧副本在 `editor/agent/agentTools.ts`（与 director-mcp schema 对齐）。

## 自检

```bash
cd director-mcp
node index.js doctor   # 桥端口 / executor 在线数 / data 目录可写 / 协议版本
node bridge-selftest.js  # 模拟 executor 全回路（注册→ready→tool_call→回传）
```
