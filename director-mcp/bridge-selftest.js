// 桥回路自测：模拟 executor 注册、ready、收 tool_call、回传结果。
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:17372";
const server = spawn("node", ["index.js"], { cwd: process.cwd(), stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 1500));

const esUrl = `${BASE}/events?clientId=fake-exec&role=director&dv=6&desk=deskA`;
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
                await fetch(`${BASE}/director/ready`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "fake-exec", deskId: "deskA" }) });
            }
            if (type === "tool_call") {
                toolCall = JSON.parse(data);
                console.log("tool_call:", toolCall.name, JSON.stringify(toolCall.input));
                await fetch(`${BASE}/director/result?clientId=fake-exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: toolCall.requestId, result: { echoed: toolCall.input, desk: "deskA" } }) });
            }
        }
    }
})();

await new Promise((resolve) => setTimeout(resolve, 300));
const status = await (await fetch(`${BASE}/director/status`)).json();
console.log("status:", JSON.stringify(status));

const call = await (await fetch(`${BASE}/director/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "stage_get_state", input: { probe: 1 }, desk: "deskA" }) })).json();
console.log("tool result:", JSON.stringify(call));
if (!call.ok || call.result?.echoed?.probe !== 1) { console.log("ROUNDTRIP-FAIL"); process.exitCode = 1; }
else if (!helloSeen) { console.log("HELLO-MISSING"); process.exitCode = 1; }
else console.log("ROUNDTRIP-OK");

// 错误路径：desk 不匹配时应当 executor_offline
const wrongDesk = await (await fetch(`${BASE}/director/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "stage_get_state", desk: "deskB" }) })).json();
console.log("wrong desk:", JSON.stringify(wrongDesk));
if (wrongDesk.code !== "executor_offline") { console.log("DESK-ROUTING-FAIL"); process.exitCode = 1; }

reader.cancel().catch(() => {});
server.kill();
process.exit(process.exitCode || 0);
