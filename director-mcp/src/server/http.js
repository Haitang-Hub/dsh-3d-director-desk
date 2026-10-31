/**
 * director-mcp 常驻 HTTP 服务（零依赖；开发态默认 17383、插件托管显式传 STORE_PORT=17372，仅绑 127.0.0.1）。
 * 一个进程三个角色：
 *   1. 本地文件存储（/kv、/assets，工程数据落盘 data/）
 *   2. 导演台桥（/events SSE、/director/*，工具调用分发给浏览器 executor）
 *   3. MCP 门面的后端（mcp.js 的 stdio 进程经 /director/tool 转发到桥）
 *
 * 端点：
 *   GET    /health              -> { ok, plugin, site, version, dataDir, protocolVersion }（插件壳 probeBridge 探测）
 *   GET    /bootstrap           -> { ok, name, version, protocolVersion, url, token? }（web 端自动发现桥）
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
 *
 * 鉴权：除 /health、/bootstrap、/mcp、OPTIONS 预检与站点静态资源外，其余端点均需
 * token（header x-director-token 或 query ?token=，SSE/<img> 等无法带自定义头的走 query）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";

import { DirectorBridge, ToolError } from "./bridge.js";
import { handleMethod as handleMcpMethod } from "./mcp.js";
import { DIRECTOR_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from "../protocol.js";

const PORT = Number(process.env.STORE_PORT || 17383);
const HOST = process.env.STORE_HOST || "127.0.0.1";
const DATA_DIR = resolve(process.env.DIRECTOR_STORE_DIR?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data"));

// 站点伺服（阶段二）：让桥直接承载导演台 Web 构建产物，Desktop 工作台面板的 iframe
// 与 AI 工具共用同一 origin（SSE executor 自动同源接入）。优先级：DIRECTOR_SITE_DIR >
// 打包布局（dsh-plugin/bridge 同级的 site/）> 仓库布局（web/dist）。
const SITE_CANDIDATES = [
    process.env.DIRECTOR_SITE_DIR?.trim(),
    // 打包布局：<pkg>/bridge/src/server → 上溯 3 级 = <pkg>/site
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "site"),
    // 仓库布局：<repo>/director-mcp/src/server → 上溯 3 级 = <repo>/web/dist
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web", "dist"),
    // 兜底：旧的多一层布局
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "web", "dist"),
].filter(Boolean).map((dir) => resolve(dir));
const SITE_DIR = SITE_CANDIDATES.find((dir) => fs.existsSync(join(dir, "index.html"))) || "";

// token 鉴权：启动时生成随机 token（DIRECTOR_BRIDGE_TOKEN 可固定，便于脚本/自测复用）。
// 站点静态资源与探测端点公开，其余端点凭 header x-director-token 或 query ?token= 访问；
// web 端经 /bootstrap 零配置领取（token 仅下发给本机回环来源，公网探测拿不到）。
const TOKEN = process.env.DIRECTOR_BRIDGE_TOKEN?.trim() || crypto.randomBytes(18).toString("hex");
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
// vite 构建产物文件名含内容 hash，可永久缓存的扩展名集合
const HASHED_ASSET_EXTS = new Set([".js", ".mjs", ".css", ".woff", ".woff2", ".ttf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".mp4", ".webm"]);

/** 校验请求的连接 token：header x-director-token 或 query ?token=。 */
function validToken(req, url) {
    const header = req.headers["x-director-token"];
    return url.searchParams.get("token") === TOKEN || header === TOKEN;
}

/** 解析站点请求对应的真实文件；未命中返回 ""（含越界防护，spaFallback=false 只命中真实文件）。 */
async function resolveSiteFile(pathname, spaFallback = true) {
    const relative = pathname.replace(/^\/+/, "") || "index.html";
    const file = resolve(SITE_DIR, relative);
    if (!file.startsWith(SITE_DIR + sep)) return ""; // 拒绝越界路径
    try {
        const stat = await fsp.stat(file);
        if (!stat.isDirectory()) return file;
    } catch {
        // 文件不存在，走 SPA 回退
    }
    if (!spaFallback) return "";
    // SPA 回退：无扩展名的路径交给 index.html（react-router 前端路由）
    const last = relative.split("/").pop() || "";
    if (last.includes(".")) return "";
    const index = join(SITE_DIR, "index.html");
    try {
        await fsp.access(index);
        return index;
    } catch {
        return "";
    }
}

/**
 * 缓存策略：/assets/ 下的 vite 哈希产物按内容 hash 永久缓存；local-assets/ 小时级；
 * index.html 与 SPA 回退 no-store，保证发版即生效。passthrough=true（/assets 存储键
 * 穿透分支）不加 immutable：存储键可能随时被覆盖/删除，长缓存会骗过应用的资源刷新判断。
 */
function cacheControlFor(pathname, passthrough = false) {
    if (pathname.startsWith("/assets/") && HASHED_ASSET_EXTS.has(extname(pathname).toLowerCase())) {
        return passthrough ? "public, max-age=3600" : "public, max-age=31536000, immutable";
    }
    if (pathname.startsWith("/local-assets/")) return "public, max-age=3600";
    return "no-store";
}

/**
 * token 豁免判定：探测端点（/health、/bootstrap、/mcp）、OPTIONS 与站点静态请求。
 * 站点公开、API 鉴权（与插件壳 probeBridge / iframe 资源加载同口径）。SPA 回退只豁免
 * 非 API 前缀且浏览器导航（Accept: text/html）的路径，/kv、/events 等接口仍需 token。
 */
async function tokenExempt(req, pathname) {
    const segments = pathname.split("/").filter(Boolean);
    const first = segments[0] || "";
    if (["health", "bootstrap", "mcp"].includes(first)) return true;
    if (!SITE_DIR || (req.method !== "GET" && req.method !== "HEAD")) return false;
    // 站点真实文件公开（vite 产物、local-assets 模型、图标/配置等静态资源）
    if (await resolveSiteFile(pathname, false)) return true;
    // API 前缀（/events、/director/*、/kv、/assets、/skills）不做 SPA 回退豁免
    if (["events", "director", "kv", "assets", "skills"].includes(first)) return false;
    const last = segments[segments.length - 1] || "";
    return !last.includes(".") && String(req.headers.accept || "").includes("text/html") && Boolean(await resolveSiteFile(pathname, true));
}

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
    ".mp4": "video/mp4", ".webm": "video/webm", ".fbx": "application/octet-stream",
    ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".md": "text/markdown; charset=utf-8",
};

/**
 * 按站点静态规则响应（异步读取 + 流式发送，避免阻塞事件循环）；返回 true 表示已处理，
 * false 表示未处理、调用方继续走后续路由。spaFallback=false 时只命中真实存在的文件
 * （存储 /assets 穿透用，避免把“键不存在”伪装成 200 的 index.html 骗过应用的资源加载判断）；
 * passthrough=true 时缓存头降级（不加 immutable，见 cacheControlFor）。
 */
async function serveSite(req, res, pathname, spaFallback = true, passthrough = false) {
    if (!SITE_DIR || (req.method !== "GET" && req.method !== "HEAD")) return false;
    const target = await resolveSiteFile(pathname, spaFallback);
    if (!target) return false;
    const headers = {
        "content-type": MIME_TYPES[extname(target).toLowerCase()] || "application/octet-stream",
        "cache-control": cacheControlFor(pathname, passthrough),
    };
    if (req.method === "HEAD") {
        headers["content-length"] = String((await fsp.stat(target)).size);
        send(res, 200, null, headers);
    } else {
        res.writeHead(200, headers);
        fs.createReadStream(target)
            .on("error", () => res.end())
            .pipe(res);
    }
    return true;
}

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
    res.setHeader("access-control-allow-headers", "content-type, x-file-name, x-director-token");
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
        // 插件壳 probeBridge 依赖的自描述信息：plugin 标识"端口上是不是我们的桥"，
        // site 标识"有没有托管站点"，version/dataDir/protocolVersion 供壳层比对与展示。
        if (group === "health") {
            return sendJson(res, 200, {
                ok: true,
                plugin: "director-desk",
                site: Boolean(SITE_DIR),
                version: SERVER_VERSION,
                dataDir: DATA_DIR,
                protocolVersion: DIRECTOR_PROTOCOL_VERSION,
            });
        }

        if (group === "bootstrap") {
            // 零配置发现：web 端由此拿桥地址与 token。token 仅下发给无 Origin 的本机脚本
            // 或回环 Origin 页面；跨站探测（公网网页 fetch 回环端口）返回不带 token 的 200，保持探测友好。
            const origin = req.headers.origin || "";
            const includeToken = !origin || LOOPBACK_ORIGIN.test(origin);
            return sendJson(res, 200, {
                ok: true,
                name: SERVER_NAME,
                version: SERVER_VERSION,
                protocolVersion: DIRECTOR_PROTOCOL_VERSION,
                url: `http://127.0.0.1:${PORT}`,
                ...(includeToken ? { token: TOKEN } : {}),
            });
        }

        // token 鉴权中间件：豁免之外的全部端点（/events、/director/*、/kv、/assets、/skills…）
        // 未通过则 401。鉴权在响应头写出前完成；SSE（EventSource 不带自定义头）与 <img>
        // 等 web 端用 query 形式（?token=），见 validToken。
        if (!(await tokenExempt(req, pathname)) && !validToken(req, url)) {
            return sendJson(res, 401, { ok: false, error: "invalid token" });
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
                if (!fs.existsSync(bin)) {
                    // 存储键缺失时只允许精确文件穿透（vite 的 /assets/*.js|css 与存储键共用 /assets 前缀）；穿透分支缓存头降级
                    if (await serveSite(req, res, pathname, false, true)) return;
                    return sendJson(res, 404, { ok: false, error: "not found" });
                }
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

        // 站点静态兜底（阶段二）：未匹配任何 API/桥路由的 GET 交给导演台 Web 应用
        if (await serveSite(req, res, pathname)) return;

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
