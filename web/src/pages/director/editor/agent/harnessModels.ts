/**
 * Harness 模型桥：导演台 AI 助手在 DSH 面板（iframe）里经 postMessage 请求宿主插件客户端，
 * 由客户端代理访问 /api/director-desk.harness-* 端点。
 *
 * - provider 的 API key 只存在于 harness 进程内，页面与桥都拿不到；
 * - 不在 DSH 面板中时所有请求都会失败，调用方据此降级提示用自配渠道；
 * - 选择值编码进 config.textModel：`harness::<provider>::<model>`，
 *   与渠道编码 `channelId::modelName` 区分。
 */

export const HARNESS_SELECTION_PREFIX = "harness::";

export type HarnessModelGroup = {
    provider: string;
    providerName: string;
    models: Array<{ id: string; name: string; description?: string }>;
};

export type HarnessChatResult = {
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
};

export function encodeHarnessSelection(provider: string, model: string) {
    return `${HARNESS_SELECTION_PREFIX}${provider}::${model}`;
}

/** 解析 harness 选择值；不是 harness 编码时返回 null（走自配渠道）。 */
export function decodeHarnessSelection(value: string): { provider: string; model: string } | null {
    if (!value || !value.startsWith(HARNESS_SELECTION_PREFIX)) return null;
    const rest = value.slice(HARNESS_SELECTION_PREFIX.length);
    const sep = rest.indexOf("::");
    if (sep <= 0 || sep >= rest.length - 2) return null;
    return { provider: rest.slice(0, sep), model: rest.slice(sep + 2) };
}

let requestSeq = 0;
let bridgeInitialized = false;
const pending = new Map<string, { resolve: (body: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function ensureBridge() {
    if (bridgeInitialized) return;
    bridgeInitialized = true;
    window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || typeof data !== "object" || data.type !== "dsh-harness:response") return;
        const requestId = String(data.requestId || "");
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.resolve(data as Record<string, unknown>);
    });
}

function isEmbedded() {
    try {
        return window.self !== window.top;
    } catch {
        return false;
    }
}

function request(action: string, payload?: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (!isEmbedded()) return Promise.reject(new Error("当前不在 DeepSeek Harness 面板中，无法使用 Harness 模型"));
    ensureBridge();
    const requestId = `harness_${Date.now()}_${(requestSeq += 1)}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("Harness 模型请求超时，请确认 DSH 插件已启用"));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        window.parent.postMessage({ type: "dsh-harness:request", requestId, action, ...(payload !== undefined ? { payload } : {}) }, "*");
    });
}

/** 拉取宿主已注册的 provider/模型分组；不在 DSH 中或宿主无可用模型时抛错。 */
export async function listHarnessModels(): Promise<HarnessModelGroup[]> {
    const body = await request("models", undefined, 15_000);
    if (body.ok !== true || !Array.isArray(body.groups)) {
        throw new Error(typeof body.error === "string" && body.error ? body.error : "无法获取 Harness 模型列表");
    }
    return (body.groups as HarnessModelGroup[]).filter((group) => group && Array.isArray(group.models) && group.models.length > 0);
}

export type HarnessChatInput = {
    provider: string;
    model: string;
    messages: unknown[];
    tools?: unknown;
    temperature?: number;
};

/** 经宿主代理调用一次模型（OpenAI 形态入参，返回统一为文本 + 工具调用）。 */
export async function callHarnessLlm(input: HarnessChatInput): Promise<HarnessChatResult> {
    const body = await request("chat", input, 620_000);
    if (body.ok !== true) {
        throw new Error(typeof body.error === "string" && body.error ? body.error : "Harness 模型调用失败");
    }
    const toolCalls = Array.isArray(body.toolCalls)
        ? (body.toolCalls as Array<{ id?: unknown; name?: unknown; arguments?: unknown }>)
            .filter((call) => call && typeof call.name === "string" && call.name)
            .map((call) => ({ id: String(call.id || ""), name: String(call.name), arguments: String(call.arguments || "{}") }))
        : [];
    return { content: typeof body.content === "string" ? body.content : "", toolCalls };
}
