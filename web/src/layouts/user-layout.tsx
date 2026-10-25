import type { ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Link } from "react-router-dom";

import { AppConfigModal } from "@/components/layout/app-config-modal";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 导演台首页布局：轻量顶栏（品牌 + 主题 + 模型配置）。
 * 原 Canvas Director 的顶部导航（Agent 面板、文档、GitHub 等）已随拆分移除。
 */
export default function UserLayout({ children }: { children: ReactNode }) {
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <header className="flex h-12 shrink-0 items-center justify-between border-b border-stone-200 px-5 dark:border-stone-800">
                    <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-stone-950 dark:text-stone-100">
                        <span
                            className="size-5 shrink-0 bg-current"
                            style={{
                                mask: "url(/logo.svg) center / contain no-repeat",
                                WebkitMask: "url(/logo.svg) center / contain no-repeat",
                            }}
                        />
                        3D 导演台
                    </Link>
                    <div className="flex items-center gap-1">
                        <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white" aria-label="切换主题" title="切换主题" />
                        <button
                            type="button"
                            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white"
                            onClick={() => openConfigDialog(false)}
                            aria-label="模型配置"
                            title="模型配置"
                        >
                            <Settings2 className="size-4" />
                        </button>
                    </div>
                </header>
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            <AppConfigModal />
        </div>
    );
}
