/**
 * 最小 MCP stdio 门面（JSON-RPC 2.0 手写，约 200 行，保持零依赖）。
 * 只实现 initialize / tools/list / tools/call / ping 四个方法 —— 工具面固定、协议子集小；
 * 若 harness 要求 progress notification 等完整能力，再切换到 @modelcontextprotocol/sdk。
 *
 * 工具执行不在本进程：POST 到常驻桥（17372 /director/tool），由桥路由给浏览器 executor。
 * stdin/stdout 只跑 JSON-RPC，日志一律走 stderr。
 */

import { mcpToolList } from "../schema/tools.js";
import { SERVER_NAME, SERVER_VERSION } from "../protocol.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const BRIDGE_URL = (process.env.DIRECTOR_BRIDGE_URL || "http://127.0.0.1:17372").replace(/\/$/, "");
const DESK = process.env.DIRECTOR_DESK || "";

/** 启动 stdio MCP 服务。 */
export async function startMcpServer() {
    let buffer = "";
    let stdinEnded = false;
    let inFlight = 0;
    const maybeExit = () => {
        if (stdinEnded && inFlight === 0) process.exit(0);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newlineAt = buffer.indexOf("\n");
        while (newlineAt !== -1) {
            const line = buffer.slice(0, newlineAt).trim();
            buffer = buffer.slice(newlineAt + 1);
            if (line) {
                inFlight += 1;
                handleMessage(line).finally(() => {
                    inFlight -= 1;
                    maybeExit();
                });
            }
            newlineAt = buffer.indexOf("\n");
        }
    });
    process.stdin.on("end", () => {
        stdinEnded = true;
        maybeExit();
    });
    process.on("SIGINT", () => process.exit(0));
    log(`director-desk MCP listening on stdio, bridge: ${BRIDGE_URL}`);
}

/** 处理单行消息；通知（无 id）不回包。 */
async function handleMessage(line) {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return log(`ignored non-JSON line: ${line.slice(0, 120)}`);
    }
    if (!message || typeof message !== "object") return;
    if (message.id === undefined || message.id === null) return log(`notification: ${String(message.method || "")}`);
    await respondTo(message).catch((error) => {
        writeMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    });
}

async function respondTo(message) {
    const { id, method, params = {} } = message;
    try {
        const result = await handleMethod(method, params);
        writeMessage({ jsonrpc: "2.0", id, result });
    } catch (error) {
        const payload = error && typeof error === "object" ? error : {};
        writeMessage({
            jsonrpc: "2.0",
            id,
            error: { code: payload.code === "unknown_tool" ? -32602 : -32000, message: payload.message || String(error), data: { ...(payload.code ? { code: payload.code } : {}), ...(payload.hint ? { hint: payload.hint } : {}) } },
        });
    }
}

async function handleMethod(method, params) {
    switch (method) {
        case "initialize":
            return {
                protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1],
                capabilities: { tools: {} },
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                instructions: MCP_INSTRUCTIONS,
            };
        case "ping":
            return {};
        case "tools/list":
            return { tools: mcpToolList() };
        case "tools/call": {
            const name = String(params.name || "");
            const input = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
            const result = await callBridge(name, input);
            // callBridge 的错误结果已是 MCP 形态（content + isError），直接透传
            if (result && typeof result === "object" && Array.isArray(result.content)) return result;
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        default:
            throw Object.assign(new Error(`未知方法：${method}`), { code: -32601 });
    }
}

/** 把工具调用转发到常驻桥；bridge 侧结构化错误转为 MCP isError 结果。 */
async function callBridge(name, input) {
    let res;
    try {
        res = await fetch(`${BRIDGE_URL}/director/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, input, desk: DESK }),
        });
    } catch {
        return errorResult({
            error: "bridge_offline",
            hint: `director-mcp 常驻服务未运行（${BRIDGE_URL}）。先运行 start.bat 或在 director-mcp 目录执行 node index.js`,
        });
    }
    const body = await res.json().catch(() => ({}));
    if (!body.ok) return errorResult({ error: body.error || "tool call failed", ...(body.code ? { code: body.code } : {}), ...(body.hint ? { hint: body.hint } : {}) });
    return body.result ?? { ok: true };
}

function errorResult(payload) {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

function writeMessage(message) {
    process.stdout.write(JSON.stringify(message) + "\n");
}

function log(text) {
    process.stderr.write(`[director-mcp] ${text}\n`);
}

const MCP_INSTRUCTIONS = [
    "director-desk：3D 导演台的 MCP 服务。通过 stage_* 摆场景、camera_* 设运镜、preview_* 出图/出片。",
    "推荐工作流：stage_list_presets 查可用预设 → stage_place_character/stage_place_prop 摆场 → camera_set_pose + camera_set_keyframe 或 camera_apply_preset 设运镜 → preview_render_frame 看构图 → preview_export_animatic 出片。",
    "渲染/导出类工具（preview_*）需要导演台页面在浏览器中打开（http://localhost:5080）；离线时会返回 executor_offline。",
    "破坏性工具（stage_clear_scene、stage_remove_object、camera_delete_keyframe）调用前先 stage_get_state 确认现状。",
].join("\n");
