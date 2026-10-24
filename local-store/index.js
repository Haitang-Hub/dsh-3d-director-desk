#!/usr/bin/env node
/**
 * 3D 导演台本地文件存储服务（零依赖，端口 17372）。
 * 把导演台工程（localStorage 键值）与导入的模型资产（二进制）落到项目 data/ 目录，
 * 摆脱浏览器存储的 origin 隔离与清库风险。
 *
 * 端点：
 *   GET    /health
 *   GET    /kv                 -> { keys: [...] }
 *   GET    /kv/:key            -> 文本内容（404 = 无）
 *   PUT    /kv/:key            <- 文本内容
 *   DELETE /kv/:key
 *   POST   /assets/:key        <- 二进制体（X-File-Name 可选、Content-Type 为 mime）
 *   GET    /assets/:key        -> 二进制内容
 *   DELETE /assets/:key
 */

import fs from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.STORE_PORT || 17372);
const HOST = process.env.STORE_HOST || "127.0.0.1";
const DATA_DIR = resolve(process.env.DIRECTOR_STORE_DIR?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..", "data"));

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

const server = http.createServer(async (req, res) => {
    // 本机服务，全部放开 CORS，供不同端口的 dev server 页面访问
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, PUT, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, x-file-name");
    if (req.method === "OPTIONS") return sendJson(res, 204, {});

    let pathname = "";
    try {
        pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname);
    } catch {
        return sendJson(res, 400, { ok: false, error: "bad url" });
    }
    const segments = pathname.split("/").filter(Boolean);
    const [group, ...rest] = segments;
    const key = rest.length ? rest.join("/") : "";

    try {
        if (group === "health") return sendJson(res, 200, { ok: true, dataDir: DATA_DIR });

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

server.listen(PORT, HOST, () => {
    console.log(`[local-store] listening on http://${HOST}:${PORT}, data dir: ${DATA_DIR}`);
});
