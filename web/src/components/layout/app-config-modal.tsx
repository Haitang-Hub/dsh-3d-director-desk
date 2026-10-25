/**
 * 模型渠道配置弹窗：蓝黑主题的自绘对话框。
 * 只管渠道：OpenAI 兼容 / Anthropic 原生两种协议、纯文本模型（可勾选视觉能力）、
 * baseUrl 采用带 /v1 的配置方式（buildApiUrl 会自动补 /v1）。无配置导入导出。
 */

import { useState } from "react";
import { Download, Eye, EyeOff, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

import { buildApiUrl, createModelChannel, decodeChannelModel, modelOptionsFromChannels, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, type AiConfig, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

/** 渠道草稿的模型行：文本模型 + 视觉能力勾选。 */
type DraftModel = { name: string; vision: boolean };

function toDraftModels(models: ChannelModel[]): DraftModel[] {
    return models.map((model) => ({ name: model.name, vision: Boolean(model.vision) }));
}

function toChannelModels(models: Array<{ name: string; vision?: boolean }>): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const model of models) {
        const name = model.name.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        result.push({ name, capability: "text", ...(model.vision ? { vision: true } : {}) });
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

/** 单个渠道的编辑器（草稿态，保存才写回 store）。 */
function ChannelEditor({ draft, isNew, onChange, onSave, onCancel }: { draft: ModelChannel; isNew: boolean; onChange: (patch: Partial<ModelChannel>) => void; onSave: () => void; onCancel: () => void }) {
    const [showKey, setShowKey] = useState(false);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState("");

    function updateModel(index: number, patch: Partial<DraftModel>) {
        onChange({ models: toChannelModels(draft.models.map((model, i) => (i === index ? { ...model, ...patch } : model))) });
    }

    function addModel() {
        onChange({ models: toChannelModels([...draft.models, { name: "", vision: false }]) });
    }

    function removeModel(index: number) {
        onChange({ models: toChannelModels(draft.models.filter((_, i) => i !== index)) });
    }

    async function pullModels() {
        setFetching(true);
        setFetchError("");
        try {
            const names = await fetchChannelModels(draft);
            const existing = new Set(draft.models.map((model) => model.name.trim()));
            const merged = [...draft.models, ...names.filter((name) => !existing.has(name)).map((name) => ({ name, vision: false }))];
            onChange({ models: toChannelModels(merged) });
            if (!names.length) setFetchError("接口没有返回任何模型");
        } catch (error) {
            setFetchError(error instanceof Error ? error.message : String(error));
        } finally {
            setFetching(false);
        }
    }

    return (
        <div className="dcfg-editor">
            <div className="dcfg-field-grid">
                <label className="dcfg-field">
                    <span>渠道名称</span>
                    <input className="dcfg-input" value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="例如 Agnes / 官方直连" />
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
                <span>接口地址（以 /v1 结尾）</span>
                <input className="dcfg-input dcfg-input-mono" value={draft.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
            </label>
            <label className="dcfg-field">
                <span>API Key</span>
                <div className="dcfg-key-row">
                    <input
                        className="dcfg-input dcfg-input-mono"
                        type={showKey ? "text" : "password"}
                        autoComplete="off"
                        value={draft.apiKey}
                        onChange={(event) => onChange({ apiKey: event.target.value })}
                        placeholder="sk-…"
                    />
                    <button type="button" className="dcfg-icon-button" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((value) => !value)}>
                        {showKey ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
                    </button>
                </div>
            </label>

            <div className="dcfg-models">
                <div className="dcfg-models-head">
                    <div>
                        <div className="dcfg-models-title">渠道模型</div>
                        <div className="dcfg-models-sub">只用文本模型；具备读图能力的模型勾选「视觉」。</div>
                    </div>
                    <div className="dcfg-models-actions">
                        <button type="button" className="dcfg-secondary-button" onClick={addModel}>
                            <Plus aria-hidden="true" size={13} /> 添加模型
                        </button>
                        <button type="button" className="dcfg-secondary-button" onClick={() => void pullModels()} disabled={fetching}>
                            {fetching ? <Loader2 aria-hidden="true" size={13} className="dcfg-spin" /> : <Download aria-hidden="true" size={13} />} 拉取模型
                        </button>
                    </div>
                </div>
                {fetchError ? <div className="dcfg-fetch-error">{fetchError}</div> : null}
                {draft.models.length === 0 ? (
                    <div className="dcfg-models-empty">还没有模型：手动添加，或点「拉取模型」从接口获取。</div>
                ) : (
                    <div className="dcfg-model-list">
                        {draft.models.map((model, index) => (
                            <div key={index} className="dcfg-model-row">
                                <input className="dcfg-input dcfg-model-name" value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder="模型 ID，例如 claude-sonnet-4-5" />
                                <label className="dcfg-vision-toggle" title="该模型是否具备视觉（读图）能力">
                                    <input type="checkbox" checked={model.vision} onChange={(event) => updateModel(index, { vision: event.target.checked })} />
                                    视觉
                                </label>
                                <button type="button" className="dcfg-icon-button is-danger" aria-label={`删除模型 ${model.name || ""}`} onClick={() => removeModel(index)}>
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
                <button type="button" className="dcfg-primary-button" onClick={onSave}>
                    {isNew ? "创建渠道" : "保存"}
                </button>
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
        if (!draft.baseUrl.trim() || !draft.apiKey.trim()) {
            setError("接口地址与 API Key 不能为空。");
            return;
        }
        if (!draft.models.length) {
            setError("至少添加一个模型（可手动添加或点「拉取模型」）。");
            return;
        }
        const exists = config.channels.some((channel) => channel.id === draft.id);
        const channels = exists ? config.channels.map((channel) => (channel.id === draft.id ? draft : channel)) : [...config.channels, draft];
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
                        <h3 className="dcfg-title">模型渠道配置</h3>
                        <p className="dcfg-subtitle">配置 Agent 使用的模型渠道 · 本地存储，密钥不出本机</p>
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
                                <span className="dcfg-list-hint">{config.channels.length} 个渠道</span>
                                <button type="button" className="dcfg-primary-button" onClick={startAdd}>
                                    <Plus aria-hidden="true" size={13} /> 新增渠道
                                </button>
                            </div>
                            {error ? <div className="dcfg-fetch-error">{error}</div> : null}
                            <div className="dcfg-channel-list">
                                {config.channels.map((channel) => {
                                    const isAgentChannel = decodeChannelModel(config.textModel)?.channelId === channel.id;
                                    return (
                                        <div key={channel.id} className={`dcfg-channel-card${isAgentChannel ? " is-active" : ""}`}>
                                            <div className="dcfg-channel-info">
                                                <div className="dcfg-channel-name">
                                                    {channel.name || "未命名渠道"}
                                                    {isAgentChannel ? <span className="dcfg-channel-badge">Agent 使用中</span> : null}
                                                </div>
                                                <div className="dcfg-channel-meta">
                                                    {PROTOCOL_LABEL[channel.apiFormat] || channel.apiFormat} · {channel.models.length} 个模型 · {channel.baseUrl || "未配置地址"}
                                                </div>
                                            </div>
                                            <div className="dcfg-channel-actions">
                                                <button type="button" className="dcfg-secondary-button" onClick={() => startEdit(channel)}>
                                                    <Pencil aria-hidden="true" size={12} /> 编辑
                                                </button>
                                                <button
                                                    type="button"
                                                    className="dcfg-icon-button is-danger"
                                                    aria-label={`删除渠道 ${channel.name || ""}`}
                                                    disabled={config.channels.length <= 1}
                                                    onClick={() => deleteChannel(channel.id)}
                                                >
                                                    <Trash2 aria-hidden="true" size={13} />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <p className="dcfg-note">接口地址采用带 /v1 的配置方式（例如 https://api.example.com/v1），未写 /v1 时会自动补全。</p>
                        </>
                    )}
                </div>

                {!editing ? (
                    <footer className="dcfg-footer">
                        <button type="button" className="dcfg-primary-button" onClick={close}>
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
