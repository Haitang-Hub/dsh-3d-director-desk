import "./styles/index.css";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDownToLine, ArrowRight, BookOpen, Check, FolderOpen, Hand, HardDrive, Keyboard, MousePointer2, Pencil, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { useThemeStore } from "@/stores/use-theme-store";
import { probeDirectorBridge } from "./editor/hooks/use-director-agent-bridge";

const HOME_QUICK_START_STEPS = [
  ["打开导演台", "点击本页「打开导演台」进入编辑器，自动恢复上次使用的工程。"],
  ["摆人物和道具", "从工具栏添加模型，选中后使用 XYZ 三轴移动、旋转和缩放。"],
  ["记录镜头", "点击“运镜 → 开始掌镜”，用 WASD 移动，每到一个镜头按 Enter。"],
  ["预演并导出", "先“看路线”检查轨迹，再“看成片”，满意后导出 MP4 参考视频。"],
] as const;

const HOME_RELEASE_NOTES = [
  "人物路线支持添加、插入、删除和拖动，行走时会沿平滑曲线自然转向",
  "人物路线与摄影机轨迹可常亮显示，并支持批量移动多个轨迹点",
  "新增路径碰撞开关，可让人物贴地，并阻止人物和镜头穿过场景物体",
  "看成片时可随时暂停和拖动底部时间轴，不会再退出第一视角预览",
  "主成片 FOV 与监看小窗 FOV 已分开设置，导出使用主成片 FOV",
  "新增可拖动实时监看小窗、MP4 参考视频导出和更可靠的撤销逻辑",
] as const;

const HOME_CONTROL_GROUPS = [
  {
    title: "普通导演视角",
    description: "摆场景和检查路线时使用",
    controls: [
      ["W / A / S / D", "前进、左移、后退、右移"],
      ["Space / Shift", "上升 / 下降"],
      ["鼠标左键拖动", "环绕观察场景"],
      ["鼠标右键拖动", "平移观察中心"],
      ["滚轮", "靠近 / 远离场景"],
    ],
  },
  {
    title: "掌镜模式",
    description: "像 FPS 游戏一样录制摄影机轨迹点",
    controls: [
      ["W / A / S / D", "前进、左移、后退、右移"],
      ["E / Q", "镜头上升 / 下降"],
      ["移动鼠标", "转动镜头方向"],
      ["Enter", "保存或更新当前轨迹点"],
      ["Space", "播放 / 暂停人物和物体运动"],
      ["F", "锁定或取消准星所指目标"],
      ["滚轮", "调整镜头 FOV"],
      ["Esc", "释放鼠标并退出掌镜"],
      ["单击画面", "重新锁定鼠标"],
    ],
  },
  {
    title: "通用编辑",
    description: "场景、路线点和时间轴都适用",
    controls: [
      ["⌘ / Ctrl + C", "复制选中的人物或物体"],
      ["⌘ / Ctrl + V", "粘贴并选中新副本"],
      ["⌘ / Ctrl + Z", "撤销最近一次编辑或拖动"],
      ["Shift + 单击", "在场景树中多选 / 取消选择"],
      ["Delete / Backspace", "删除当前选中对象"],
      ["拖动 XYZ 字母", "连续调整对应轴数值"],
      ["↑ / ↓", "聚焦 XYZ 字母时微调数值"],
      ["拖动底部时间轴", "立即暂停并定位到指定时间"],
    ],
  },
] as const;

const HOME_MAC_GESTURES = [
  ["单指按下并拖动", "普通导演视角中环绕观察；掌镜时直接移动手指即可转向"],
  ["双指上下滑动", "普通视角缩放场景；掌镜模式调整镜头 FOV"],
  ["双指点按后拖动", "开启 macOS“辅助点按”后，可平移普通导演视角"],
  ["双指滚动页面", "上下查看完整使用说明和本次更新"],
  ["轻点画面", "掌镜退出锁定后，重新进入鼠标锁定"],
] as const;

const HOME_TOOL_GROUPS = [
  ["顶栏", "工程目录、帮助文档、工程名称（双击改名）、导演/第一视角、运镜工作台、视角手感"],
  ["视口工具栏", "移动、旋转、缩放、添加角色、路线常亮、导入模型、模型库、添加机位"],
  ["画面工具", "选择画幅、当前/四方位/十二方位截图、全屏"],
  ["底部时间轴", "回到开头、播放/暂停、拖动定位、总时长、记录点、删除当前点"],
  ["运镜工作台", "开始掌镜、添加/插入/批量移动轨迹点、看路线、看成片、导出视频"],
  ["右侧属性", "对象 XYZ、姿势、动作、人物路线、场景地面与路径碰撞"],
] as const;

const HOME_PROJECT_MANAGEMENT = [
  {
    icon: Plus,
    title: "新建工程",
    description: "编辑器顶栏左侧打开「工程目录」，点击“新建工程”即可创建，编号自动递增。",
  },
  {
    icon: FolderOpen,
    title: "打开与切换",
    description: "工程目录按「编号 + 名称」列出所有本地工程，点击任意一行即可切换，当前工程会标注“（当前）”。",
  },
  {
    icon: Pencil,
    title: "重命名",
    description: "在编辑器顶栏双击工程名称即可重命名；新建工程默认叫“导演台 N 号”，N 就是它的编号。",
  },
  {
    icon: Upload,
    title: "导入工程",
    description: "工程目录中点击“导入工程”，选择导演台导出的 .json 工程文件，会自动建立编号并进入编辑。",
  },
  {
    icon: ArrowDownToLine,
    title: "导出工程",
    description: "工程目录中每行都有导出按钮，生成 .director-project.json，可跨设备迁移或交给他人。",
  },
  {
    icon: Trash2,
    title: "删除工程",
    description: "工程目录中每行都有删除按钮；删除会同时清掉这个工程的本地场景数据，删空后会自动补一个新工程。",
  },
] as const;

/** 帮助文档页：原首页的使用说明内容；工程管理等功能已内嵌到导演台编辑器的「工程目录」中。 */
export default function DirectorHelpPage() {
  const navigate = useNavigate();
  const theme = useThemeStore((state) => state.theme);
  // AI 桥（director-mcp）在线状态：null = 探测中
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    probeDirectorBridge().then((status) => {
      if (alive) setBridgeOnline(status.online);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 路由级标签页标题：AppProviders 挂载时会写入全局标题，这里在其后再断言一次；
  // 离开帮助页时恢复默认标题（浏览器标签里能分清当前是帮助文档还是导演台）。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      document.title = "帮助文档 · 3D 导演台";
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.title = "3D 导演台";
    };
  }, []);

  return (
    <div className="h-dvh overflow-hidden">
      <div className="director-desk-app h-full" data-theme={theme === "dark" ? "dark" : "light"}>
        <main className="director-home-shell">
          <section className="director-home-hero">
            <div>
              <p className="director-home-kicker">3D Director Desk · Help</p>
              <h1>3D 导演台帮助文档</h1>
              <p>
                打开站点首页即进入导演台编辑器；新建、导入、导出、删除工程都在编辑器顶栏的「工程目录」里完成。
                本页只保留使用说明，供随时查阅。
              </p>
              <span
                title={bridgeOnline ? "AI 桥（director-mcp）在线，DeepSeek 可以驱动导演台" : "AI 桥未启动：纯前端功能不受影响；要接 AI 编排请运行 start.bat"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 12,
                  fontSize: 13,
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: `1px solid ${bridgeOnline ? "#16a34a55" : "#9ca3af44"}`,
                  color: bridgeOnline ? "#16a34a" : "#9ca3af",
                  userSelect: "none",
                }}
              >
                <Sparkles aria-hidden="true" size={13} />
                {bridgeOnline === null ? "AI 桥检测中…" : bridgeOnline ? "AI 桥在线" : "AI 桥离线"}
              </span>
            </div>
            <div className="director-home-hero-actions">
              <button className="director-home-primary-button" type="button" onClick={() => navigate("/")}>
                <ArrowRight aria-hidden="true" size={18} />
                打开导演台
              </button>
              <a className="director-home-scroll-hint" href="#director-home-guide-title">
                向下查看使用说明
                <ArrowDownToLine aria-hidden="true" size={14} />
              </a>
            </div>
          </section>

          <section className="director-home-guide" aria-labelledby="director-home-guide-title">
            <header className="director-home-section-heading">
              <span><BookOpen aria-hidden="true" size={16} />第一次使用</span>
              <div>
                <h2 id="director-home-guide-title">四步完成第一条运镜</h2>
                <p>不用先学习复杂的 3D 软件，按照下面顺序操作即可。</p>
              </div>
            </header>
            <ol className="director-home-steps">
              {HOME_QUICK_START_STEPS.map(([title, description], index) => (
                <li key={title}>
                  <span>{index + 1}</span>
                  <div><strong>{title}</strong><p>{description}</p></div>
                </li>
              ))}
            </ol>
            <p className="director-home-shortcuts">
              <strong>掌镜快捷键</strong>
              <kbd>WASD</kbd>移动
              <kbd>Q / E</kbd>下降 / 上升
              <kbd>Enter</kbd>保存镜头
              <kbd>Space</kbd>播放 / 暂停
              <kbd>Esc</kbd>退出掌镜
            </p>
          </section>

          <section className="director-home-guide" aria-labelledby="director-home-project-title">
            <header className="director-home-section-heading">
              <span><FolderOpen aria-hidden="true" size={16} />工程管理</span>
              <div>
                <h2 id="director-home-project-title">工程目录：编号、名称与本地存储</h2>
                <p>工程按「编号 + 名称」管理，全部数据保存在本机浏览器，入口在编辑器顶栏左侧的文件夹图标。</p>
              </div>
            </header>
            <div className="director-home-control-grid">
              {HOME_PROJECT_MANAGEMENT.map((item) => (
                <article key={item.title} className="director-home-control-group">
                  <header><item.icon aria-hidden="true" size={15} /><div><h3>{item.title}</h3><p>{item.description}</p></div></header>
                </article>
              ))}
            </div>
            <article className="director-home-mac-gestures">
              <header><HardDrive aria-hidden="true" size={17} /><div><h3>数据保存在哪里</h3><p>本地存储与外部接入说明</p></div></header>
              <dl>
                <div><dt>本地存储</dt><dd>工程列表与每个场景保存在浏览器 localStorage，并镜像到 IndexedDB，换端口或浏览器异常后可自动找回。</dd></div>
                <div><dt>编号规则</dt><dd>新建工程自动分配递增编号（#01、#02…），默认名称“导演台 N 号”；重命名不影响编号。</dd></div>
                <div><dt>按编号或名称打开</dt><dd>URL 参数 instanceId 支持编号、desk_N 或工程名，例如 /?instanceId=2、/?instanceId=我的场景，便于外部系统直接打开指定工程。</dd></div>
                <div><dt>AI / 外部接入</dt><dd>Agent 通过 director-desk MCP 工具驱动当前工程；用上面的 URL 方式即可让外部流程定位到指定工程。</dd></div>
              </dl>
            </article>
          </section>

          <section className="director-home-controls" aria-labelledby="director-home-controls-title">
            <header className="director-home-section-heading">
              <span><Keyboard aria-hidden="true" size={16} />完整操作表</span>
              <div>
                <h2 id="director-home-controls-title">键盘、鼠标与触控板操作</h2>
                <p>快捷键在输入框中不会触发；掌镜模式下请先单击 3D 画面锁定鼠标。</p>
              </div>
            </header>

            <div className="director-home-control-grid">
              {HOME_CONTROL_GROUPS.map((group) => (
                <article key={group.title} className="director-home-control-group">
                  <header><MousePointer2 aria-hidden="true" size={15} /><div><h3>{group.title}</h3><p>{group.description}</p></div></header>
                  <dl>
                    {group.controls.map(([keys, action]) => (
                      <div key={keys}><dt>{keys}</dt><dd>{action}</dd></div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>

            <article className="director-home-mac-gestures">
              <header><Hand aria-hidden="true" size={17} /><div><h3>macOS 触控板手势</h3><p>以 MacBook 默认手势和已开启“辅助点按”为准</p></div></header>
              <dl>
                {HOME_MAC_GESTURES.map(([gesture, action]) => (
                  <div key={gesture}><dt>{gesture}</dt><dd>{action}</dd></div>
                ))}
              </dl>
            </article>

            <article className="director-home-tools-guide">
              <h3>主要界面按钮</h3>
              <dl>
                {HOME_TOOL_GROUPS.map(([area, actions]) => (
                  <div key={area}><dt>{area}</dt><dd>{actions}</dd></div>
                ))}
              </dl>
            </article>
          </section>

          <section className="director-home-release" aria-labelledby="director-home-release-title">
            <header className="director-home-section-heading">
              <span><Sparkles aria-hidden="true" size={16} />本次更新</span>
              <div>
                <h2 id="director-home-release-title">路线编辑、监看与导出升级</h2>
                <p>这次重点补全人物运动、镜头预演和参考视频工作流。</p>
              </div>
            </header>
            <ul className="director-home-release-list">
              {HOME_RELEASE_NOTES.map((note) => (
                <li key={note}><Check aria-hidden="true" size={15} /><span>{note}</span></li>
              ))}
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}
