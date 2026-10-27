import { useEffect, useRef, type ChangeEvent } from "react";
import { Download, FolderOpen, Plus, Trash2, Upload, X } from "lucide-react";
import { mirroredLocalStorage } from "@/lib/mirrored-storage";
import {
  createDirectorDeskRecord,
  deleteDirectorDeskRecord,
  getDirectorDeskNumber,
  type DirectorDeskRecord,
} from "../workspaces/directorDeskRegistry";
import { parseProject } from "../io/importProjectJson";
import { serializeProject } from "../io/exportProjectJson";
import { isDirectorProjectShape } from "../io/projectDocument";

/** 场景持久化键前缀（与 directorStore、旧首页保持一致）。 */
const DIRECTOR_SCENE_STORAGE_KEY_PREFIX = "storyai-3d-director-desk-demo:";

function formatUpdatedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "刚刚更新";

  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) return "刚刚更新";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  if (diffMinutes < 1440) return `${Math.round(diffMinutes / 60)} 小时前`;

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDeskNumber(desk: DirectorDeskRecord) {
  const number = getDirectorDeskNumber(desk);
  return number > 0 ? `#${String(number).padStart(2, "0")}` : "#--";
}

function readDeskProject(deskId: string) {
  for (const key of [`${DIRECTOR_SCENE_STORAGE_KEY_PREFIX}${deskId}`, "storyai-3d-director-desk-demo"]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { project?: unknown };
      if (isDirectorProjectShape(parsed?.project)) return parsed.project;
    } catch {
      // 单键损坏不影响其余
    }
  }
  return null;
}

function downloadJson(text: string, fileName: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface ProjectDirectoryPanelProps {
  open: boolean;
  onClose: () => void;
  records: DirectorDeskRecord[];
  activeDeskId: string;
  /** 注册表落库后同步编辑器里的列表状态。 */
  onRecordsChange: (records: DirectorDeskRecord[]) => void;
  /** 打开（切换到）某个工程：由编辑器驱动 URL 与场景加载。 */
  onOpenDesk: (id: string) => void;
}

/**
 * 工程目录：导演台（工程）的本地管理面板，内嵌在编辑器顶栏打开。
 * 列表按「编号 + 名称」展示；支持新建、导入 .json 工程、导出、删除与切换。
 * 数据全部保存在浏览器本地存储（localStorage + IndexedDB 镜像）。
 */
export function ProjectDirectoryPanel({ open, onClose, records, activeDeskId, onRecordsChange, onOpenDesk }: ProjectDirectoryPanelProps) {
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  function openDesk(id: string) {
    onOpenDesk(id);
    onClose();
  }

  function handleCreateDesk() {
    const record = createDirectorDeskRecord(records);
    const nextRecords = [...records, record];
    onRecordsChange(nextRecords);
    openDesk(record.id);
  }

  function handleImportProjectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    void file.text().then((text) => {
      let project;
      try {
        project = parseProject(text);
      } catch {
        window.alert("工程文件解析失败：请确认是导演台导出的 .json 工程");
        return;
      }
      const record = createDirectorDeskRecord(records, file.name.replace(/\.director-project\.json$|\.json$/i, ""));
      const nextRecords = [...records, record];
      const storage = mirroredLocalStorage();
      try {
        storage?.setItem(`${DIRECTOR_SCENE_STORAGE_KEY_PREFIX}${record.id}`, JSON.stringify({ project }));
      } catch {
        window.alert("本地存储写入失败：浏览器存储空间可能已满");
        return;
      }
      onRecordsChange(nextRecords);
      openDesk(record.id);
    });
  }

  function handleExportDesk(desk: DirectorDeskRecord) {
    const project = readDeskProject(desk.id);
    if (!project) {
      window.alert(`「${desk.name}」还没有可导出的场景数据`);
      return;
    }
    downloadJson(serializeProject(project), `${desk.name || "导演台"}.director-project.json`);
  }

  function handleDeleteDesk(desk: DirectorDeskRecord) {
    if (!window.confirm(`删除「${desk.name}」？这个工程的本地场景数据也会一起删除。`)) return;

    const result = deleteDirectorDeskRecord(records, desk.id);
    onRecordsChange(result.records);
    if (result.records.length === 0) {
      // 删空后自动补一个新工程，保证编辑器始终有可用场景
      const record = createDirectorDeskRecord([]);
      result.records.push(record);
      onRecordsChange(result.records);
      openDesk(record.id);
      return;
    }
    if (desk.id === activeDeskId && result.activeId) openDesk(result.activeId);
  }

  return (
    <div className="dproj-overlay" role="dialog" aria-modal="true" aria-label="工程目录" onClick={onClose}>
      <section className="dproj-modal" onClick={(event) => event.stopPropagation()}>
        <header className="dproj-head">
          <div className="dproj-head-text">
            <h2><FolderOpen aria-hidden="true" size={17} />工程目录</h2>
            <p>工程保存在本机浏览器，按编号与名称管理；双击顶栏名称可重命名当前工程。</p>
          </div>
          <div className="dproj-head-actions">
            <button className="dproj-action-button" type="button" onClick={handleCreateDesk}>
              <Plus aria-hidden="true" size={14} />
              新建工程
            </button>
            <button className="dproj-action-button" type="button" onClick={() => importInputRef.current?.click()}>
              <Upload aria-hidden="true" size={14} />
              导入工程
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImportProjectFile}
            />
            <button className="dproj-close-button" type="button" aria-label="关闭工程目录" onClick={onClose}>
              <X aria-hidden="true" size={15} />
            </button>
          </div>
        </header>

        <div className="dproj-list" aria-label="工程列表">
          {records.map((desk) => (
            <article key={desk.id} className={`dproj-row${desk.id === activeDeskId ? " is-active" : ""}`}>
              <button className="dproj-row-main" type="button" onClick={() => openDesk(desk.id)} title="打开这个工程">
                <span className="dproj-row-number">{formatDeskNumber(desk)}</span>
                <span className="dproj-row-name">{desk.name}{desk.id === activeDeskId ? "（当前）" : ""}</span>
                <span className="dproj-row-meta">更新于 {formatUpdatedAt(desk.updatedAt)}</span>
              </button>
              <div className="dproj-row-actions">
                <button
                  className="dproj-row-button"
                  type="button"
                  aria-label={`导出${desk.name}`}
                  title="导出工程文件（.json）"
                  onClick={() => handleExportDesk(desk)}
                >
                  <Download aria-hidden="true" size={14} strokeWidth={1.9} />
                </button>
                <button
                  className="dproj-row-button is-danger"
                  type="button"
                  aria-label={`删除${desk.name}`}
                  title="删除这个工程"
                  onClick={() => handleDeleteDesk(desk)}
                >
                  <Trash2 aria-hidden="true" size={14} strokeWidth={1.9} />
                </button>
              </div>
            </article>
          ))}
          {records.length === 0 ? (
            <div className="dproj-empty">
              <FolderOpen aria-hidden="true" size={24} strokeWidth={1.6} />
              <p>还没有工程，点击「新建工程」开始。</p>
            </div>
          ) : null}
        </div>

        <footer className="dproj-foot">
          数据本地存储：场景与工程列表保存在浏览器 localStorage，并镜像到 IndexedDB 便于跨端口找回；
          导出 .json 工程文件可跨设备迁移或交给他人。
        </footer>
      </section>
    </div>
  );
}
