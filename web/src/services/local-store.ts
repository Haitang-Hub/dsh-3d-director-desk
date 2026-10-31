/**
 * 本地文件存储客户端：读写 local-store 服务（开发态默认 127.0.0.1:17383，插件形态同源 17372）的磁盘数据。
 * 服务不可达时自动降级（调用方回退浏览器存储），可用性结果短暂缓存。
 * 桥启用 token 鉴权后，地址与 token 经 /bootstrap 零配置发现，token 只留在内存。
 */

const DEFAULT_BASE = "http://127.0.0.1:17383";
const HEALTH_TIMEOUT_MS = 1500;
const AVAILABLE_TTL_MS = 30_000;

// 连接配置：localStorage director-store-url 覆盖优先，其次同源 /bootstrap（桥托管站点
// 时页面与桥同 origin），最后回退默认端口；token 随 /bootstrap 发现，只存内存。
let resolvedBase = "";
let bridgeToken = "";
let baseResolveInFlight: Promise<void> | null = null;

function configuredBase(): string {
    try {
        return (localStorage.getItem("director-store-url") || "").trim();
    } catch {
        return "";
    }
}

/** 探测某个 origin 上是否为 director-desk 桥；是则采用该地址并记录 token。 */
async function bootstrapBridge(origin: string): Promise<{ base: string; token: string } | null> {
    try {
        const { signal, done } = withTimeout(HEALTH_TIMEOUT_MS);
        try {
            const res = await fetch(`${origin}/bootstrap`, { signal });
            if (!res.ok) return null;
            const body = (await res.json()) as { name?: string; token?: string };
            if (body.name !== "director-desk") return null;
            return { base: origin, token: body.token || "" };
        } finally {
            done();
        }
    } catch {
        return null;
    }
}

/** 解析桥地址与 token（进程内一次；桥不可达时落到默认地址，后续请求走降级路径）。 */
async function resolveConnection(): Promise<void> {
    if (resolvedBase || baseResolveInFlight) {
        if (baseResolveInFlight) await baseResolveInFlight;
        return;
    }
    baseResolveInFlight = (async () => {
        const configured = configuredBase();
        if (configured) {
            resolvedBase = configured;
            // 显式配置的桥同样尝试领取 token（旧版桥无 token 字段时保持为空）
            bridgeToken = (await bootstrapBridge(configured))?.token || "";
            return;
        }
        const sameOrigin = await bootstrapBridge(window.location.origin);
        if (sameOrigin) {
            resolvedBase = sameOrigin.base;
            bridgeToken = sameOrigin.token;
            return;
        }
        const fallback = await bootstrapBridge(DEFAULT_BASE);
        if (fallback) {
            resolvedBase = fallback.base;
            bridgeToken = fallback.token;
            return;
        }
        resolvedBase = DEFAULT_BASE;
    })().finally(() => {
        baseResolveInFlight = null;
    });
    await baseResolveInFlight;
}

// 模块加载即开始发现，让 mediaUrl 等同步调用尽早拿到地址与 token
void resolveConnection().catch(() => undefined);

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
}

let availableCache: boolean | null = null;
let availableCheckedAt = 0;
let availableInFlight: Promise<boolean> | null = null;

/** 服务是否可用（短缓存；失败也缓存，避免每次请求都等超时）。 */
export async function localStoreAvailable(force = false): Promise<boolean> {
    await resolveConnection();
    if (!force && availableCache !== null && Date.now() - availableCheckedAt < AVAILABLE_TTL_MS) return availableCache;
    if (availableInFlight) return availableInFlight;
    const { signal, done } = withTimeout(HEALTH_TIMEOUT_MS);
    availableInFlight = fetch(`${resolvedBase}/health`, { signal })
        .then((res) => res.ok)
        .catch(() => false)
        .finally(() => {
            done();
            availableInFlight = null;
        })
        .then((ok) => {
            availableCache = ok;
            availableCheckedAt = Date.now();
            return ok;
        });
    return availableInFlight;
}

async function request(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response | null> {
    await resolveConnection();
    if (!(await localStoreAvailable())) return null;
    const { signal, done } = withTimeout(init?.timeoutMs ?? 8000);
    try {
        // 统一附带 token（header 形式）；fetch 包装收敛在这一处
        const headers = { ...(bridgeToken ? { "x-director-token": bridgeToken } : {}), ...init?.headers };
        const res = await fetch(`${resolvedBase}${path}`, { ...init, headers, signal });
        return res.ok || res.status === 404 ? res : null;
    } catch {
        availableCache = false;
        availableCheckedAt = Date.now();
        return null;
    } finally {
        done();
    }
}

// ---- KV（localStorage 键值镜像） ----

export async function kvGetText(key: string): Promise<string | null> {
    const res = await request(`/kv/${encodeURIComponent(key)}`);
    if (!res || res.status === 404) return null;
    return res.text();
}

export async function kvPutText(key: string, value: string): Promise<boolean> {
    const res = await request(`/kv/${encodeURIComponent(key)}`, { method: "PUT", body: value, headers: { "content-type": "text/plain" } });
    return Boolean(res && res.ok);
}

export async function kvDelete(key: string): Promise<void> {
    await request(`/kv/${encodeURIComponent(key)}`, { method: "DELETE" });
}

export async function kvListKeys(): Promise<string[]> {
    const res = await request("/kv");
    if (!res || res.status === 404) return [];
    try {
        const data = (await res.json()) as { keys?: string[] };
        return Array.isArray(data.keys) ? data.keys : [];
    } catch {
        return [];
    }
}

/** 把磁盘上的 KV 拉回浏览器 localStorage（仅补缺失键），用于跨浏览器/跨端口恢复。 */
export async function hydrateLocalStorageFromStore(): Promise<number> {
    if (!(await localStoreAvailable())) return 0;
    const keys = await kvListKeys();
    let restored = 0;
    for (const key of keys) {
        try {
            if (localStorage.getItem(key) !== null) continue;
            const value = await kvGetText(key);
            if (value !== null) {
                localStorage.setItem(key, value);
                restored += 1;
            }
        } catch {
            // 单键失败不影响其余
        }
    }
    return restored;
}

// ---- 媒体/资产二进制 ----

export function mediaUrl(key: string): string {
    // <img>/<video> 等标签无法带自定义头，token 走 query（与 SSE 同口径）
    const token = bridgeToken ? `?token=${encodeURIComponent(bridgeToken)}` : "";
    return `${resolvedBase || DEFAULT_BASE}/assets/${encodeURIComponent(key)}${token}`;
}

export async function mediaExists(key: string): Promise<boolean> {
    const res = await request(`/assets/${encodeURIComponent(key)}`, { method: "HEAD" });
    return Boolean(res && res.ok);
}

export async function mediaUpload(key: string, blob: Blob, fileName?: string): Promise<boolean> {
    const res = await request(`/assets/${encodeURIComponent(key)}`, {
        method: "POST",
        body: blob,
        headers: { "content-type": blob.type || "application/octet-stream", ...(fileName ? { "x-file-name": fileName } : {}) },
        timeoutMs: 10 * 60_000,
    });
    return Boolean(res && res.ok);
}

export async function mediaGetBlob(key: string): Promise<Blob | null> {
    const res = await request(`/assets/${encodeURIComponent(key)}`, { timeoutMs: 10 * 60_000 });
    if (!res || res.status === 404) return null;
    return res.blob();
}

export async function mediaDelete(key: string): Promise<void> {
    await request(`/assets/${encodeURIComponent(key)}`, { method: "DELETE" });
}

export async function mediaListKeys(): Promise<string[]> {
    const res = await request("/assets");
    if (!res || res.status === 404) return [];
    try {
        const data = (await res.json()) as { keys?: string[] };
        return Array.isArray(data.keys) ? data.keys : [];
    } catch {
        return [];
    }
}
