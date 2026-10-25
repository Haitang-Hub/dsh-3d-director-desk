/**
 * director-mcp 常驻 HTTP 服务（零依赖，端口 17372，仅绑 127.0.0.1）。
 * 一个进程三个角色：
 *   1. 本地文件存储（/kv、/assets，工程数据落盘 data/）
 *   2. 导演台桥（/events SSE、/director/*，工具调用分发给浏览器 executor）
 *   3. MCP 门面的后端（mcp.js 的 stdio 进程经 /director/tool 转发到桥）
 *
 * 端点：
 *   GET    /health              -> { ok, dataDir }
 *   GET    /bootstrap           -> { ok, name, version, protocolVersion }（web 端自动发现桥）
 *   GET    /kv                  -> { keys: [...] }
 *   GET    /kv/:key             -> 文本内容（404 = 无）
 *   PUT    /kv/:key             <- 文本内容
 *   DELETE /kv/:key
 *   POST   /assets/:key         <- 二进制体（X-File-Name 可选、Content-Type 为 mime）
 *   GET    /assets/:key         -> 二进制内容
 *   DELETE /assets/:key
 *   GET    /events              -> SSE（query: clientId, dv, desk；role=director 注册 executor）
 *   POST   /director/ready      <- { clientId, deskId }
 *   POST   /director/result     <- { requestId, result | error }（query: clientId）
 *   GET    /director/status     -> executor 在线概况
 *   POST   /director/tool       <- { name, input, desk? } -> { ok, result } 或结构化错误
 */

import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { DirectorBridge, ToolError } from "./bridge.js";
import { handleMethod as handleMcpMethod } from "./mcp.js";
import { DIRECTOR_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from "../protocol.js";

const PORT = Number(process.env.STORE_PORT || 17372);
const HOST = process.env.STORE_HOST || "127.0.0.1";
const DATA_DIR = resolve(process.env.DIRECTOR_STORE_DIR?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data"));

const encodeKey = (key) => encodeURIComponent(key);

function subDir(name) {
    const dir = join(DATA_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeFileAtomic(file, data) {
    const tmp = `${file}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

function readBody(req) {
    return new Promise((resolvePromise, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolvePromise(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, headers);
    res.end(body);
}

function sendJson(res, status, payload) {
    send(res, status, JSON.stringify(payload), { "content-type": "application/json; charset=utf-8" });
}

/** ToolError -> 结构化响应；其余按 500。 */
function sendToolError(res, error) {
    if (error instanceof ToolError) return sendJson(res, 200, { ok: false, error: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}) });
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
}

const bridge = new DirectorBridge(DATA_DIR);

const server = http.createServer(async (req, res) => {
    // 本机服务，全部放开 CORS，供不同端口的 dev server 页面访问
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, PUT, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, x-file-name");
    if (req.method === "OPTIONS") return sendJson(res, 204, {});

    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
        return sendJson(res, 400, { ok: false, error: "bad url" });
    }
    let pathname = "";
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        return sendJson(res, 400, { ok: false, error: "bad url" });
    }
    const segments = pathname.split("/").filter(Boolean);
    const [group, ...rest] = segments;
    const key = rest.length ? rest.join("/") : "";

    try {
        if (group === "health") return sendJson(res, 200, { ok: true, dataDir: DATA_DIR });

        if (group === "bootstrap") {
            return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, protocolVersion: DIRECTOR_PROTOCOL_VERSION });
        }

        if (group === "events" && req.method === "GET") return bridge.openEvents(url, res);

        // MCP over HTTP（streamable HTTP 的无状态子集）：外部 harness 无法拉起 stdio 进程时用这个门面
        if (group === "mcp") {
            if (req.method !== "POST") {
                res.setHeader("allow", "POST");
                return sendJson(res, 405, { ok: false, error: "POST JSON-RPC 2.0 messages to /mcp" });
            }
            const message = JSON.parse((await readBody(req)).toString("utf8") || "{}");
            if (!message || typeof message !== "object") return sendJson(res, 400, { ok: false, error: "bad json-rpc message" });
            if (message.id === undefined || message.id === null) return send(res, 202, "");
            try {
                const result = await handleMcpMethod(String(message.method || ""), message.params || {});
                return sendJson(res, 200, { jsonrpc: "2.0", id: message.id, result });
            } catch (error) {
                const payload = error && typeof error === "object" ? error : {};
                return sendJson(res, 200, {
                    jsonrpc: "2.0",
                    id: message.id,
                    error: { code: payload.code === "unknown_tool" || payload.code === -32601 ? -32602 : -32000, message: payload.message || String(error), data: { ...(payload.code ? { code: payload.code } : {}), ...(payload.hint ? { hint: payload.hint } : {}) } },
                });
            }
        }

        // skill 文档下发（DeepSeek harness / 人工阅读两用），随包内置：director-mcp/skills/
        if (group === "skills") {
            const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
            if (!key && req.method === "GET") {
                const names = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name) : [];
                return sendJson(res, 200, { ok: true, skills: names });
            }
            if (key && req.method === "GET") {
                const file = join(skillsDir, key, "SKILL.md");
                if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: "skill not found" });
                return send(res, 200, fs.readFileSync(file), { "content-type": "text/markdown; charset=utf-8" });
            }
        }

        if (group === "director") {
            if (key === "ready" && req.method === "POST") {
                const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
                const ok = bridge.markReady(String(body.clientId || ""), String(body.deskId || ""));
                return sendJson(res, ok ? 200 : 404, { ok });
            }
            if (key === "result" && req.method === "POST") {
                const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
                const ok = bridge.resolveResult(String(url.searchParams.get("clientId") || ""), body);
                return sendJson(res, ok ? 200 : 409, { ok });
            }
            if (key === "status" && req.method === "GET") return sendJson(res, 200, { ok: true, ...bridge.status() });
            if (key === "tool" && req.method === "POST") {
                const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
                try {
                    const result = await bridge.callTool(String(body.name || ""), body.input || {}, String(body.desk || ""));
                    return sendJson(res, 200, { ok: true, result });
                } catch (error) {
                    return sendToolError(res, error);
                }
            }
        }

        if (group === "kv" && key) {
            const file = join(subDir("kv"), `${encodeKey(key)}.txt`);
            if (req.method === "GET") {
                if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: "not found" });
                return send(res, 200, fs.readFileSync(file), { "content-type": "text/plain; charset=utf-8" });
            }
            if (req.method === "PUT") {
                writeFileAtomic(file, await readBody(req));
                return sendJson(res, 200, { ok: true });
            }
            if (req.method === "DELETE") {
                if (fs.existsSync(file)) fs.unlinkSync(file);
                return sendJson(res, 200, { ok: true });
            }
        }

        if (group === "kv" && !key && req.method === "GET") {
            const dir = subDir("kv");
            const keys = fs.readdirSync(dir).filter((name) => name.endsWith(".txt")).map((name) => decodeURIComponent(name.slice(0, -4)));
            return sendJson(res, 200, { ok: true, keys });
        }

        if (group === "assets" && !key && req.method === "GET") {
            const dir = subDir("assets");
            const keys = fs.readdirSync(dir).filter((name) => name.endsWith(".meta.json")).map((name) => {
                try {
                    return String(JSON.parse(fs.readFileSync(join(dir, name), "utf8")).key ?? "");
                } catch {
                    return "";
                }
            }).filter(Boolean);
            return sendJson(res, 200, { ok: true, keys });
        }

        if (group === "assets" && key) {
            const dir = subDir("assets");
            const base = encodeKey(key);
            if (req.method === "POST") {
                writeFileAtomic(join(dir, `${base}.bin`), await readBody(req));
                writeFileAtomic(
                    join(dir, `${base}.meta.json`),
                    JSON.stringify({ key, fileName: req.headers["x-file-name"] || "", mimeType: req.headers["content-type"] || "application/octet-stream", updatedAt: Date.now() }),
                );
                return sendJson(res, 200, { ok: true });
            }
            if (req.method === "GET" || req.method === "HEAD") {
                const bin = join(dir, `${base}.bin`);
                if (!fs.existsSync(bin)) return sendJson(res, 404, { ok: false, error: "not found" });
                let mimeType = "application/octet-stream";
                try {
                    mimeType = JSON.parse(fs.readFileSync(join(dir, `${base}.meta.json`), "utf8")).mimeType || mimeType;
                } catch {
                    // meta 丢失时按二进制流返回
                }
                if (req.method === "HEAD") return send(res, 200, null, { "content-type": mimeType, "content-length": String(fs.statSync(bin).size) });
                return send(res, 200, fs.readFileSync(bin), { "content-type": mimeType });
            }
            if (req.method === "DELETE") {
                for (const suffix of [".bin", ".meta.json"]) {
                    const file = join(dir, base + suffix);
                    if (fs.existsSync(file)) fs.unlinkSync(file);
                }
                return sendJson(res, 200, { ok: true });
            }
        }

        return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
        return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});

export function startHttpServer() {
    server.listen(PORT, HOST, () => {
        console.log(`[director-mcp] listening on http://${HOST}:${PORT}, data dir: ${DATA_DIR}`);
        console.log(`[director-mcp] bridge protocol v${DIRECTOR_PROTOCOL_VERSION}; MCP stdio: node index.js mcp; self-check: node index.js doctor`);
    });
    return server;
}
