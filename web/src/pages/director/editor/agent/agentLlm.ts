/**
 * 内置 Agent 的模型调用：OpenAI 兼容 Chat Completions 与 Anthropic 原生 Messages（均非流式、带 function calling）。
 * 模型取自「模型配置」的 text 渠道；baseUrl 采用带 /v1 的配置方式（buildApiUrl 自动补 /v1）。
 */

import { buildApiUrl, decodeChannelModel, resolveModelChannel, useConfigStore } from "@/stores/use-config-store";

export type AgentLlmMessage =
    | { role: "system" | "user" | "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
    | { role: "tool"; tool_call_id: string; content: string };

type ChatCompletionResponse = {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }>;
    error?: { message?: string };
};

type AnthropicResponse = {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    error?: { message?: string };
};

export type AgentRequestConfig = {
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "anthropic";
    model: string;
};

/**
 * 解析 Agent 实际使用的模型：模型名必须落在解析到的渠道里——
 * textModel 是旧值/已失效（如历史遗留的裸模型名）时，退到该渠道第一个 text 模型，
 * 避免出现「A 渠道的地址 + B 模型名」的错配请求。
 */
function resolveAgentModelConfig() {
    const config = useConfigStore.getState().config;
    const channel = resolveModelChannel(config, config.textModel);
    const decoded = decodeChannelModel(config.textModel);
    const selected = (decoded?.model || config.textModel || "").trim();
    const matched = channel.models.some((item) => item.name === selected) ? selected : "";
    const fallback = channel.models.find((item) => item.capability === "text") || channel.models[0];
    return { config, channel, model: matched || fallback?.name || "" };
}

export function describeAgentModel(): string {
    try {
        return resolveAgentModelConfig().model || "未配置";
    } catch {
        return "未配置（先在模型配置里添加渠道）";
    }
}

/** 校验 text 渠道可用并返回请求配置；不可用时抛出带操作提示的错误。 */
export function resolveAgentRequestConfig(): AgentRequestConfig {
    const { channel, model } = resolveAgentModelConfig();
    if (!model) {
        throw new Error("渠道里还没有可用模型：先在「模型配置」里给渠道添加模型");
    }
    if (!channel.baseUrl.trim() || !channel.apiKey.trim()) {
        throw new Error("还没有可用的 text 模型渠道：先在「模型配置」里添加渠道（baseUrl + apiKey + 模型）");
    }
    if (channel.apiFormat !== "openai" && channel.apiFormat !== "anthropic") {
        throw new Error(`内置 Agent 支持OpenAI 兼容 / Anthropic 协议，当前渠道是 ${channel.apiFormat} 格式`);
    }
    return { baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat, model };
}

/** 把网络层失败翻译成可操作的提示（Failed to fetch 多为断网或渠道地址不可达）。 */
function describeFetchError(error: unknown) {
    if (error instanceof TypeError) {
        return new Error("网络请求失败：请检查网络连接，或确认渠道接口地址可达后重试。");
    }
    return error;
}

/** 调用一次模型；返回 assistant 文本与工具调用（两种协议统一为同一结果形态）。 */
export async function callAgentLlm(messages: AgentLlmMessage[], tools: unknown, signal?: AbortSignal): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
    const requestConfig = resolveAgentRequestConfig();
    try {
        return requestConfig.apiFormat === "anthropic" ? await callAnthropicLlm(requestConfig, messages, tools, signal) : await callOpenAiLlm(requestConfig, messages, tools, signal);
    } catch (error) {
        throw describeFetchError(error);
    }
}

async function callOpenAiLlm(requestConfig: AgentRequestConfig, messages: AgentLlmMessage[], tools: unknown, signal?: AbortSignal) {
    const response = await fetch(buildApiUrl(requestConfig.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${requestConfig.apiKey.trim()}` },
        body: JSON.stringify({ model: requestConfig.model, messages, tools, tool_choice: "auto", temperature: 0.6 }),
        signal,
    });
    const payload = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
    if (!response.ok || payload?.error?.message) {
        throw new Error(payload?.error?.message || `模型请求失败（HTTP ${response.status}）`);
    }
    const message = payload?.choices?.[0]?.message;
    const content = message?.content || "";
    const toolCalls = (message?.tool_calls || [])
        .filter((call) => call.type === "function" && call.function?.name)
        .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" }));
    return { content, toolCalls };
}

/* ---------- Anthropic 原生协议（/v1/messages）---------- */

type AnthropicBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "tool_result"; tool_use_id: string; content: string };

/** 把 OpenAI 形态的消息历史转成 Anthropic：system 独立、tool_calls → tool_use、连续 tool 结果合并为 tool_result。 */
function toAnthropicMessages(messages: AgentLlmMessage[]) {
    const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
    for (const message of messages) {
        if (message.role === "system") continue;
        if (message.role === "user") {
            out.push({ role: "user", content: [{ type: "text", text: message.content }] });
            continue;
        }
        if (message.role === "assistant") {
            const blocks: AnthropicBlock[] = [];
            if (message.content.trim()) blocks.push({ type: "text", text: message.content });
            for (const call of message.tool_calls || []) {
                let input: Record<string, unknown> = {};
                try {
                    input = JSON.parse(call.function.arguments || "{}");
                } catch {
                    input = {};
                }
                blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
            }
            out.push({ role: "assistant", content: blocks });
            continue;
        }
        if (message.role === "tool") {
            // 工具结果合并进同一条 user 消息（Anthropic 要求 tool_result 紧跟 assistant 的 tool_use）
            const block: AnthropicBlock = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content };
            const last = out[out.length - 1];
            if (last && last.role === "user" && last.content.every((item) => item.type === "tool_result")) {
                last.content.push(block);
            } else {
                out.push({ role: "user", content: [block] });
            }
        }
    }
    return out;
}

async function callAnthropicLlm(requestConfig: AgentRequestConfig, messages: AgentLlmMessage[], tools: unknown, signal?: AbortSignal) {
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const anthropicTools = (Array.isArray(tools) ? tools : [])
        .map((tool) => (tool as { type: "function"; function: { name: string; description: string; parameters: unknown } }).function)
        .filter(Boolean)
        .map((fn) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters }));
    const response = await fetch(buildApiUrl(requestConfig.baseUrl, "/messages"), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": requestConfig.apiKey.trim(),
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: requestConfig.model,
            max_tokens: 8192,
            ...(system ? { system } : {}),
            messages: toAnthropicMessages(messages),
            tools: anthropicTools,
            tool_choice: { type: "auto" },
        }),
        signal,
    });
    const payload = (await response.json().catch(() => null)) as AnthropicResponse | null;
    if (!response.ok || payload?.error?.message) {
        throw new Error(payload?.error?.message || `模型请求失败（HTTP ${response.status}）`);
    }
    const content = (payload?.content || [])
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text as string)
        .join("");
    const toolCalls = (payload?.content || [])
        .filter((block) => block.type === "tool_use" && block.name && block.id)
        .map((block) => ({ id: block.id as string, name: block.name as string, arguments: JSON.stringify(block.input ?? {}) }));
    return { content, toolCalls };
}

/** 解析工具调用参数；非法 JSON 报错交回模型重试。 */
export function parseAgentToolArguments(rawArguments: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(rawArguments || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        throw new Error(`工具参数不是合法 JSON：${rawArguments.slice(0, 120)}`);
    }
}

/** 导出渠道配置读取，供面板展示当前模型名。 */
export function agentChannelSummary(): string {
    return resolveAgentModelConfig().model;
}
