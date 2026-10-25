import { useEffect, useRef, useState } from "react";
import { Bot, Send, Trash2, X } from "lucide-react";

import { describeAgentModel } from "./agentLlm";
import { useDirectorAgentChat } from "./useDirectorAgentChat";

/** 渲染一行工具执行记录（折叠为单行 chip）。 */
function ToolChip({ name, summary, failed }: { name?: string; summary?: string; failed?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    if (!name) return null;
    return (
        <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className={`max-w-full truncate rounded-md border px-2 py-1 text-left font-mono text-[11px] transition ${failed ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-sky-500/30 bg-sky-500/10 text-sky-300"} ${expanded ? "whitespace-pre-wrap break-all" : ""}`}
            title={summary}
        >
            {expanded ? summary : `⚙ ${name} · ${summary?.slice(0, 80) || "已执行"}`}
        </button>
    );
}

/** 导演台内置 Agent 聊天面板：右侧浮动抽屉，工具循环在页面内直接执行。 */
export function DirectorAgentChatPanel() {
    const { open, sending, messages, activity, toggle, setOpen, clear, send } = useDirectorAgentChat();
    const [draft, setDraft] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);
    const model = describeAgentModel();

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, [messages.length, activity, sending]);

    if (!open) return null;

    function submit() {
        const text = draft.trim();
        if (!text || sending) return;
        setDraft("");
        void send(text);
    }

    return (
        <aside className="absolute inset-y-2 right-2 z-40 flex w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0b0f17]/95 text-slate-200 shadow-2xl backdrop-blur" role="dialog" aria-label="AI 助手">
            <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
                <Bot aria-hidden="true" size={16} className="text-sky-400" />
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">AI 助手</div>
                    <div className="truncate text-[11px] text-slate-500" title={model}>模型：{model}</div>
                </div>
                <button type="button" className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-slate-200" aria-label="清空对话" title="清空对话" onClick={clear}>
                    <Trash2 aria-hidden="true" size={14} />
                </button>
                <button type="button" className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-slate-200" aria-label="关闭 AI 助手" title="关闭" onClick={() => setOpen(false)}>
                    <X aria-hidden="true" size={16} />
                </button>
            </header>

            <div ref={scrollRef} className="hide-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
                {messages.length === 0 ? (
                    <div className="space-y-2 text-xs leading-relaxed text-slate-500">
                        <p>让我来帮你摆场景和运镜。试试：</p>
                        <ul className="list-inside list-disc space-y-1">
                            <li>放两个角色面对面对话，再摆一个箱子</li>
                            <li>给活动机位加一个环绕运镜</li>
                            <li>渲染一帧看看现在的构图</li>
                        </ul>
                        <p>渲染/导出前请确认没有遮挡预览的弹窗。</p>
                    </div>
                ) : (
                    messages.map((message) => {
                        if (message.role === "tool") return <ToolChip key={message.id} name={message.toolName} summary={message.toolSummary} failed={message.text !== "ok"} />;
                        if (message.role === "error") {
                            return (
                                <div key={message.id} className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
                                    {message.text}
                                </div>
                            );
                        }
                        return (
                            <div
                                key={message.id}
                                className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-xs leading-relaxed ${
                                    message.role === "user" ? "ml-8 bg-sky-600/80 text-white" : "mr-2 border border-white/10 bg-white/5 text-slate-200"
                                }`}
                            >
                                {message.text}
                            </div>
                        );
                    })
                )}
                {sending ? <div className="animate-pulse px-1 text-[11px] text-sky-400">{activity || "处理中…"}</div> : null}
            </div>

            <div className="shrink-0 border-t border-white/10 p-2">
                <div className="flex items-end gap-2">
                    <textarea
                        className="hide-scrollbar max-h-28 min-h-[38px] flex-1 resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-sky-500/60"
                        placeholder="描述想要的场景或镜头…"
                        rows={1}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                submit();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="发送"
                        disabled={sending || !draft.trim()}
                        onClick={submit}
                    >
                        <Send aria-hidden="true" size={15} />
                    </button>
                </div>
            </div>
        </aside>
    );
}

/** 顶栏「AI 助手」开关按钮。 */
export function DirectorAgentChatToggle() {
    const open = useDirectorAgentChat((state) => state.open);
    const toggle = useDirectorAgentChat((state) => state.toggle);
    return (
        <button
            className={`top-bar-motion-button${open ? " is-active" : ""}`}
            type="button"
            aria-label={open ? "关闭 AI 助手" : "打开 AI 助手"}
            aria-pressed={open}
            onClick={toggle}
        >
            <Bot aria-hidden="true" size={15} />
            AI 助手
        </button>
    );
}
