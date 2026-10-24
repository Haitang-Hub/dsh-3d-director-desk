import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { initMirrorAvailability } from "@/lib/mirrored-storage";
import { hydrateLocalStorageFromStore } from "@/services/local-store";
import { router } from "@/router";

initAnalytics();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

// 先从磁盘恢复缺失的 localStorage 键（跨浏览器/跨端口数据找回），再挂载应用；
// 本地存储服务不可用时最多阻塞 2 秒，不影响纯前端离线使用。
void (async () => {
    await Promise.race([
        (async () => {
            await initMirrorAvailability();
            await hydrateLocalStorageFromStore();
        })(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
})();
