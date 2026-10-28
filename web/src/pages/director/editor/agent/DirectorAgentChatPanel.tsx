import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Eraser, ImagePlus, Magnet, SlidersHorizontal, X, XCircle } from "lucide-react";

import { encodeChannelModel, useConfigStore, type ModelChannel } from "@/stores/use-config-store";

import { useDirectorAgentChat, type AgentStep, type AgentTurn } from "./useDirectorAgentChat";

/** 面板布局：停靠（左/右，磁性吸附）或自由浮动；位置、宽度与外观持久化；悬浮态宽高可自由调整。 */
type PanelLayout = { mode: "left" | "right" | "float"; x: number; y: number; collapsed: boolean; glassAlpha: number; width: number; floatW: number; floatH: number };

const LAYOUT_STORAGE_KEY = "director-agent-panel-layout-v1";
const DOCK_SNAP_DISTANCE = 16;
const FLOAT_WIDTH = 344;
const FLOAT_MIN_W = 320;
const FLOAT_MIN_H = 360;
const DOCK_MIN_WIDTH = 280;
const DOCK_MAX_WIDTH = 640;

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
                    glassAlpha: typeof parsed.glassAlpha === "number" ? Math.min(1, Math.max(0.2, parsed.glassAlpha)) : 0.68,
                    width: Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Number(parsed.width) || 380)),
                    // 悬浮态自由尺寸：夹取回当前视口，避免历史值落在屏幕外。
                    floatW: Math.min(Math.max(FLOAT_MIN_W, Number(parsed.floatW) || FLOAT_WIDTH), Math.max(FLOAT_MIN_W, window.innerWidth - 16)),
                    floatH: Math.min(Math.max(FLOAT_MIN_H, Number(parsed.floatH) || Math.min(window.innerHeight * 0.72, 680)), Math.max(FLOAT_MIN_H, window.innerHeight - 16)),
                };
            }
        }
    } catch {
        // 布局损坏时用默认值
    }
    return { mode: "right", x: 0, y: 0, collapsed: false, glassAlpha: 0.68, width: 380, floatW: FLOAT_WIDTH, floatH: Math.min(window.innerHeight * 0.72, 680) };
}

function saveLayout(layout: PanelLayout) {
    try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
        // 存储不可用时忽略
    }
}

/** 渲染一步幕后执行记录。 */function StepItem({ step }: { step: AgentStep }) {
    if (step.kind === "narration") {
        return <div className="director-agent-process-narration">{step.text}</div>;
    }
    if (step.kind === "tool") {
        return <ToolChip name={step.name} summary={step.summary} failed={!step.ok} />;
    }
    return <div className="director-agent-process-narration is-note">{step.text}</div>;
}

/** 渲染一行工具执行记录：状态卡片（对勾/叉 + 工具名 + 完成状态），点击展开结果摘要。 */
function ToolChip({ name, summary, failed }: { name?: string; summary?: string; failed?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    if (!name) return null;
    return (
        <div className={`director-agent-panel-tool${failed ? " is-error" : ""}${expanded ? " is-expanded" : ""}`}>
            <button type="button" className="director-agent-tool-row" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
                {failed ? <XCircle aria-hidden="true" size={15} className="director-agent-tool-icon" /> : <CheckCircle2 aria-hidden="true" size={15} className="director-agent-tool-icon" />}
                <span className="director-agent-tool-label">
                    调用工具：<strong>{name}</strong>
                </span>
                <span className={`director-agent-tool-status${failed ? " is-failed" : ""}`}>{failed ? "失败" : "已完成"}</span>
            </button>
            {expanded && summary ? <div className="director-agent-tool-summary">{summary}</div> : null}
        </div>
    );
}

/** 结论文本渲染：**加粗** 转为粗体、去掉反引号，其余原样保留。 */
function ConclusionText({ text }: { text: string }) {
    const cleaned = text.replace(/`([^`]+)`/g, "$1");
    const parts = cleaned.split(/\*\*(.+?)\*\*/g);
    return (
        <>
            {parts.map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : <span key={index}>{part}</span>))}
        </>
    );
}

/** 单条消息最多附带的图片数量与单文件大小上限。 */
const ATTACHMENT_LIMIT = 4;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** 结论兜底清洗：模型偶尔仍输出的 markdown 修饰符（`代码`）转成纯文本；加粗交给 ConclusionText 渲染。 */

/**
 * 一轮任务的展示（按时间顺序）：用户气泡 → 进度/执行步骤（运行中实时展开）→ 最终结论。
 * 运行中步骤始终展开，用户能看到正在做什么；结束后收进「执行过程」折叠区，结论保持在最后。
 */
function TurnView({ turn }: { turn: AgentTurn }) {
    const [expanded, setExpanded] = useState(false);
    const toolCount = turn.steps.filter((step) => step.kind === "tool").length;
    const running = turn.status === "running";
    const showSteps = running || expanded;

    return (
        <>
            <div className="director-agent-panel-bubble is-user">
                {turn.images.length ? (
                    <div className="director-agent-bubble-images">
                        {turn.images.map((url, index) => (
                            <img key={index} src={url} alt={`附件 ${index + 1}`} className="director-agent-bubble-image" />
                        ))}
                    </div>
                ) : null}
                {turn.goal}
            </div>

            {running ? (
                <div className="director-agent-progress" role="status">
                    <span className="director-agent-progress-spinner" aria-hidden="true" />
                    <div className="director-agent-progress-main">
                        <div className="director-agent-progress-text">{turn.progressText || "处理中…"}</div>
                        {toolCount > 0 ? <div className="director-agent-progress-meta">已执行 {toolCount} 步</div> : null}
                    </div>
                </div>
            ) : null}

            {turn.steps.length > 0 ? (
                <div className="director-agent-process">
                    <button
                        type="button"
                        className="director-agent-process-toggle"
                        onClick={() => !running && setExpanded((value) => !value)}
                        aria-expanded={showSteps}
                        disabled={running}
                    >
                        <ChevronRight aria-hidden="true" size={12} className={showSteps ? "is-open" : ""} />
                        {running ? "正在执行" : "执行过程"} · {turn.steps.length} 步{toolCount ? `（工具 ${toolCount}）` : ""}
                    </button>
                    {showSteps ? (
                        <div className="director-agent-process-body">
                            {turn.steps.map((step) => (
                                <StepItem key={step.id} step={step} />
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {turn.previews.length ? (
                <div className="director-agent-previews">
                    {turn.previews.map((url, index) => (
                        <figure key={index} className="director-agent-preview">
                            <img src={url} alt={`预览截图 ${index + 1}`} onClick={() => window.open(url)} />
                            <figcaption>预览截图 · 点击放大</figcaption>
                        </figure>
                    ))}
                </div>
            ) : null}

            {turn.status === "done" && turn.conclusion ? (
                <div className="director-agent-panel-bubble is-assistant director-agent-conclusion">
                    <ConclusionText text={turn.conclusion} />
                </div>
            ) : null}

            {turn.status === "failed" ? (
                <div className="director-agent-panel-bubble is-error">{turn.error || "任务执行失败。"}</div>
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
    const [attachments, setAttachments] = useState<string[]>([]);
    const [attachError, setAttachError] = useState("");
    const [showAppearance, setShowAppearance] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const appearanceRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
    const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
    const floatResizeRef = useRef<{ pointerId: number; startX: number; startY: number; w: number; h: number } | null>(null);
    const panelRef = useRef<HTMLElement>(null);

    // 外观设置：点到弹层与触发按钮以外的地方自动收回（Esc 同样）
    useEffect(() => {
        if (!showAppearance) return;
        function onPointerDown(event: PointerEvent) {
            const target = event.target as Node;
            if (appearanceRef.current?.contains(target)) return;
            if (target instanceof HTMLElement && target.closest('[aria-label="助手外观设置"]')) return;
            setShowAppearance(false);
        }
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") setShowAppearance(false);
        }
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [showAppearance]);

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
        // 面板高度是持久化的 floatH，钳制位置使整个面板落在视口内
        const x = Math.min(Math.max(current.x, 8), Math.max(8, window.innerWidth - current.floatW - 8));
        const y = Math.min(Math.max(current.y, 8), Math.max(8, window.innerHeight - current.floatH - 8));
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
            const right = left + current.floatW;
            let mode: PanelLayout["mode"];
            let x = 0;
            let y = 0;
            if (left < DOCK_SNAP_DISTANCE) {
                mode = "left";
            } else if (right > window.innerWidth - DOCK_SNAP_DISTANCE) {
                mode = "right";
            } else {
                mode = "float";
                x = Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - current.floatW - 8));
                y = Math.min(Math.max(top, 8), Math.max(8, window.innerHeight - current.floatH - 8));
            }
            const next = { ...current, mode, x, y };
            saveLayout(next);
            return next;
        });
    }

    // 悬浮态右下角自由调宽高（取自无限画布面板）：夹取在视口内
    function onFloatResizePointerDown(event: React.PointerEvent) {
        if (event.button !== 0) return;
        event.preventDefault();
        floatResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, w: layout.floatW, h: layout.floatH };
        try {
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        } catch {
            // 捕获不可用时仍能拖动
        }
    }

    function onFloatResizePointerMove(event: React.PointerEvent) {
        const resize = floatResizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        const width = Math.min(window.innerWidth - layout.x - 8, Math.max(FLOAT_MIN_W, resize.w + event.clientX - resize.startX));
        const height = Math.min(window.innerHeight - layout.y - 8, Math.max(FLOAT_MIN_H, resize.h + event.clientY - resize.startY));
        updateLayout({ floatW: Math.max(FLOAT_MIN_W, width), floatH: Math.max(FLOAT_MIN_H, height) });
    }

    function onFloatResizePointerUp(event: React.PointerEvent) {
        if (floatResizeRef.current?.pointerId !== event.pointerId) return;
        floatResizeRef.current = null;
    }

    // 停靠宽度拖动：右侧停靠时向左拖变宽，左侧停靠时向右拖变宽
    function onResizePointerDown(event: React.PointerEvent) {
        if (event.button !== 0) return;
        resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: layout.width };
        try {
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        } catch {
            // 捕获不可用时仍能拖动
        }
    }

    function onResizePointerMove(event: React.PointerEvent) {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        const delta = layout.mode === "right" ? resize.startX - event.clientX : event.clientX - resize.startX;
        const width = Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, resize.startWidth + delta));
        updateLayout({ width });
    }

    function onResizePointerUp(event: React.PointerEvent) {
        if (resizeRef.current?.pointerId !== event.pointerId) return;
        resizeRef.current = null;
    }

    // 选择本地图片并转为 data URL 附件（最多 4 张，单张 ≤10MB）
    function onPickImages(event: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (!files.length) return;
        setAttachError("");
        const room = ATTACHMENT_LIMIT - attachments.length;
        if (room <= 0) {
            setAttachError(`最多附带 ${ATTACHMENT_LIMIT} 张图片。`);
            return;
        }
        const accepted = files.slice(0, room);
        if (files.length > room) setAttachError(`最多附带 ${ATTACHMENT_LIMIT} 张图片，已忽略多余的 ${files.length - room} 张。`);
        for (const file of accepted) {
            if (!file.type.startsWith("image/")) {
                setAttachError(`「${file.name}」不是图片文件。`);
                continue;
            }
            if (file.size > ATTACHMENT_MAX_BYTES) {
                setAttachError(`「${file.name}」超过 10MB，已跳过。`);
                continue;
            }
            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result === "string") setAttachments((current) => (current.length >= ATTACHMENT_LIMIT ? current : [...current, reader.result as string]));
            };
            reader.readAsDataURL(file);
        }
    }

    function submit() {
        const text = draft.trim();
        if ((!text && !attachments.length) || sending) return;
        const images = attachments;
        setDraft("");
        setAttachments([]);
        setAttachError("");
        void send(text, images);
    }

    const docked = layout.mode !== "float";
    const floatStyle = layout.mode === "float" ? { left: layout.x, top: layout.y, width: layout.floatW, height: layout.collapsed ? undefined : layout.floatH } : undefined;
    const showBody = !layout.collapsed;

    return (
        <aside
            ref={panelRef}
            className={`director-agent-panel ${docked ? "is-docked" : "is-floating"} ${layout.collapsed ? "is-collapsed" : ""} ${dragging ? "is-dragging" : ""}`}
            data-dock={docked ? layout.mode : undefined}
            style={{ ...(floatStyle || {}), ...(docked ? { width: layout.width } : {}), "--director-agent-glass-alpha": layout.glassAlpha } as React.CSSProperties}
            role="dialog"
            aria-label="AI 助手"
        >
            <header
                className="director-agent-panel-header"
                onPointerDown={onHeaderPointerDown}
                onPointerMove={onHeaderPointerMove}
                onPointerUp={onHeaderPointerUp}
                onPointerCancel={onHeaderPointerUp}
            >
                <span className="director-agent-panel-title">
                    <Bot aria-hidden="true" size={15} className={docked ? "director-agent-panel-dock-hint" : ""} />
                    <span>AI 助手</span>
                </span>
                <button type="button" className="director-agent-panel-icon-button" aria-label={layout.collapsed ? "展开面板" : "折叠面板"} data-tip={layout.collapsed ? "展开" : "折叠"} onClick={() => updateLayout({ collapsed: !layout.collapsed })}>
                    {layout.collapsed ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}
                </button>
                <button type="button" className="director-agent-panel-icon-button" aria-label="切换停靠位置" data-tip={docked ? "取消吸附" : "吸附"} onClick={() => updateLayout(docked ? { mode: "float", x: Math.max(60, window.innerWidth / 2 - FLOAT_WIDTH / 2), y: 90 } : { mode: "right" })}>
                    <Magnet aria-hidden="true" size={14} className={docked ? "director-agent-panel-dock-hint" : ""} />
                </button>
                <button type="button" className="director-agent-panel-icon-button" aria-label="关闭 AI 助手" data-tip="关闭" onClick={() => setOpen(false)}>
                    <X aria-hidden="true" size={15} />
                </button>
            </header>

            {showBody ? (
                <div className="director-agent-panel-body">
                    {docked ? (
                        <div
                            className="director-agent-panel-resize"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="拖动调整面板宽度"
                            data-tip="拖动调整宽度"
                            onPointerDown={onResizePointerDown}
                            onPointerMove={onResizePointerMove}
                            onPointerUp={onResizePointerUp}
                            onPointerCancel={onResizePointerUp}
                        />
                    ) : (
                        <span
                            className="director-agent-panel-float-resize"
                            role="separator"
                            aria-label="拖动调整面板大小"
                            data-tip="拖动调整大小"
                            onPointerDown={onFloatResizePointerDown}
                            onPointerMove={onFloatResizePointerMove}
                            onPointerUp={onFloatResizePointerUp}
                            onPointerCancel={onFloatResizePointerUp}
                        >
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 6 6 14M14 11l-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                        </span>
                    )}
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
                        {attachments.length ? (
                            <div className="director-agent-attachments">
                                {attachments.map((url, index) => (
                                    <span key={index} className="director-agent-attachment">
                                        <img src={url} alt={`附件 ${index + 1}`} />
                                        <button type="button" className="director-agent-attachment-remove" aria-label={`移除附件 ${index + 1}`} onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}>
                                            <X aria-hidden="true" size={11} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : null}
                        {attachError ? <div className="director-agent-attach-error">{attachError}</div> : null}
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
                        <div className="director-agent-panel-composer-bar">
                            <AgentModelRow />
                            <div className="director-agent-panel-composer-tools">
                                {showAppearance ? (
                                    <div ref={appearanceRef} className="director-agent-appearance" role="dialog" aria-label="助手外观设置">
                                        <div className="director-agent-appearance-block">
                                            <div className="director-agent-appearance-label">
                                                毛玻璃透明度
                                                <span className="director-agent-appearance-value">{Math.round(layout.glassAlpha * 100)}%</span>
                                            </div>
                                            <input
                                                type="range"
                                                min={20}
                                                max={100}
                                                value={Math.round(layout.glassAlpha * 100)}
                                                onChange={(event) => updateLayout({ glassAlpha: Number(event.target.value) / 100 })}
                                            />
                                        </div>
                                    </div>
                                ) : null}
                                <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onPickImages} />
                                <button
                                    type="button"
                                    className="director-agent-panel-icon-button"
                                    aria-label="上传图片"
                                    data-tip={attachments.length >= ATTACHMENT_LIMIT ? `最多 ${ATTACHMENT_LIMIT} 张图片` : "上传图片"}
                                    disabled={attachments.length >= ATTACHMENT_LIMIT || sending}
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <ImagePlus aria-hidden="true" size={14} />
                                </button>
                                <button
                                    type="button"
                                    className={`director-agent-panel-icon-button${showAppearance ? " is-active" : ""}`}
                                    aria-label="助手外观设置"
                                    data-tip="助手外观设置"
                                    onClick={() => setShowAppearance((value) => !value)}
                                >
                                    <SlidersHorizontal aria-hidden="true" size={14} />
                                </button>
                                <button type="button" className="director-agent-panel-icon-button" aria-label="清空对话" data-tip={turns.length ? "清空对话" : "暂无对话"} disabled={!turns.length && !sending} onClick={clear}>
                                    <Eraser aria-hidden="true" size={14} />
                                </button>
                                <button type="button" className="director-agent-panel-send" aria-label="发送" disabled={sending || (!draft.trim() && !attachments.length)} onClick={submit}>
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
