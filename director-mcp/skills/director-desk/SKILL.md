---
name: director-desk
description: 用 3D 导演台（director-desk）的 stage/camera/preview 工具摆场景、设运镜、出预演图和成片。当用户要求"摆人物/道具、设计镜头、运镜、出预览图或导出预演视频"时使用。
---

# 3D 导演台编排技能

3D 导演台是一个浏览器里的 3D 场景编排工具。你（Agent）通过 MCP 工具驱动它：
摆角色和道具 → 设计摄影机轨迹 → 渲染单帧检查构图 → 导出预演成片。
用户在浏览器（http://127.0.0.1:17372）里能实时看到你的每一步操作。

## 工作流

1. **摸底**：`stage_get_state` 看当前场景对象与机位；`stage_list_presets` 查可用
   姿势/动作/几何体/模型库/运镜模板/节奏预设。**调参前先查预设，不要凭空编 ID。**
2. **摆场景**：
   - 角色：`stage_place_character`（可带 pose 预设、位置 x/y/z、朝向 rotation、缩放）。
   - 道具：`stage_place_prop`（geometryType: box/sphere/cylinder/torus/cone/pyramid）。
   - 库模型：`stage_add_model`（assetId 精确选择或名称匹配，覆盖人物/便利生活/居家生活/户外出行/
     工具配件全目录；assetId 用 stage_list_presets 的 library 查询，条目带 categoryId 与 kind）。
   - 微调：`stage_update_object`（位置/颜色/可见/姿势/动作）；删除用 `stage_remove_object`。
   - 坐标系：x 右、y 上、z 前；rotation 是绕 Y 轴角度（度）。两人对话让角色面对面
     （rotation 相差约 180°），间距 1.5~2.5。
3. **运镜**：
   - 快捷：`camera_apply_preset`（templateId 来自 motionTemplates，可用 subjectObjectId 跟踪角色）。
   - 手动：`camera_set_pose` 调好视角 → `camera_set_keyframe` 逐个记录关键帧（至少 2 个才能出片）。
   - 修改：`camera_update_keyframe` / `camera_delete_keyframe` / `camera_set_pacing`；
     查轨迹用 `camera_get_trajectory`。
4. **检查**：`preview_render_frame` 渲染单帧（返回文件路径；includeData=true 才内联 base64）。
   多机位时每个机位出一帧确认构图后再继续。
5. **出片**：`preview_export_animatic` 导出 MP4 预演（耗时可达数分钟，耐心等待；
   fps 24/30/60，quality 720p/1080p）。

## 注意

- 渲染/导出类工具（preview_*）需要导演台页面在浏览器中打开；离线时会返回
  `executor_offline`——提示用户打开页面后重试。
- 破坏性工具（stage_clear_scene、stage_remove_object、camera_delete_keyframe）
  调用前先 stage_get_state 确认现状。
- 多个导演台在线时用 desk 参数指定目标（工具会路由到对应页面）；不确定就先
  stage_get_state 验证场景内容。
- 汇报结果时引用工具返回的文件路径与对象 ID，方便用户在界面上对照。
