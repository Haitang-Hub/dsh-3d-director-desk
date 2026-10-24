import { kvDelete, kvPutText, localStoreAvailable } from "@/services/local-store";

/**
 * localStorage 写透镜像：读仍然走 localStorage（快），每次写入/删除在防抖后
 * 同步一份到本地文件存储服务（磁盘），使工程数据不再受浏览器 origin 隔离影响。
 */

const pendingPuts = new Map<string, ReturnType<typeof setTimeout>>();
const mirrorEnabled = { value: true };

function schedulePut(key: string, value: string) {
    if (!mirrorEnabled.value) return;
    const existing = pendingPuts.get(key);
    if (existing) clearTimeout(existing);
    pendingPuts.set(
        key,
        setTimeout(() => {
            pendingPuts.delete(key);
            void kvPutText(key, value);
        }, 400),
    );
}

function scheduleDelete(key: string) {
    if (!mirrorEnabled.value) return;
    const existing = pendingPuts.get(key);
    if (existing) clearTimeout(existing);
    pendingPuts.delete(key);
    void kvDelete(key);
}

/** 返回带磁盘镜像的 localStorage（SSR/异常时回退原生）。 */
export function mirroredLocalStorage(): Storage | null {
    if (typeof localStorage === "undefined") return null;
    return new Proxy(localStorage, {
        get(target, prop, receiver) {
            if (prop === "setItem") {
                return (key: string, value: string) => {
                    target.setItem(key, value);
                    schedulePut(key, value);
                };
            }
            if (prop === "removeItem") {
                return (key: string) => {
                    target.removeItem(key);
                    scheduleDelete(key);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

/** 服务不可用时停用镜像（避免无谓请求）。 */
export async function initMirrorAvailability() {
    mirrorEnabled.value = await localStoreAvailable();
}
