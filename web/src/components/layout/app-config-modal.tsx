/**
 * 模型渠道配置弹窗：蓝黑主题的自绘对话框。
 * 只管渠道：OpenAI 兼容 / Anthropic 原生两种协议、纯文本模型（可勾选视觉能力）、
 * baseUrl 采用带 /v1 的配置方式（buildApiUrl 会自动补 /v1）。无配置导入导出。
 */

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Eye, EyeOff, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

import { buildApiUrl, createModelChannel, decodeChannelModel, modelOptionsFromChannels, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, type AiConfig, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

/** 每个渠道最多配置的模型数量。 */
const MAX_CHANNEL_MODELS = 4;

/** 渠道草稿的模型行（只支持文本模型）。 */
type DraftModel = { name: string };

function toDraftModels(models: ChannelModel[]): DraftModel[] {
    return models.map((model) => ({ name: model.name }));
}

function toChannelModels(models: Array<{ name: string }>): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const model of models) {
        const name = model.name.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        result.push({ name, capability: "text" });
    }
    return result;
}

/** 渠道变更统一入口：同步渠道表、模型清单，并把 textModel 归一到仍存在的选项。 */
function commitChannels(config: AiConfig, channels: ModelChannel[]) {
    const updateConfig = useConfigStore.getState().updateConfig;
    updateConfig("channels", channels);
    updateConfig("models", modelOptionsFromChannels(channels));
    updateConfig("textModel", normalizeModelOptionValue(useConfigStore.getState().config.textModel, channels));
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    return { ...config, channels, models: modelOptionsFromChannels(channels) };
}

/** 拉取渠道的模型列表（OpenAI: GET /v1/models；Anthropic: GET /v1/models）。 */
async function fetchChannelModels(channel: ModelChannel): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (channel.apiFormat === "anthropic") {
        headers["x-api-key"] = channel.apiKey.trim();
        headers["anthropic-version"] = "2023-06-01";
    } else {
        headers.authorization = `Bearer ${channel.apiKey.trim()}`;
    }
    const response = await fetch(buildApiUrl(channel.baseUrl, "/models"), { headers });
    if (!response.ok) throw new Error(`拉取模型列表失败（HTTP ${response.status}）`);
    const payload = (await response.json().catch(() => null)) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> } | null;
    const items = payload?.data || payload?.models || [];
    return items.map((item) => item.id || item.name || "").filter(Boolean);
}

const PROTOCOL_LABEL: Record<string, string> = { openai: "OpenAI 兼容", anthropic: "Anthropic 原生", gemini: "Gemini" };

/** 渠道草稿校验：返回按字段的错误信息，全部通过时为空对象。 */
function validateDraft(draft: ModelChannel): Partial<Record<"baseUrl" | "apiKey" | "models", string>> {
    const errors: Partial<Record<"baseUrl" | "apiKey" | "models", string>> = {};
    if (!draft.baseUrl.trim()) errors.baseUrl = "请填写接口地址";
    else if (!/^https?:\/\//i.test(draft.baseUrl.trim())) errors.baseUrl = "地址需以 http(s):// 开头";
    if (!draft.apiKey.trim()) errors.apiKey = "请填写 API Key";
    if (!draft.models.length) errors.models = "至少需要一个模型";
    return errors;
}

/** 单个渠道的编辑器（草稿态，保存才写回 store）。 */
function ChannelEditor({ draft, isNew, onChange, onSave, onCancel }: { draft: ModelChannel; isNew: boolean; onChange: (patch: Partial<ModelChannel>) => void; onSave: () => void; onCancel: () => void }) {
    const [showKey, setShowKey] = useState(false);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState("");
    const [candidates, setCandidates] = useState<string[] | null>(null);
    const [submitted, setSubmitted] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);

    const errors = validateDraft(draft);
    const showError = (field: "baseUrl" | "apiKey" | "models") => (submitted && errors[field] ? errors[field] : "");
    const selectedNames = new Set(draft.models.map((model) => model.name.trim()));

    // 打开编辑器时聚焦渠道名称，方便直接改名
    useEffect(() => {
        nameRef.current?.select();
    }, []);

    function updateModel(index: number, patch: Partial<DraftModel>) {
        onChange({ models: draft.models.map((model, i) => (i === index ? { ...model, ...patch } : model)) });
    }

    function addModel() {
        if (draft.models.length >= MAX_CHANNEL_MODELS) {
            setFetchError(`一个渠道最多配置 ${MAX_CHANNEL_MODELS} 个模型。`);
            return;
        }
        setFetchError("");
        onChange({ models: [...draft.models, { name: "", capability: "text" }] });
    }

    function removeModel(index: number) {
        setFetchError("");
        onChange({ models: draft.models.filter((_, i) => i !== index) });
    }

    /** 勾选/取消候选模型；取消直接移除，勾选受 4 个上限约束。 */
    function toggleCandidate(name: string) {
        if (selectedNames.has(name)) {
            onChange({ models: draft.models.filter((model) => model.name.trim() !== name) });
            return;
        }
        if (draft.models.length >= MAX_CHANNEL_MODELS) {
            setFetchError(`一个渠道最多配置 ${MAX_CHANNEL_MODELS} 个模型，请先取消一个再选择。`);
            return;
        }
        setFetchError("");
        onChange({ models: [...draft.models, { name, capability: "text" }] });
    }

    async function pullModels() {
        if (!draft.baseUrl.trim() || !draft.apiKey.trim()) {
            setFetchError("拉取前请先填写接口地址与 API Key。");
            return;
        }
        setFetching(true);
        setFetchError("");
        try {
            const names = await fetchChannelModels(draft);
            if (!names.length) {
                setFetchError("接口没有返回任何模型");
                setCandidates(null);
            } else {
                setCandidates(names);
            }
        } catch (error) {
            setFetchError(error instanceof Error ? error.message : String(error));
        } finally {
            setFetching(false);
        }
    }

    function save() {
        setSubmitted(true);
        if (Object.keys(errors).length) return;
        onSave();
    }

    return (
        <div className="dcfg-editor">
            <div className="dcfg-editor-intro">
                <button type="button" className="dcfg-back-button" aria-label="返回渠道列表" onClick={onCancel}>
                    <ArrowLeft aria-hidden="true" size={14} />
                    返回
                </button>
                <span className="dcfg-editor-intro-text">{isNew ? "填写接口信息，模型可稍后在列表中调整。" : `正在编辑「${draft.name || "未命名渠道"}」`}</span>
            </div>

            <div className="dcfg-field-grid">
                <label className="dcfg-field">
                    <span>渠道名称</span>
                    <input ref={nameRef} className="dcfg-input" value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="例如 Agnes / 官方直连" />
                </label>
                <div className="dcfg-field">
                    <span>协议</span>
                    <div className="dcfg-segmented" role="radiogroup" aria-label="协议">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={draft.apiFormat === "openai"}
                            className={`dcfg-segmented-item${draft.apiFormat === "openai" ? " is-active" : ""}`}
                            onClick={() => onChange({ apiFormat: "openai" })}
                        >
                            OpenAI 兼容
                        </button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={draft.apiFormat === "anthropic"}
                            className={`dcfg-segmented-item${draft.apiFormat === "anthropic" ? " is-active" : ""}`}
                            onClick={() => onChange({ apiFormat: "anthropic" })}
                        >
                            Anthropic 原生
                        </button>
                    </div>
                </div>
            </div>
            <label className="dcfg-field">
                <span>
                    接口地址 <em className="dcfg-field-hint">以 /v1 结尾，未写时自动补全</em>
                </span>
                <input
                    className={`dcfg-input dcfg-input-mono${showError("baseUrl") ? " is-invalid" : ""}`}
                    value={draft.baseUrl}
                    onChange={(event) => onChange({ baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                />
                {showError("baseUrl") ? <span className="dcfg-field-error">{showError("baseUrl")}</span> : null}
            </label>
            <label className="dcfg-field">
                <span>API Key</span>
                <div className={`dcfg-key-row${showError("apiKey") ? " is-invalid" : ""}`}>
                    <input
                        className="dcfg-input dcfg-input-mono"
                        type={showKey ? "text" : "password"}
                        autoComplete="off"
                        value={draft.apiKey}
                        onChange={(event) => onChange({ apiKey: event.target.value })}
                        placeholder="sk-…"
                    />
                    <button type="button" className="dcfg-key-eye" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((value) => !value)}>
                        {showKey ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
                    </button>
                </div>
                {showError("apiKey") ? <span className="dcfg-field-error">{showError("apiKey")}</span> : null}
            </label>

            <div className="dcfg-models">
                <div className="dcfg-models-head">
                    <div>
                        <div className="dcfg-models-title">
                            渠道模型
                            <span className="dcfg-models-count">
                                {draft.models.length}/{MAX_CHANNEL_MODELS}
                            </span>
                        </div>
                        <div className="dcfg-models-sub">只支持文本模型。先「从接口拉取」候选列表，再勾选要使用的模型。</div>
                    </div>
                    <div className="dcfg-models-actions">
                        <button type="button" className="dcfg-secondary-button" onClick={addModel}>
                            <Plus aria-hidden="true" size={13} /> 手动添加
                        </button>
                        <button type="button" className="dcfg-secondary-button" onClick={() => void pullModels()} disabled={fetching}>
                            {fetching ? <Loader2 aria-hidden="true" size={13} className="dcfg-spin" /> : <Download aria-hidden="true" size={13} />} 从接口拉取
                        </button>
                    </div>
                </div>
                {fetchError ? <div className="dcfg-fetch-error">{fetchError}</div> : null}
                {candidates ? (
                    <div className="dcfg-candidates">
                        <div className="dcfg-candidates-head">接口返回 {candidates.length} 个模型，勾选加入渠道</div>
                        <div className="dcfg-candidate-list">
                            {candidates.map((name) => {
                                const selected = selectedNames.has(name);
                                const full = !selected && draft.models.length >= MAX_CHANNEL_MODELS;
                                return (
                                    <button
                                        key={name}
                                        type="button"
                                        className={`dcfg-candidate${selected ? " is-selected" : ""}${full ? " is-full" : ""}`}
                                        aria-pressed={selected}
                                        onClick={() => toggleCandidate(name)}
                                    >
                                        <span className={`dcfg-candidate-check${selected ? " is-on" : ""}`} aria-hidden="true" />
                                        <span className="dcfg-candidate-name">{name}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ) : null}
                {draft.models.length === 0 ? (
                    <div className="dcfg-models-empty">
                        还没有选择模型。推荐「从接口拉取」后勾选，也可以手动添加。
                        {showError("models") ? <span className="dcfg-field-error">{showError("models")}</span> : null}
                    </div>
                ) : (
                    <div className="dcfg-model-list">
                        {draft.models.map((model, index) => (
                            <div key={index} className="dcfg-model-row">
                                <input className="dcfg-input dcfg-model-name" value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder="模型 ID，例如 claude-sonnet-4-5" />
                                <button type="button" className="dcfg-icon-button is-danger" aria-label={`移除模型 ${model.name || ""}`} onClick={() => removeModel(index)}>
                                    <Trash2 aria-hidden="true" size={13} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="dcfg-editor-footer">
                <button type="button" className="dcfg-secondary-button" onClick={onCancel}>
                    取消
                </button>
                <button type="button" className="dcfg-primary-button" onClick={save}>
                    {isNew ? "创建渠道" : "保存修改"}
                </button>
            </div>
        </div>
    );
}

/** 渠道列表中的一张卡片；删除需要二次确认。 */
function ChannelCard({ channel, isAgentChannel, canDelete, onEdit, onDelete }: { channel: ModelChannel; isAgentChannel: boolean; canDelete: boolean; onEdit: () => void; onDelete: () => void }) {
    const [confirming, setConfirming] = useState(false);

    // 进入确认态后 3 秒未操作自动退出，避免停留在危险状态
    useEffect(() => {
        if (!confirming) return;
        const timer = window.setTimeout(() => setConfirming(false), 3000);
        return () => window.clearTimeout(timer);
    }, [confirming]);

    return (
        <div className={`dcfg-channel-card${isAgentChannel ? " is-active" : ""}`}>
            <div className="dcfg-channel-info">
                <div className="dcfg-channel-name">
                    {channel.name || "未命名渠道"}
                    {isAgentChannel ? <span className="dcfg-channel-badge">Agent 使用中</span> : null}
                </div>
                <div className="dcfg-channel-meta">
                    <span className="dcfg-channel-protocol">{PROTOCOL_LABEL[channel.apiFormat] || channel.apiFormat}</span>
                    <span className="dcfg-channel-dot" aria-hidden="true" />
                    <span>
                        {channel.models.length} 个模型
                    </span>
                </div>
                <div className="dcfg-channel-url">{channel.baseUrl || "未配置地址"}</div>
            </div>
            <div className="dcfg-channel-actions">
                {confirming ? (
                    <>
                        <span className="dcfg-channel-confirm-text">确认删除？</span>
                        <button type="button" className="dcfg-danger-button" disabled={!canDelete} onClick={() => { setConfirming(false); onDelete(); }}>
                            删除
                        </button>
                        <button type="button" className="dcfg-secondary-button" onClick={() => setConfirming(false)}>
                            取消
                        </button>
                    </>
                ) : (
                    <>
                        <button type="button" className="dcfg-secondary-button" onClick={onEdit}>
                            <Pencil aria-hidden="true" size={12} /> 编辑
                        </button>
                        <button
                            type="button"
                            className="dcfg-icon-button is-danger"
                            aria-label={`删除渠道 ${channel.name || ""}`}
                            disabled={!canDelete}
                            title={canDelete ? "删除渠道" : "至少保留一个渠道"}
                            onClick={() => setConfirming(true)}
                        >
                            <Trash2 aria-hidden="true" size={13} />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

/** 模型渠道配置弹窗（蓝黑主题自绘）。 */
export function AppConfigModal() {
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [editing, setEditing] = useState<{ draft: ModelChannel; isNew: boolean } | null>(null);
    const [error, setError] = useState("");

    if (!isConfigOpen) return null;

    function close() {
        setEditing(null);
        setError("");
        setConfigDialogOpen(false);
    }

    function startEdit(channel: ModelChannel) {
        setError("");
        setEditing({ draft: createModelChannel({ ...channel, models: channel.models.map((model) => ({ ...model })) }), isNew: false });
    }

    function startAdd() {
        setError("");
        setEditing({ draft: createModelChannel({ name: `渠道 ${config.channels.length + 1}` }), isNew: true });
    }

    function saveDraft() {
        if (!editing) return;
        const draft = editing.draft;
        const channels = [...config.channels];
        const exists = channels.some((channel) => channel.id === draft.id);
        // 写回前截断到上限，防御旧数据或绕过 UI 的路径
        const capped = { ...draft, models: toChannelModels(draft.models).slice(0, MAX_CHANNEL_MODELS) };
        if (exists) {
            const index = channels.findIndex((channel) => channel.id === draft.id);
            channels[index] = capped;
        } else {
            channels.push(capped);
        }
        commitChannels(withChannels(config, channels), channels);
        setEditing(null);
        setError("");
    }

    function deleteChannel(id: string) {
        if (config.channels.length <= 1) {
            setError("至少保留一个渠道。");
            return;
        }
        const channels = config.channels.filter((channel) => channel.id !== id);
        commitChannels(withChannels(config, channels), channels);
    }

    return (
        <div className="dcfg-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}>
            <div className="dcfg-modal" role="dialog" aria-label="模型渠道配置">
                <header className="dcfg-header">
                    <div>
                        <h3 className="dcfg-title">{editing ? (editing.isNew ? "新增渠道" : "编辑渠道") : "模型渠道配置"}</h3>
                        <p className="dcfg-subtitle">{editing ? "密钥只保存在本机浏览器中，不会上传。" : "配置 Agent 使用的模型渠道 · 本地存储，密钥不出本机"}</p>
                    </div>
                    <button type="button" className="dcfg-icon-button" aria-label="关闭" onClick={close}>
                        <X aria-hidden="true" size={16} />
                    </button>
                </header>

                <div className="dcfg-body">
                    {editing ? (
                        <ChannelEditor
                            draft={editing.draft}
                            isNew={editing.isNew}
                            onChange={(patch) => setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))}
                            onSave={saveDraft}
                            onCancel={() => setEditing(null)}
                        />
                    ) : (
                        <>
                            <div className="dcfg-list-head">
                                <span className="dcfg-list-hint">
                                    共 {config.channels.length} 个渠道，Agent 当前使用「
                                    {config.channels.find((channel) => decodeChannelModel(config.textModel)?.channelId === channel.id)?.name || "未选择"}」
                                </span>
                                <button type="button" className="dcfg-primary-button" onClick={startAdd}>
                                    <Plus aria-hidden="true" size={13} /> 新增渠道
                                </button>
                            </div>
                            {error ? <div className="dcfg-fetch-error">{error}</div> : null}
                            <div className="dcfg-channel-list">
                                {config.channels.map((channel) => {
                                    const isAgentChannel = decodeChannelModel(config.textModel)?.channelId === channel.id;
                                    return (
                                        <ChannelCard key={channel.id} channel={channel} isAgentChannel={isAgentChannel} canDelete={config.channels.length > 1} onEdit={() => startEdit(channel)} onDelete={() => deleteChannel(channel.id)} />
                                    );
                                })}
                            </div>
                            <p className="dcfg-note">接口地址采用带 /v1 的配置方式（例如 https://api.example.com/v1），未写 /v1 时会自动补全。</p>
                        </>
                    )}
                </div>

                {!editing ? (
                    <footer className="dcfg-footer">
                        <button type="button" className="dcfg-secondary-button" onClick={close}>
                            完成
                        </button>
                    </footer>
                ) : null}
            </div>
        </div>
    );
}

/** 供外部同步默认模型选择。 */
export function pickDefaultModel(config: AiConfig, capability: Parameters<typeof selectableModelsByCapability>[1], current: string) {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}
