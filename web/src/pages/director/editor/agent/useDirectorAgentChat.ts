/**
 * 导演台内置 Agent 聊天状态：直连模型配置的 text 渠道，function calling 循环执行
 * 导演台工具（复用 SSE 桥的 runDirectorTool）。
 *
 * 展示模型：以「turn（一轮任务）」为单位——用户只看到目标进度与最终结论，
 * 推理叙述/工具调用/报错重试记录为 steps，UI 按需展开。
 * LLM 上下文走单独的原生消息历史（llmHistory，含 tool_calls 结构），与展示解耦。
 */

import { create } from "zustand";

import { randomId } from "@/lib/utils";

import { DIRECTOR_AGENT_SYSTEM_PROMPT, DIRECTOR_AGENT_TOOLS } from "./agentTools";
import { callAgentLlm, parseAgentToolArguments, resolveAgentRequestConfig, type AgentContentPart, type AgentLlmMessage } from "./agentLlm";
import { extractTextToolCall, stripReasoningAndToolCalls } from "./agentTextTools";
import { runDirectorTool } from "../hooks/use-director-agent-bridge";

/** 单段 LLM 轮数上限；耗尽且未得出结论时自动注入继续指令续段，而不是把任务停给用户。 */
const MAX_TOOL_ROUNDS = 8;
/** 自动续段次数上限（总轮数 ≤ (1+MAX_AUTO_CONTINUES) × MAX_TOOL_ROUNDS），防失控烧钱；耗尽后才交给用户手动继续。 */
const MAX_AUTO_CONTINUES = 3;

/** 幕后步骤：中间叙述（规划/进度）、工具调用（含失败重试）、备注。 */
export type AgentStep =
    | { id: string; kind: "narration"; text: string }
    | { id: string; kind: "tool"; name: string; summary: string; ok: boolean }
    | { id: string; kind: "note"; text: string };

export type AgentTurn = {
    id: string;
    goal: string;
    images: string[];
    previews: string[];
    status: "running" | "done" | "failed";
    steps: AgentStep[];
    progressText: string;
    conclusion: string;
    error: string;
};

type DirectorAgentChatStore = {
    open: boolean;
    sending: boolean;
    turns: AgentTurn[];
    llmHistory: AgentLlmMessage[];
    toggle: () => void;
    setOpen: (open: boolean) => void;
    clear: () => void;
    send: (prompt: string, images?: string[]) => Promise<void>;
};

export const useDirectorAgentChat = create<DirectorAgentChatStore>((set, get) => ({
    open: false,
    sending: false,
    turns: [],
    llmHistory: [],

    toggle: () => set((state) => ({ open: !state.open })),
    setOpen: (open) => set({ open }),
    clear: () => set({ turns: [], llmHistory: [] }),

    async send(prompt, images) {
        const text = prompt.trim();
        const imageUrls = (images || []).filter((url) => url.startsWith("data:image/"));
        if ((!text && !imageUrls.length) || get().sending) return;
        // 纯图片没有文字时补一个占位目标，模型侧也能理解
        const goal = text || "请分析我上传的图片";

        // 渠道校验前置：没配渠道直接给出可操作的错误
        try {
            resolveAgentRequestConfig();
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            set((state) => ({
                turns: [...state.turns, { id: randomId(), goal, images: imageUrls, previews: [], status: "failed", steps: [], progressText: "", conclusion: "", error: messageText }],
            }));
            return;
        }

        const turn: AgentTurn = { id: randomId(), goal, images: imageUrls, previews: [], status: "running", steps: [], progressText: "正在思考…", conclusion: "", error: "" };
        set((state) => ({ turns: [...state.turns, turn], sending: true }));
        const patchTurn = (patch: Partial<AgentTurn>) => set((state) => ({ turns: state.turns.map((item) => (item.id === turn.id ? { ...item, ...patch } : item)) }));
        const addStep = (step: AgentStep) => set((state) => ({ turns: state.turns.map((item) => (item.id === turn.id ? { ...item, steps: [...item.steps, step] } : item)) }));

        try {
            const userContent: string | AgentContentPart[] = imageUrls.length
                ? [
                      ...(text ? [{ type: "text" as const, text }] : []),
                      ...imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
                  ]
                : text;
            const history: AgentLlmMessage[] = [...get().llmHistory, { role: "user", content: userContent }];
            let conclusion = "";
            let autoContinues = MAX_AUTO_CONTINUES;
            let concluded = false;
            while (!concluded) {
                for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
                    const { content, toolCalls } = await callAgentLlm([{ role: "system", content: DIRECTOR_AGENT_SYSTEM_PROMPT }, ...history], DIRECTOR_AGENT_TOOLS);
                    // 宽容解析（取自无限画布）：模型未走原生 tool_calls 而在文本里裸写工具调用时，提取出来照样执行；
                    // 无论哪种形态，先剥离 <think> 推理与调用块，保证上屏/入历史的都是干净文本。
                    let effectiveToolCalls = toolCalls;
                    const textCall = toolCalls.length ? null : extractTextToolCall(content);
                    if (textCall) {
                        effectiveToolCalls = [{ id: `text_${randomId()}`, name: textCall.call.name, arguments: JSON.stringify(textCall.call.input) }];
                    }
                    const assistantText = stripReasoningAndToolCalls(content);

                    if (assistantText && effectiveToolCalls.length) {
                        // 中间轮叙述：作为幕后步骤与进度行
                        addStep({ id: randomId(), kind: "narration", text: assistantText });
                        patchTurn({ progressText: firstLine(assistantText) });
                    }
                    if (!effectiveToolCalls.length) {
                        conclusion = assistantText;
                        if (assistantText) history.push({ role: "assistant", content: assistantText });
                        concluded = true;
                        break;
                    }

                    history.push({
                        role: "assistant",
                        content: assistantText,
                        tool_calls: effectiveToolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })),
                    });
                    for (const call of effectiveToolCalls) {
                        patchTurn({ progressText: `执行 ${call.name}…` });
                        let summary = "";
                        let ok = true;
                        try {
                            const args = parseAgentToolArguments(call.arguments) as Record<string, unknown>;
                            // 渲染单帧时要求带回 dataUrl，界面把预览图直接展示在对话里
                            if (call.name === "preview_render_frame") args.includeData = true;
                            const result = await runDirectorTool(call.name, args);
                            if (result && typeof result === "object" && typeof (result as Record<string, unknown>).dataUrl === "string") {
                                const preview = (result as { dataUrl?: string }).dataUrl as string;
                                set((state) => ({ turns: state.turns.map((item) => (item.id === turn.id ? { ...item, previews: [...item.previews, preview] } : item)) }));
                            }
                            summary = summarizeToolResult(result);
                        } catch (error) {
                            ok = false;
                            summary = error instanceof Error ? error.message : String(error);
                        }
                        addStep({ id: randomId(), kind: "tool", name: call.name, summary, ok });
                        history.push({ role: "tool", tool_call_id: call.id, content: ok ? JSON.stringify({ ok: true, summary }) : JSON.stringify({ error: summary }) });
                    }
                }
                if (concluded || autoContinues <= 0) break;
                // 单段轮次耗尽且模型没有给出结论：视为任务未完成，自动续段而不是停给用户
                autoContinues -= 1;
                addStep({ id: randomId(), kind: "note", text: `达到单轮调用上限（${MAX_TOOL_ROUNDS} 轮），任务未完成，自动继续…` });
                history.push({ role: "user", content: "继续执行：任务尚未完成就接着做；如果实际已完成，直接给出最终结论。" });
            }

            if (!conclusion) {
                // 全部续段耗尽仍无明确结论：用最后一段叙述兜底，仍算完成
                const lastNarration = [...turn.steps].reverse().find((step) => step.kind === "narration");
                conclusion = (lastNarration as { text: string } | undefined)?.text || "任务已执行完毕（达到单轮工具调用上限）。";
                history.push({ role: "assistant", content: conclusion });
            }
            patchTurn({ status: "done", conclusion, progressText: "" });
            set({ llmHistory: history, sending: false });
        } catch (error) {
            // 渠道/网络级失败：turn 标记失败，不污染 llmHistory（用户修正后重发即可）
            const messageText = error instanceof Error ? error.message : String(error);
            patchTurn({ status: "failed", error: messageText, progressText: "" });
            set({ sending: false });
        }
    },
}));

function firstLine(text: string) {
    const line = text.split("\n").map((item) => item.trim()).find(Boolean) || text;
    return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

/** 工具结果摘要：对象 ID/文件名/数量优先，长 JSON 截断；dataUrl（base64 大图）不进模型上下文。 */
function summarizeToolResult(result: unknown) {
    let text: string;
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        const parts = Object.entries(record)
            .filter(([key, value]) => key !== "dataUrl" && value !== undefined && value !== null)
            .slice(0, 6)
            .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
        text = parts.join(", ");
    } else {
        text = String(result);
    }
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
