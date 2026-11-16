// 桥回路自测：模拟 executor 注册、ready、收 tool_call、回传结果。
import { spawn } from "node:child_process";

// 自测会自己 spawn 一个桥实例，默认 17392（独立于常驻桥的 17372，避免端口冲突）；可用 STORE_PORT 覆盖
const SELFTEST_PORT = Number(process.env.STORE_PORT || 17392);
const BASE = `http://127.0.0.1:${SELFTEST_PORT}`;
const server = spawn("node", ["index.js"], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, STORE_PORT: String(SELFTEST_PORT) } });
await new Promise((resolve) => setTimeout(resolve, 1500));

// 桥启用 token 鉴权：先经 /bootstrap 领取 token（回环请求会下发），后续请求全部带上
const bootstrap = await (await fetch(`${BASE}/bootstrap`)).json();
const token = bootstrap.token || "";
console.log("bootstrap:", JSON.stringify({ ...bootstrap, token: token ? `${token.slice(0, 6)}…` : "" }));
const tq = token ? `&token=${encodeURIComponent(token)}` : "";

const esUrl = `${BASE}/events?clientId=fake-exec&role=director&dv=6&desk=deskA${tq}`;
const es = await fetch(esUrl, { headers: { accept: "text/event-stream" } });
console.log("SSE status:", es.status);

const reader = es.body.getReader();
const decoder = new TextDecoder();
let sseBuffer = "";
let helloSeen = false;
let toolCall = null;
const readLoop = (async () => {
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = sseBuffer.indexOf("\n\n")) !== -1) {
            const frame = sseBuffer.slice(0, idx);
            sseBuffer = sseBuffer.slice(idx + 2);
            const type = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (type === "hello") {
                helloSeen = true;
                console.log("hello:", data);
                await fetch(`${BASE}/director/ready?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "fake-exec", deskId: "deskA" }) });
            }
            if (type === "tool_call") {
                toolCall = JSON.parse(data);
                console.log("tool_call:", toolCall.name, JSON.stringify(toolCall.input));
                await fetch(`${BASE}/director/result?clientId=fake-exec&token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: toolCall.requestId, result: { echoed: toolCall.input, desk: "deskA" } }) });
            }
        }
    }
})();

await new Promise((resolve) => setTimeout(resolve, 300));
const status = await (await fetch(`${BASE}/director/status?token=${encodeURIComponent(token)}`)).json();
console.log("status:", JSON.stringify(status));

const call = await (await fetch(`${BASE}/director/tool?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "stage_get_state", input: { probe: 1 }, desk: "deskA" }) })).json();
console.log("tool result:", JSON.stringify(call));
if (!call.ok || call.result?.echoed?.probe !== 1) { console.log("ROUNDTRIP-FAIL"); process.exitCode = 1; }
else if (!helloSeen) { console.log("HELLO-MISSING"); process.exitCode = 1; }
else console.log("ROUNDTRIP-OK");

// 错误路径：desk 不匹配时应当 executor_offline
const wrongDesk = await (await fetch(`${BASE}/director/tool?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "stage_get_state", desk: "deskB" }) })).json();
console.log("wrong desk:", JSON.stringify(wrongDesk));
if (wrongDesk.code !== "executor_offline") { console.log("DESK-ROUTING-FAIL"); process.exitCode = 1; }

// MCP HTTP 门面：tools/list 应返回工具面；tools/call 走进程内直调（免 token，仍须 executor 回路成功）
const mcpList = await (await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).json();
const toolCount = Array.isArray(mcpList?.result?.tools) ? mcpList.result.tools.length : 0;
console.log("mcp tools/list:", toolCount, "tools");
if (toolCount === 0) { console.log("MCP-LIST-FAIL"); process.exitCode = 1; }

const mcpCall = await (await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stage_get_state", arguments: { probe: 2 } } }) })).json();
const mcpCallText = mcpCall?.result?.content?.[0]?.text || "";
let mcpCallParsed = null;
try { mcpCallParsed = JSON.parse(mcpCallText); } catch { /* 非 JSON 即失败 */ }
console.log("mcp tools/call:", JSON.stringify(mcpCallParsed));
if (mcpCall?.result?.isError || mcpCallParsed?.echoed?.probe !== 2 || mcpCallParsed?.desk !== "deskA") { console.log("MCP-CALL-FAIL"); process.exitCode = 1; }

// 跨站 Origin 的 /mcp 请求必须被拒（CORS * 下公网网页可读回环响应，门面免 token 靠这条兜底）
const mcpForbidden = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }) });
console.log("mcp cross-origin status:", mcpForbidden.status);
if (mcpForbidden.status !== 403) { console.log("MCP-ORIGIN-GUARD-FAIL"); process.exitCode = 1; }

reader.cancel().catch(() => {});
server.kill();
process.exit(process.exitCode || 0);
