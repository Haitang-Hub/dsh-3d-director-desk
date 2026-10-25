import type { ReactNode } from "react";

/**
 * 导演台首页布局：无顶栏全屏内容。
 * 原顶部导航（品牌、主题切换、模型配置入口）已按需求移除：
 * 模型配置在编辑器 AI 助手面板内管理。
 */
export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="h-dvh overflow-hidden bg-background text-foreground">
            <div className="h-full min-h-0 overflow-hidden">{children}</div>
        </div>
    );
}
