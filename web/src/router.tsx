import { lazy, Suspense } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import DirectorPage from "@/pages/director";
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
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <DirectorPage /> },
            { path: "/director", element: <DirectorPage /> },
        ],
    },
    {
        // 3D 导演台编辑器：全屏独立页，不带顶部导航
        path: "/director/editor",
        element: (
            <>
                <AnalyticsTracker />
                <LazyDirectorEditorPage />
            </>
        ),
    },
    { path: "*", element: <NotFound /> },
]);
