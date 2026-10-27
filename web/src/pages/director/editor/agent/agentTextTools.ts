/**
 * 宽容的文本形态工具调用解析（移植自无限画布的 ai-assistant-engine）：
 * 模型未走原生 function calling、把工具调用以文本输出时，从回复中提取并执行。
 * 容忍三种形态：```tool 围栏、```json 围栏、裸 JSON 对象；键名容忍 name/tool；
 * 同时剥离 <think> 推理块，保证上屏与入历史的都是干净文本。
 */

import { DIRECTOR_AGENT_TOOLS } from "./agentTools";

const DIRECTOR_TOOL_NAMES = DIRECTOR_AGENT_TOOLS.map((tool) => tool.function.name);

/** 解析工具调用 JSON（容忍 name/tool 两种键名）；非法或未知工具返回 null。 */
function parseToolObject(raw: string): { name: string; input: Record<string, unknown> } | null {
    try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        const name = typeof value.name === "string" ? value.name : typeof value.tool === "string" ? value.tool : "";
        if (!(DIRECTOR_TOOL_NAMES as string[]).includes(name)) return null;
        const input = value.input && typeof value.input === "object" && !Array.isArray(value.input) ? (value.input as Record<string, unknown>) : {};
        return { name, input };
    } catch {
        return null;
    }
}

/**
 * 从回复文本中提取第一个工具调用并返回其在原文中的范围。
 * 部分模型不按原生 tool_calls 输出，直接文本裸写 {"tool": ...}，也必须能执行。
 */
export function extractTextToolCall(text: string): { call: { name: string; input: Record<string, unknown> }; start: number; end: number } | null {
    const keyRe = /"(?:tool|name)"\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = keyRe.exec(text))) {
        const braceStart = text.lastIndexOf("{", match.index);
        if (braceStart < 0) continue;
        // 从最近的 { 起做括号配对（跳过字符串），提取完整 JSON 对象。
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let i = braceStart; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === "{") depth += 1;
            else if (ch === "}") {
                depth -= 1;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }
        if (end < 0) continue;
        const call = parseToolObject(text.slice(braceStart, end));
        if (call) {
            // 扩展范围吞掉包裹的围栏标记，便于调用方一并剥离。
            let start = braceStart;
            const fencePrefix = /```(?:tool|json)?\s*$/.exec(text.slice(Math.max(0, start - 12), start));
            if (fencePrefix) start -= fencePrefix[0].length;
            const fenceSuffix = /^\s*```/.exec(text.slice(end, end + 6));
            if (fenceSuffix) end += fenceSuffix[0].length;
            return { call, start, end };
        }
        keyRe.lastIndex = match.index + 1;
    }
    return null;
}

/** 剥离 <think> 推理块（含未闭合的 </think> 之前的一切推理）与文本形态工具调用块。 */
export function stripReasoningAndToolCalls(text: string): string {
    let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
    // 孤立 </think>（模型只吐了闭合标记）：推理在它之前，全部裁掉。
    const closing = out.lastIndexOf("</think>");
    if (closing >= 0) out = out.slice(closing + "</think>".length);
    for (let found = extractTextToolCall(out); found; found = extractTextToolCall(out)) {
        out = `${out.slice(0, found.start)}${out.slice(found.end)}`;
    }
    return out.trim();
}
