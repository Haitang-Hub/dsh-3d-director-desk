import "./styles/index.css";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DirectorDeskShell } from "./app/layout/DirectorDeskShell";
import { DirectorCanvas } from "./editor/canvas/DirectorCanvas";
import { DirectorAgentChatPanel } from "./editor/agent/DirectorAgentChatPanel";
import {
  clearDirectorDeskHostBridge,
  initDirectorDeskHostBridge,
  postDirectorDeskMessageToHost,
  computeHasMotionTracks,
} from "./editor/io/hostBridge";
import { useDirectorStore } from "./editor/store/directorStore";
import { DirectorAgentBridge } from "./editor/hooks/use-director-agent-bridge";
import {
  ensureDirectorDeskRecordForId,
  ensureDirectorDeskRecords,
  getInitialDirectorDeskId,
  touchDirectorDeskRecord,
  writeActiveDirectorDeskId,
  type DirectorDeskRecord,
} from "./editor/workspaces/directorDeskRegistry";
import {
  createPerformanceBenchmarkProject,
  getPerformanceBenchmarkMode,
  getPerformanceBenchmarkPlayback,
  getPerformanceBenchmarkSceneConfig,
} from "./editor/performance/performanceBenchmark";
import { getBenchmarkPerformanceProfile } from "./editor/performance/performanceProfiles";

function createInitialEditorViewState(urlInstanceId: string | null) {
  const records = ensureDirectorDeskRecords();
  const benchmarkMode = getPerformanceBenchmarkMode(window.location.search);
  if (benchmarkMode) {
    const timestamp = new Date().toISOString();
    const benchmarkId = urlInstanceId ?? "benchmark_standard";
    const benchmarkRecord: DirectorDeskRecord = {
      id: benchmarkId,
      name: `${getPerformanceBenchmarkSceneConfig(benchmarkMode).label}性能基准（临时）`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return {
      records: [...records.filter((record) => record.id !== benchmarkId), benchmarkRecord],
      activeDeskId: benchmarkId,
    };
  }
  return {
    records,
    activeDeskId: urlInstanceId ?? getInitialDirectorDeskId(records) ?? records[0]?.id ?? "",
  };
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

// 3D 导演台编辑器：全屏独立页面（不含无限画布顶部导航），URL 参数 instanceId 是导演台的唯一入口。
export default function DirectorEditorPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const benchmarkMode = getPerformanceBenchmarkMode(window.location.search);
  const urlInstanceId = searchParams.get("instanceId")?.trim() || null;
  const [directorDeskView, setDirectorDeskView] = useState(() => createInitialEditorViewState(urlInstanceId));
  const { records: directorDesks, activeDeskId } = directorDeskView;

  // 场景加载：首次进入、顶栏切换导演台、浏览器前进后退都经由 URL 参数驱动
  useEffect(() => {
    if (benchmarkMode) return;
    const id = urlInstanceId ?? activeDeskId ?? "";
    if (!id) return;
    if (urlInstanceId !== id) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("instanceId", id);
      setSearchParams(nextParams, { replace: true });
      return;
    }
    const ensured = ensureDirectorDeskRecordForId(directorDesks, id);
    const nextRecords = touchDirectorDeskRecord(ensured.records, id);
    setDirectorDeskView({ records: nextRecords, activeDeskId: id });
    writeActiveDirectorDeskId(id);
    useDirectorStore.getState().openScopedScene(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlInstanceId, benchmarkMode]);

  useEffect(() => {
    initDirectorDeskHostBridge();
    postDirectorDeskMessageToHost({ type: "storyai:director-desk-ready", payload: { hasMotionTracks: computeHasMotionTracks() } });
    return () => clearDirectorDeskHostBridge();
  }, []);

  useEffect(() => {
    if (!benchmarkMode) return;

    const state = useDirectorStore.getState();
    const benchmarkProfile = getBenchmarkPerformanceProfile(window.location.search);
    const benchmarkPlayback = getPerformanceBenchmarkPlayback(window.location.search);
    const benchmarkScene = getPerformanceBenchmarkSceneConfig(benchmarkMode);
    useDirectorStore.setState({
      ...state,
      project: createPerformanceBenchmarkProject(benchmarkMode),
      viewMode: "director",
      selectedObjectId: null,
      selectedObjectIds: [],
      selectedCrowdId: null,
      selectedCameraKeyframeId: null,
      selectedCameraKeyframeIds: [],
      selectedObjectMotionKeyframeId: null,
      showCharacterRoutes: false,
      motionStudioOpen: benchmarkScene.monitorEnabled,
      cameraMotionProgress: benchmarkPlayback.progress,
      cameraMotionPlaying: benchmarkPlayback.playing,
      ...(benchmarkProfile ? { performanceProfile: benchmarkProfile } : {}),
    });
  }, [benchmarkMode]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.repeat) return;

      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        useDirectorStore.getState().copySelectedObjects();
        return;
      }

      if (key === "v") {
        event.preventDefault();
        useDirectorStore.getState().pasteClipboardObjects();
        return;
      }

      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        useDirectorStore.getState().undo();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div className="h-dvh w-full overflow-hidden">
      <DirectorAgentBridge />
      <div className="director-desk-app" data-theme="dark">
        <DirectorAgentChatPanel />
        <div className="app-shell">
          <DirectorDeskShell>
            <DirectorCanvas />
          </DirectorDeskShell>
        </div>
      </div>
    </div>
  );
}
