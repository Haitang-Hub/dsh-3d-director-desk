import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import DirectorHelpPage from "@/pages/director";
import NotFound from "@/pages/not-found";

// 3D 导演台编辑器依赖 three.js，体积较大，按需懒加载
const DirectorEditorPage = lazy(() => import("@/pages/director/editor-page"));

function LazyDirectorEditorPage() {
    return (
        <Suspense fallback={<div className="h-dvh w-full bg-black" />}>
            <DirectorEditorPage />
        </Suspense>
    );
}

export const router = createBrowserRouter([
    // 导演台即主页：/、/director、/director/editor 都进入全屏编辑器，
    // 自动恢复上次使用的工程；新建/删除/导入/导出等工程管理内嵌在编辑器「工程目录」中。
    { path: "/", element: <LazyDirectorEditorPage /> },
    { path: "/director", element: <LazyDirectorEditorPage /> },
    { path: "/director/editor", element: <LazyDirectorEditorPage /> },
    // 帮助文档：原首页的使用说明内容（快速上手、操作表、工程管理说明）。
    { path: "/help", element: <><AnalyticsTracker /><DirectorHelpPage /></> },
    { path: "/docs", element: <><AnalyticsTracker /><DirectorHelpPage /></> },
    { path: "*", element: <NotFound /> },
]);
