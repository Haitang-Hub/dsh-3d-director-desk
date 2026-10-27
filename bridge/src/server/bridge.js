/**
 * 导演台桥：编辑器页面以 director 角色经 SSE 注册为 executor，
 * 桥接收 MCP/HTTP 的工具调用，按 desk 路由给已就绪的页面执行并回传结果。
 * 协议与 infinite-canvas 的 canvas-agent 桥同源（protocolVersion=7，dv 为桥实现版本）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";

import { getTool, toolTimeoutMs } from "../schema/tools.js";
import { DIRECTOR_PROTOCOL_VERSION } from "../protocol.js";

const HEARTBEAT_MS = 15_000;
const AUDIT_SUMMARY_MAX = 500;

/** 带结构化码的工具调用错误：HTTP/MCP 门面按此序列化给 harness。 */
export class ToolError extends Error {
    constructor(message, code = "tool_error", hint = "") {
        super(message);
        this.code = code;
        this.hint = hint;
    }
}

export class DirectorBridge {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.logsDir = join(dataDir, "logs");
        /** clientId -> { res, version, deskId, ready, activeAt } */
        this.executors = new Map();
        /** requestId -> { clientId, resolve, reject, timer } */
        this.pending = new Map();
        /** deskKey -> Promise：同 desk 的 executor 串行执行，避免场景状态竞态 */
        this.queues = new Map();
    }

    /** 建立 executor 的 SSE 连接（web 端 EventSource /events?role=director&dv=&desk=）。 */
    openEvents(url, res) {
        const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
        const deskId = url.searchParams.get("desk") || "";
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        this.executors.set(clientId, { res, version: Number(url.searchParams.get("dv")) || 0, deskId, ready: false, activeAt: Date.now() });
        // ready 由桥在编辑器完全加载后经 /director/ready 上报；未就绪的页面不参与路由。
        sendEvent(res, "hello", { ok: true, protocolVersion: DIRECTOR_PROTOCOL_VERSION, clientId });
        const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), HEARTBEAT_MS);
        res.on("close", () => {
            clearInterval(timer);
            this.executors.delete(clientId);
            this.pending.forEach((item, requestId) => {
                if (item.clientId !== clientId) return;
                clearTimeout(item.timer);
                this.pending.delete(requestId);
                item.reject(new ToolError("executor 页面已断开", "executor_disconnected"));
            });
        });
    }

    /** 编辑器完全加载后的就绪上报；只有就绪的页面参与工具路由。 */
    markReady(clientId, deskId) {
        const entry = this.executors.get(clientId);
        if (!entry) return false;
        this.executors.set(clientId, { ...entry, deskId: deskId || entry.deskId, ready: true, activeAt: Date.now() });
        return true;
    }

    /** 在线 executor 概况（doctor/状态徽标用）。 */
    status() {
        return {
            protocolVersion: DIRECTOR_PROTOCOL_VERSION,
            executors: [...this.executors.entries()].map(([clientId, item]) => ({
                clientId,
                deskId: item.deskId,
                ready: item.ready,
                version: item.version,
                connectedForMs: Date.now() - item.activeAt,
            })),
        };
    }

    /** 接收 executor 回传的工具结果。 */
    resolveResult(clientId, body) {
        const item = body?.requestId ? this.pending.get(body.requestId) : null;
        if (!item || item.clientId !== clientId) return false;
        clearTimeout(item.timer);
        this.pending.delete(body.requestId);
        if (body.error) item.reject(new ToolError(String(body.error)));
        else item.resolve(body.result ?? { ok: true });
        return true;
    }

    /**
     * 执行一次工具调用：选 desk 匹配的最近活跃就绪 executor，经 SSE 下发并等待回传。
     * 同 desk 串行（FIFO），不同 desk 并行。desk 为空表示任意可用 executor。
     * 审计统一在 dispatch 内落盘（成功/失败/超时各一条）。
     */
    callTool(name, input = {}, deskId = "") {
        const queueKey = deskId || "_any";
        const previous = this.queues.get(queueKey) || Promise.resolve();
        const run = previous.catch(() => undefined).then(() => this.dispatch(name, input, deskId));
        this.queues.set(queueKey, run);
        // .then 双分支消化派生 promise，避免调用方尚未 await 时出现未处理拒绝
        const cleanup = () => {
            if (this.queues.get(queueKey) === run) this.queues.delete(queueKey);
        };
        run.then(cleanup, cleanup);
        return run;
    }

    async dispatch(name, input, deskId) {
        const startedAt = Date.now();
        if (!getTool(name)) {
            const error = new ToolError(`未知导演台工具：${name}`, "unknown_tool", "可用工具用 tools/list 查询");
            await this.audit(name, deskId, input, Date.now() - startedAt, error);
            throw error;
        }
        const picked = this.pickExecutor(deskId);
        if (!picked) {
            const error = new ToolError(
                "导演台 executor 离线",
                "executor_offline",
                "请先打开 3D 导演台页面 http://localhost:5080 并进入一个导演台编辑器",
            );
            await this.audit(name, deskId, input, Date.now() - startedAt, error);
            throw error;
        }
        const [clientId, target] = picked;
        const requestId = crypto.randomUUID();
        sendEvent(target.res, "tool_call", { requestId, name, input });
        try {
            const result = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(requestId);
                    reject(new ToolError(`工具 ${name} 执行超时（${Math.round(toolTimeoutMs(name) / 1000)}s）`, "timeout", "导出类工具耗时较长，可稍后重试或降低分辨率/帧率"));
                }, toolTimeoutMs(name));
                this.pending.set(requestId, { clientId, resolve, reject, timer });
            });
            await this.audit(name, deskId || target.deskId, input, Date.now() - startedAt, null);
            return result;
        } catch (error) {
            await this.audit(name, deskId || target.deskId, input, Date.now() - startedAt, error);
            throw error;
        }
    }

    /** 选择就绪 executor：指定 desk 时只路由到该 desk；否则取最近活跃的。 */
    pickExecutor(deskId) {
        const ready = [...this.executors.entries()].filter(([, item]) => item.ready);
        if (!ready.length) return null;
        const pool = deskId ? ready.filter(([, item]) => item.deskId === deskId) : ready;
        if (!pool.length) return null;
        const latestVersion = Math.max(...pool.map(([, item]) => item.version));
        return pool.filter(([, item]) => item.version === latestVersion).sort((a, b) => b[1].activeAt - a[1].activeAt)[0] || null;
    }

    /** 结构化审计：每次工具调用一行 JSON（data/logs/tool-audit.jsonl）。 */
    async audit(name, deskId, input, durationMs, error) {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            desk: deskId || "",
            tool: name,
            inputSummary: summarize(input),
            durationMs,
            status: error ? (error.code || "error") : "ok",
            ...(error ? { error: error.message } : {}),
        });
        try {
            fs.mkdirSync(this.logsDir, { recursive: true });
            await fs.promises.appendFile(join(this.logsDir, "tool-audit.jsonl"), line + "\n", "utf8");
        } catch {
            // 审计失败不影响工具调用本身
        }
    }
}

function summarize(input) {
    try {
        const text = JSON.stringify(input);
        return text.length > AUDIT_SUMMARY_MAX ? text.slice(0, AUDIT_SUMMARY_MAX) + "…" : text;
    } catch {
        return "";
    }
}

function sendEvent(res, type, payload) {
    if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
