#!/usr/bin/env node
/**
 * director-mcp：3D 导演台的常驻本地服务（零依赖，端口 17372）。
 *
 *   node index.js          常驻 HTTP 服务：本地文件存储（/kv、/assets）+ 导演台桥（/events、/director/*）
 *   node index.js mcp      stdio MCP 门面（DeepSeek harness 经此接入，工具调用转发到常驻桥）
 *   node index.js doctor   自检：桥端口、executor 在线数、data 目录可写、协议版本
 */

import fs from "node:fs";
import http from "node:http";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DIRECTOR_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from "./src/protocol.js";

const DATA_DIR = resolve(process.env.DIRECTOR_STORE_DIR?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..", "data"));
const BRIDGE_URL = (process.env.DIRECTOR_BRIDGE_URL || "http://127.0.0.1:17372").replace(/\/$/, "");

const command = process.argv[2] || "";

if (command === "mcp") {
    const { startMcpServer } = await import("./src/server/mcp.js");
    await startMcpServer();
} else if (command === "doctor") {
    await runDoctor();
} else {
    const { startHttpServer } = await import("./src/server/http.js");
    startHttpServer();
}

/** 一次性 GET（禁用 keep-alive，避免 doctor 退出时 libuv 断言）。 */
function getJson(url) {
    return new Promise((resolvePromise) => {
        const req = http.get(url, { agent: new http.Agent({ keepAlive: false }) }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                try {
                    resolvePromise({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
                } catch {
                    resolvePromise({ status: res.statusCode, body: null });
                }
            });
        });
        req.setTimeout(2000, () => req.destroy(new Error("timeout")));
        req.on("error", () => resolvePromise(null));
    });
}

/** 自检：桥是否在线、executor 是否就绪、data 目录是否可写、协议版本是否匹配。 */
async function runDoctor() {
    let failures = 0;
    const fail = (text) => ((failures += 1), console.log(`  [FAIL] ${text}`));
    const pass = (text) => console.log(`  [ OK ] ${text}`);

    console.log(`${SERVER_NAME} doctor (v${SERVER_VERSION}, bridge protocol v${DIRECTOR_PROTOCOL_VERSION})`);

    const health = await getJson(`${BRIDGE_URL}/health`);
    if (health?.body?.ok) pass(`桥在线：${BRIDGE_URL}（data dir: ${health.body.dataDir}）`);
    else fail(`桥不在线：${BRIDGE_URL} —— 在 director-mcp 目录运行 node index.js（或用 start.bat 启动）`);

    if (health?.body?.ok) {
        const status = await getJson(`${BRIDGE_URL}/director/status`);
        const ready = (status?.body?.executors || []).filter((item) => item.ready);
        if (ready.length) pass(`executor 在线 ${ready.length} 个：${ready.map((item) => item.deskId || "(未指定 desk)").join(", ")}`);
        else fail("没有已就绪的导演台页面 —— 打开 http://localhost:5080 并进入一个导演台编辑器后重试");
    }

    try {
        const probe = join(DATA_DIR, `doctor-${Date.now()}.tmp`);
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        pass(`data 目录可写：${DATA_DIR}`);
    } catch (error) {
        fail(`data 目录不可写：${error instanceof Error ? error.message : error}`);
    }

    process.exit(failures ? 1 : 0);
}
