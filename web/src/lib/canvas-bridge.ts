/**
 * 无限画布桥客户端：跨项目读写 infinite-canvas 的画布工程与媒体库。
 * 数据通道是 infinite-canvas canvas-agent(17371) 的本地文件存储端点（免 token）：
 *   - 画布工程：GET/PUT /store/kv/infinite-canvas:canvas_store（zustand persist JSON）
 *   - 媒体文件：POST /store/media/:key，读取走 /media/:key
 * 注意：若 infinite-canvas 页面正开着，其内存态会在下一次变更时覆盖磁盘；
 * 导入后提示用户刷新画布页面。
 */

const DEFAULT_BASE = "http://127.0.0.1:17371";
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const HEALTH_TIMEOUT_MS = 1500;
const IO_TIMEOUT_MS = 10 * 60_000;

function baseUrl(): string {
    try {
        const configured = localStorage.getItem("canvas-bridge-url");
        return (configured && configured.trim()) || DEFAULT_BASE;
    } catch {
        return DEFAULT_BASE;
    }
}

async function request(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 8000);
    try {
        return await fetch(`${baseUrl()}${path}`, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export async function canvasBridgeAvailable(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
        const res = await fetch(`${baseUrl()}/store/health`, { signal: controller.signal });
        clearTimeout(timer);
        return res.ok;
    } catch {
        return false;
    }
}

type RemoteCanvasStore = { state?: { projects?: Array<Record<string, unknown>>; deletedProjects?: unknown }; version?: number };

async function readCanvasStore(): Promise<RemoteCanvasStore> {
    const res = await request(`/store/kv/${encodeURIComponent(CANVAS_STORE_KEY)}`);
    if (res.status === 404) return {};
    if (!res.ok) throw new Error("读取画布工程失败（本地服务异常）");
    try {
        return JSON.parse(await res.text()) as RemoteCanvasStore;
    } catch {
        throw new Error("画布工程数据损坏，无法解析");
    }
}

async function writeCanvasStore(store: RemoteCanvasStore): Promise<void> {
    const res = await request(`/store/kv/${encodeURIComponent(CANVAS_STORE_KEY)}`, {
        method: "PUT",
        body: JSON.stringify(store),
        headers: { "content-type": "text/plain" },
    });
    if (!res.ok) throw new Error("保存画布工程失败（本地服务异常）");
}

export type RemoteCanvasProjectSummary = { id: string; title: string; updatedAt: string };

/** 列出无限画布的全部工程（用于校验来源画布存在）。 */
export async function listRemoteCanvasProjects(): Promise<RemoteCanvasProjectSummary[]> {
    const store = await readCanvasStore();
    return (store.state?.projects ?? [])
        .map((project) => ({
            id: String(project.id ?? ""),
            title: String(project.title ?? "未命名画布"),
            updatedAt: String(project.updatedAt ?? ""),
        }))
        .filter((project) => project.id);
}

/** 把新节点与连线追加进远程画布工程；节点摆放在导演台节点右侧依次横排，返回目标画布标题。 */
export async function appendNodesToRemoteCanvas(
    projectId: string,
    directorNodeId: string,
    nodes: Array<Record<string, unknown>>,
    connections: Array<Record<string, unknown>>,
): Promise<string> {
    const store = await readCanvasStore();
    const projects = store.state?.projects;
    if (!Array.isArray(projects)) throw new Error("无限画布还没有任何工程数据");
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("来源画布不存在，请重新从画布打开导演台");
    const existingNodes = Array.isArray(project.nodes) ? (project.nodes as Array<Record<string, unknown>>) : [];
    const existingConnections = Array.isArray(project.connections) ? project.connections : [];

    const directorNode = existingNodes.find((item) => item.id === directorNodeId);
    const directorWidth = Number((directorNode?.width as number) || 0);
    const directorHeight = Number((directorNode?.height as number) || 0);
    const startX = directorNode ? Number((directorNode.position as { x: number })?.x || 0) + directorWidth + 96 : 0;
    const startY = directorNode ? Number((directorNode.position as { y: number })?.y || 0) + directorHeight / 2 : 0;
    const importedCount = existingNodes.filter((item) => (item.metadata as Record<string, unknown>)?.sourceDirectorNodeId === directorNodeId).length;

    const placed = nodes.map((node, index) => {
        const width = Number((node.width as number) || 0);
        const height = Number((node.height as number) || 0);
        return {
            ...node,
            position: { x: startX + (importedCount + index) * (width + 40), y: startY - height / 2 },
        };
    });
    project.nodes = [...existingNodes, ...placed];
    project.connections = [...existingConnections, ...connections];
    project.updatedAt = new Date().toISOString();
    await writeCanvasStore(store);
    return String(project.title ?? "画布");
}

/** 上传媒体文件到无限画布的磁盘媒体库，返回稳定的 /media 地址。 */
export async function uploadRemoteCanvasMedia(key: string, blob: Blob, mimeType: string): Promise<string> {
    const res = await request(`/store/media/${encodeURIComponent(key)}`, {
        method: "POST",
        body: blob,
        headers: { "content-type": mimeType || "application/octet-stream" },
        timeoutMs: IO_TIMEOUT_MS,
    });
    if (!res.ok) throw new Error("媒体文件写入无限画布失败");
    return `${baseUrl()}/media/${encodeURIComponent(key)}`;
}

/** 读取图片尺寸（截图 dataUrl → naturalWidth/Height）。 */
export function readImageMeta(dataUrl: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => (image.naturalWidth && image.naturalHeight ? resolve({ width: image.naturalWidth, height: image.naturalHeight }) : reject(new Error("图片读取失败")));
        image.onerror = () => reject(new Error("图片读取失败"));
        image.src = dataUrl;
    });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
    return await (await fetch(dataUrl)).blob();
}
