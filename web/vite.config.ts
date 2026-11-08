import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Dev-态同源化：把 director-mcp 桥的 API 前缀代理到开发桥（17383，与 Desktop 插件桥 17372 错开），
// 让 5080 页面与插件托管形态一样同源连桥。/director 只精确代理 ready/result 两个桥端点，
// /director/editor 等 SPA 路由保持本地；/canvas/result 是写给旧画布桥的兼容回退路径。
const DEV_BRIDGE_TARGET = process.env.DEV_BRIDGE_ORIGIN?.trim() || "http://127.0.0.1:17383";
const DEV_BRIDGE_PROXY = {
    "/bootstrap": DEV_BRIDGE_TARGET,
    "/health": DEV_BRIDGE_TARGET,
    "/mcp": DEV_BRIDGE_TARGET,
    "/events": DEV_BRIDGE_TARGET,
    "/kv": DEV_BRIDGE_TARGET,
    "/assets": DEV_BRIDGE_TARGET,
    "/skills": DEV_BRIDGE_TARGET,
    "/director/ready": DEV_BRIDGE_TARGET,
    "/director/result": DEV_BRIDGE_TARGET,
    "/canvas/result": DEV_BRIDGE_TARGET,
};

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
    server: { proxy: DEV_BRIDGE_PROXY },
});
