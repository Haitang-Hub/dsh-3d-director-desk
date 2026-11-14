import { create } from "zustand";

export type DirectorBridgeStatus = "offline" | "connecting" | "online";

type DirectorBridgeStore = {
    /** 桥端点（可手动覆盖，持久化到 director-bridge-url）。 */
    endpoint: string;
    /** 连接 token（经 /bootstrap 自动发现或手动填写，持久化到 director-bridge-token）。 */
    token: string;
    /** 用户是否允许连接；断开置 false，SSE 不再自动重连。 */
    enabled: boolean;
    /** SSE 建连世代：手动连接时 +1 以触发重连。 */
    epoch: number;
    status: DirectorBridgeStatus;
    /** 进行中的桥工具调用数，>0 时顶栏显示"执行中"。 */
    executing: number;
    setBridgeState: (patch: Partial<Pick<DirectorBridgeStore, "endpoint" | "token" | "enabled" | "epoch" | "status" | "executing">>) => void;
    connectBridge: () => void;
    disconnectBridge: () => void;
};

const ENDPOINT_KEY = "director-bridge-url";
const TOKEN_KEY = "director-bridge-token";
const ENABLED_KEY = "director-bridge-enabled";

function readStorage(key: string): string {
    try {
        return localStorage.getItem(key) || "";
    } catch {
        return "";
    }
}

function writeStorage(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // 隐私模式等场景下写不进去：本次会话内仍生效
    }
}

export const useBridgeStore = create<DirectorBridgeStore>((set) => ({
    endpoint: readStorage(ENDPOINT_KEY),
    token: readStorage(TOKEN_KEY),
    // 默认允许自动连接（与此前零配置静默探测的行为一致），断开后记住选择。
    enabled: readStorage(ENABLED_KEY) !== "0",
    epoch: 0,
    status: "offline",
    executing: 0,
    setBridgeState: (patch) => {
        set(patch);
        if (patch.endpoint !== undefined) writeStorage(ENDPOINT_KEY, patch.endpoint);
        if (patch.token !== undefined) writeStorage(TOKEN_KEY, patch.token);
        if (patch.enabled !== undefined) writeStorage(ENABLED_KEY, patch.enabled ? "1" : "0");
    },
    connectBridge: () => {
        useBridgeStore.getState().setBridgeState({ enabled: true, epoch: useBridgeStore.getState().epoch + 1, status: "connecting" });
    },
    disconnectBridge: () => {
        useBridgeStore.getState().setBridgeState({ enabled: false, status: "offline", executing: 0 });
    },
}));
