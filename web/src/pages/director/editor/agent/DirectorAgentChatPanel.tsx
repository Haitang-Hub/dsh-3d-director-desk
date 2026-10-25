import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, ChevronDown, ChevronRight, ChevronUp, Eraser, Magnet, SlidersHorizontal, X } from "lucide-react";

import { encodeChannelModel, useConfigStore, type ModelChannel } from "@/stores/use-config-store";

import { useDirectorAgentChat, type AgentStep, type AgentTurn } from "./useDirectorAgentChat";

/** 面板布局：停靠（左/右，磁性吸附）或自由浮动；位置与外观持久化。 */
type PanelLayout = { mode: "left" | "right" | "float"; x: number; y: number; collapsed: boolean; glassAlpha: number; compact: boolean };

const LAYOUT_STORAGE_KEY = "director-agent-panel-layout-v1";
const DOCK_SNAP_DISTANCE = 56;
const FLOAT_WIDTH = 344;

function loadLayout(): PanelLayout {
    try {
        const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<PanelLayout>;
            if (parsed.mode === "left" || parsed.mode === "right" || parsed.mode === "float") {
                return {
                    mode: parsed.mode,
                    x: Number(parsed.x) || 80,
                    y: Number(parsed.y) || 80,
                    collapsed: Boolean(parsed.collapsed),
                    glassAlpha: typeof parsed.glassAlpha === "number" ? Math.min(0.92, Math.max(0.3, parsed.glassAlpha)) : 0.68,
                    compact: Boolean(parsed.compact),
                };
            }
        }
    } catch {
        // 布局损坏时用默认值
    }
    return { mode: "right", x: 0, y: 0, collapsed: false, glassAlpha: 0.68, compact: false };
}

function saveLayout(layout: PanelLayout) {
    try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
        // 存储不可用时忽略
    }
}

/** 渲染一步幕后执行记录。 */
function StepItem({ step }: { step: AgentStep }) {
    if (step.kind === "narration") {
        return <div className="director-agent-process-narration">{step.text}</div>;
    }
    if (step.kind === "tool") {
        return <ToolChip name={step.name} summary={step.summary} failed={!step.ok} />;
    }
    return <div className="director-agent-process-narration is-note">{step.text}</div>;
}

/** 渲染一行工具执行记录（默认折叠为单行 chip，点击展开）。 */
function ToolChip({ name, summary, failed }: { name?: string; summary?: string; failed?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    if (!name) return null;
    return (
        <button
            type="button"
            className={`director-agent-panel-tool${failed ? " is-error" : ""}${expanded ? " is-expanded" : ""}`}
            onClick={() => setExpanded((value) => !value)}
            title={summary}
        >
            {expanded ? summary : `⚙ ${name} · ${summary?.slice(0, 90) || "已执行"}`}
        </button>
    );
}

/**
 * 一轮任务的展示：用户目标气泡 → 运行中进度卡 → 最终结论；
 * 推理叙述/工具调用/报错重试收进「执行过程」折叠区，按需展开。
 */
function TurnView({ turn }: { turn: AgentTurn }) {
    const [expanded, setExpanded] = useState(false);
    const toolCount = turn.steps.filter((step) => step.kind === "tool").length;

    return (
        <>
            <div className="director-agent-panel-bubble is-user">{turn.goal}</div>

            {turn.status === "running" ? (
                <div className="director-agent-progress" role="status">
                    <span className="director-agent-progress-spinner" aria-hidden="true" />
                    <div className="director-agent-progress-main">
                        <div className="director-agent-progress-text">{turn.progressText || "处理中…"}</div>
                        {toolCount > 0 ? <div className="director-agent-progress-meta">已执行 {toolCount} 步</div> : null}
                    </div>
                </div>
            ) : null}

            {turn.status === "done" && turn.conclusion ? (
                <div className="director-agent-panel-bubble is-assistant director-agent-conclusion">{turn.conclusion}</div>
            ) : null}

            {turn.status === "failed" ? (
                <div className="director-agent-panel-bubble is-error">{turn.error || "任务执行失败。"}</div>
            ) : null}

            {turn.steps.length > 0 && turn.status !== "running" ? (
                <div className="director-agent-process">
                    <button type="button" className="director-agent-process-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
                        <ChevronRight aria-hidden="true" size={12} className={expanded ? "is-open" : ""} />
                        执行过程 · {turn.steps.length} 步{toolCount ? `（工具 ${toolCount}）` : ""}
                    </button>
                    {expanded ? (
                        <div className="director-agent-process-body">
                            {turn.steps.map((step) => (
                                <StepItem key={step.id} step={step} />
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </>
    );
}

/** 输入框内的模型选择：自绘无边框下拉（原生 select 的弹出列表无法定制样式）。 */
function AgentModelRow() {
    const channels = useConfigStore((state) => state.config.channels);
    const textModel = useConfigStore((state) => state.config.textModel);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // 只列 text 类模型；渠道里没有标注 text 的模型时整渠道兜底显示（capability 猜测可能不准）
    const textModelsOf = (channel: ModelChannel) => {
        const text = channel.models.filter((model) => model.capability === "text");
        return text.length ? text : channel.models;
    };
    const options = channels.flatMap((channel) =>
        textModelsOf(channel).map((model) => ({ value: encodeChannelModel(channel.id, model.name), label: channel.name ? `${model.name} (${channel.name})` : model.name })),
    );

    // textModel 是历史遗留值/已失效时归一到第一个可选项，保证显示的就是实际用的模型
    useEffect(() => {
        if (options.length && !options.some((option) => option.value === textModel)) {
            updateConfig("textModel", options[0].value);
        }
    }, [textModel, options, updateConfig]);

    // 点击外部 / Esc 关闭
    useEffect(() => {
        if (!open) return;
        function onPointerDown(event: PointerEvent) {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
        }
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") setOpen(false);
        }
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    const selectedLabel = options.find((option) => option.value === textModel)?.label;

    return (
        <div className="director-agent-model-select" ref={rootRef}>
            <button
                type="button"
                className="director-agent-model-trigger"
                aria-label="选择模型"
                aria-haspopup="listbox"
                aria-expanded={open}
                title="AI 助手使用的对话模型"
                onClick={() => setOpen((value) => !value)}
            >
                <span className="director-agent-model-label">{selectedLabel || "未配置模型"}</span>
                <ChevronDown aria-hidden="true" size={13} className={`director-agent-model-caret${open ? " is-open" : ""}`} />
            </button>
            {open ? (
                <div className="director-agent-model-menu" role="listbox" aria-label="模型列表">
                    {options.length ? (
                        options.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                role="option"
                                aria-selected={option.value === textModel}
                                className={`director-agent-model-option${option.value === textModel ? " is-selected" : ""}`}
                                onClick={() => {
                                    updateConfig("textModel", option.value);
                                    setOpen(false);
                                }}
                            >
                                {option.label}
                            </button>
                        ))
                    ) : (
                        <div className="director-agent-model-empty">未配置模型 · 请在「模型配置」添加渠道</div>
                    )}
                </div>
            ) : null}
        </div>
    );
}

/** 导演台内置 Agent 聊天面板：自由拖拽 + 左右磁性吸附的浮动窗口。 */
export function DirectorAgentChatPanel() {
    const open = useDirectorAgentChat((state) => state.open);
    const sending = useDirectorAgentChat((state) => state.sending);
    const turns = useDirectorAgentChat((state) => state.turns);
    const setOpen = useDirectorAgentChat((state) => state.setOpen);
    const clear = useDirectorAgentChat((state) => state.clear);
    const send = useDirectorAgentChat((state) => state.send);

    const [layout, setLayout] = useState<PanelLayout>(loadLayout);
    const [dragging, setDragging] = useState(false);
    const [draft, setDraft] = useState("");
    const [showAppearance, setShowAppearance] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
    const panelRef = useRef<HTMLElement>(null);

    // 文本框随内容自适应高度（上限 140px，超出内部滚动）
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }, [draft]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        // turns 数组引用在每次进度/步骤更新时都会变化，运行中可跟随滚动
    }, [turns, sending]);

    // 唤出保险：持久化的浮动位置若落在当前视口外（换窗口/屏幕尺寸后），自动拉回可见区域
    useEffect(() => {
        if (!open) return;
        setLayout((current) => {
            if (current.mode !== "float") return current;
            // 面板高度是 min(72vh, 680px)，钳制 top 使整个面板落在视口内
            const panelHeight = Math.min(window.innerHeight * 0.72, 680);
            const x = Math.min(Math.max(current.x, 8), Math.max(8, window.innerWidth - FLOAT_WIDTH - 8));
            const y = Math.min(Math.max(current.y, 8), Math.max(8, window.innerHeight - panelHeight - 8));
            if (x === current.x && y === current.y) return current;
            const next = { ...current, x, y };
            saveLayout(next);
            return next;
        });
    }, [open]);

    if (!open) return null;

    function updateLayout(patch: Partial<PanelLayout>) {
        setLayout((current) => {
            const next = { ...current, ...patch };
            saveLayout(next);
            return next;
        });
    }

    function onHeaderPointerDown(event: React.PointerEvent) {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement;
        if (target.closest("button")) return; // 标题栏上的按钮不触发拖动
        const rect = panelRef.current?.getBoundingClientRect();
        if (!rect) return;
        dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.x, offsetY: event.clientY - rect.y };
        try {
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        } catch {
            // 某些环境的合成/无效 pointerId 不支持捕获，拖动仍可工作
        }
        setDragging(true);
    }

    function onHeaderPointerMove(event: React.PointerEvent) {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const x = event.clientX - drag.offsetX;
        const y = event.clientY - drag.offsetY;
        const maxX = window.innerWidth - 80;
        const maxY = window.innerHeight - 48;
        setLayout((current) => ({ ...current, mode: "float", x: Math.min(Math.max(x, -FLOAT_WIDTH + 80), maxX), y: Math.min(Math.max(y, 0), maxY) }));
    }

    function onHeaderPointerUp(event: React.PointerEvent) {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        // 直接由指针坐标计算最终位置：不读 DOM rect（React 异步刷帧时 rect 可能还是拖动前的）
        const left = event.clientX - drag.offsetX;
        const top = event.clientY - drag.offsetY;
        dragRef.current = null;
        setDragging(false);
        // 磁性吸附：接近左右边缘时停靠
        setLayout((current) => {
            const right = left + FLOAT_WIDTH;
            let mode: PanelLayout["mode"];
            let x = 0;
            let y = 0;
            if (left < DOCK_SNAP_DISTANCE) {
                mode = "left";
            } else if (right > window.innerWidth - DOCK_SNAP_DISTANCE) {
                mode = "right";
            } else {
                mode = "float";
                x = Math.min(Math.max(left, 8), window.innerWidth - FLOAT_WIDTH - 8);
                y = Math.min(Math.max(top, 8), window.innerHeight - 56);
            }
            const next = { ...current, mode, x, y };
            saveLayout(next);
            return next;
        });
    }

    function submit() {
        const text = draft.trim();
        if (!text || sending) return;
        setDraft("");
        void send(text);
    }

    const docked = layout.mode !== "float";
    const floatStyle = layout.mode === "float" ? { left: layout.x, top: layout.y } : undefined;
    const showBody = !layout.collapsed;

    return (
        <aside
            ref={panelRef}
            className={`director-agent-panel ${docked ? "is-docked" : "is-floating"} ${layout.collapsed ? "is-collapsed" : ""} ${dragging ? "is-dragging" : ""} ${layout.compact ? "is-compact" : ""}`}
            data-dock={docked ? layout.mode : undefined}
            style={{ ...(floatStyle || {}), "--director-agent-glass-alpha": layout.glassAlpha } as React.CSSProperties}
            role="dialog"
            aria-label="AI 助手"
        >
            <header
                className="director-agent-panel-header"
                title="拖动移动 · 靠近屏幕左右边缘自动吸附"
                onPointerDown={onHeaderPointerDown}
                onPointerMove={onHeaderPointerMove}
                onPointerUp={onHeaderPointerUp}
                onPointerCancel={onHeaderPointerUp}
            >
                <span className="director-agent-panel-title">
                    <Bot aria-hidden="true" size={15} className={docked ? "director-agent-panel-dock-hint" : ""} />
                    <span>AI 助手</span>
                </span>
                <button type="button" className="director-agent-panel-icon-button" aria-label={layout.collapsed ? "展开面板" : "折叠面板"} title={layout.collapsed ? "展开" : "折叠"} onClick={() => updateLayout({ collapsed: !layout.collapsed })}>
                    {layout.collapsed ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}
                </button>
                <button type="button" className="director-agent-panel-icon-button" aria-label="切换停靠位置" title={docked ? "拖离边缘切换为自由浮动" : "拖到屏幕边缘吸附停靠"} onClick={() => updateLayout(docked ? { mode: "float", x: Math.max(60, window.innerWidth / 2 - FLOAT_WIDTH / 2), y: 90 } : { mode: "right" })}>
                    <Magnet aria-hidden="true" size={14} className={docked ? "director-agent-panel-dock-hint" : ""} />
                </button>
                <button type="button" className="director-agent-panel-icon-button" aria-label="关闭 AI 助手" title="关闭" onClick={() => setOpen(false)}>
                    <X aria-hidden="true" size={15} />
                </button>
            </header>

            {showBody ? (
                <div className="director-agent-panel-body">
                    <div ref={scrollRef} className="director-agent-panel-messages">
                        {turns.length === 0 ? (
                            <div className="director-agent-panel-hint">
                                让我来帮你摆场景和运镜。试试：
                                <ul>
                                    <li>放两个角色面对面对话，再摆一个箱子</li>
                                    <li>给活动机位加一个环绕运镜</li>
                                    <li>渲染一帧看看现在的构图</li>
                                </ul>
                                对话过程中你只会看到目标进度和最终结论，执行细节可展开「执行过程」查看；模型在下方输入框内切换。
                            </div>
                        ) : (
                            turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
                        )}
                    </div>
                    <div className="director-agent-panel-composer">
                        <textarea
                            ref={textareaRef}
                            className="director-agent-panel-input"
                            placeholder="让 AI 助手帮你操作导演台…"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                    event.preventDefault();
                                    submit();
                                }
                            }}
                        />
                        {showAppearance ? (
                            <div className="director-agent-appearance" role="dialog" aria-label="助手外观设置">
                                <label className="director-agent-appearance-row is-column">
                                    <span>毛玻璃透明度</span>
                                    <input
                                        type="range"
                                        min={30}
                                        max={92}
                                        value={Math.round(layout.glassAlpha * 100)}
                                        onChange={(event) => updateLayout({ glassAlpha: Number(event.target.value) / 100 })}
                                    />
                                </label>
                                <label className="director-agent-appearance-row">
                                    <span>紧凑模式</span>
                                    <input type="checkbox" checked={layout.compact} onChange={(event) => updateLayout({ compact: event.target.checked })} />
                                </label>
                            </div>
                        ) : null}
                        <div className="director-agent-panel-composer-bar">
                            <AgentModelRow />
                            <div className="director-agent-panel-composer-tools">
                                <button
                                    type="button"
                                    className={`director-agent-panel-icon-button${showAppearance ? " is-active" : ""}`}
                                    aria-label="助手外观设置"
                                    title="助手外观设置"
                                    onClick={() => setShowAppearance((value) => !value)}
                                >
                                    <SlidersHorizontal aria-hidden="true" size={14} />
                                </button>
                                <button type="button" className="director-agent-panel-icon-button" aria-label="清空对话" title="清空对话" onClick={clear}>
                                    <Eraser aria-hidden="true" size={14} />
                                </button>
                                <button type="button" className="director-agent-panel-send" aria-label="发送" disabled={sending || !draft.trim()} onClick={submit}>
                                    <ArrowUp aria-hidden="true" size={15} />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
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
