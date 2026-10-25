/**
 * 导演台 MCP 工具表：单一事实来源。
 * 工具名/入参以 web 端 runDirectorTool 的 switch-case 为准提取；
 * web 端通过复制 + dv 版本号对齐（保持项目独立）。
 *
 * timeoutClass 决定桥的分级超时（见 修改方案 7.3）：
 *   state  10s  纯状态读写
 *   render 120s 单帧截图渲染
 *   export 600s 成片导出
 * browserRequired 工具依赖浏览器 three.js 实时渲染，executor 离线时不能执行。
 */

const STATE_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 120_000;
const EXPORT_TIMEOUT_MS = 600_000;

/** 摆放类公共字段：位置/朝向/缩放（未给的字段沿用对象当前值）。 */
const placementProperties = {
    name: { type: "string", description: "对象显示名" },
    x: { type: "number", description: "世界坐标 X" },
    y: { type: "number", description: "世界坐标 Y（高度）" },
    z: { type: "number", description: "世界坐标 Z" },
    rotation: { type: "number", description: "绕 Y 轴朝向角（度）" },
    scale: { type: "number", description: "等比缩放倍数（0.05 起）" },
};

const cameraSelectorProperties = {
    cameraId: { type: "string", description: "目标机位 ID；缺省为活动机位" },
};

export const TOOLS = [
    {
        name: "stage_get_state",
        group: "stage",
        timeoutClass: "state",
        description: "读取当前场景状态：对象列表（含位置）、机位列表（含关键帧数）、活动机位。开始编排前先调用它了解现状。",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "stage_add_model",
        group: "stage",
        timeoutClass: "state",
        description: "从模型库添加模型到场景（内置人模/道具库或已有资产），可同时指定摆放位置与朝向。",
        inputSchema: {
            type: "object",
            properties: {
                assetId: { type: "string", description: "模型库资产 ID（用 stage_list_presets 查询 library）" },
                name: { type: "string", description: "模型名或对象名（按名称模糊匹配模型库）" },
                ...placementProperties,
            },
        },
    },
    {
        name: "stage_clear_scene",
        group: "stage",
        timeoutClass: "state",
        description: "清空场景：删除全部角色与道具（机位默认保留）。破坏性操作。",
        inputSchema: {
            type: "object",
            properties: {
                keepCameras: { type: "boolean", description: "是否保留机位，默认 true" },
            },
        },
    },
    {
        name: "stage_list_presets",
        group: "stage",
        timeoutClass: "state",
        description: "列出可用预设：姿势、动作、几何体、模型库、运镜模板、运镜节奏、可跟踪身体部位。摆场/运镜前用它查询合法取值。",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "stage_place_character",
        group: "stage",
        timeoutClass: "state",
        description: "放置一个角色（人模），可指定姿势预设与摆放位置。",
        inputSchema: {
            type: "object",
            properties: {
                bodyType: { type: "string", description: "体型（缺省用默认体型）" },
                pose: { type: "string", description: "姿势预设 ID（用 stage_list_presets 查询 poses）" },
                ...placementProperties,
            },
        },
    },
    {
        name: "stage_place_prop",
        group: "stage",
        timeoutClass: "state",
        description: "放置一个几何体道具（box/sphere/cylinder/torus/cone/pyramid）。",
        inputSchema: {
            type: "object",
            properties: {
                geometryType: { type: "string", enum: ["box", "sphere", "cylinder", "torus", "cone", "pyramid"], description: "几何体类型" },
                ...placementProperties,
            },
            required: ["geometryType"],
        },
    },
    {
        name: "stage_update_object",
        group: "stage",
        timeoutClass: "state",
        description: "更新场景对象：位置/朝向/缩放、名称、颜色、可见性、锁定、姿势、动作或姿势细调参数。",
        inputSchema: {
            type: "object",
            properties: {
                objectId: { type: "string", description: "目标对象 ID（用 stage_get_state 查询）" },
                color: { type: "string", description: "颜色（CSS 颜色值）" },
                visible: { type: "boolean", description: "是否可见" },
                locked: { type: "boolean", description: "是否锁定" },
                pose: { type: "string", description: "姿势预设 ID" },
                action: { type: ["string", "null"], description: "动作预设 ID；null 清除动作" },
                poseControls: { type: "object", additionalProperties: { type: "number" }, description: "姿势细调参数键值对" },
                ...placementProperties,
            },
            required: ["objectId"],
        },
    },
    {
        name: "stage_remove_object",
        group: "stage",
        timeoutClass: "state",
        description: "从场景删除一个对象。破坏性操作。",
        inputSchema: {
            type: "object",
            properties: { objectId: { type: "string", description: "要删除的对象 ID" } },
            required: ["objectId"],
        },
    },
    {
        name: "camera_set_keyframe",
        group: "camera",
        timeoutClass: "state",
        description: "在机位运动路径上追加一个相机关键帧（记录当前时刻的机位状态），可指定时间点。",
        inputSchema: {
            type: "object",
            properties: {
                ...cameraSelectorProperties,
                time: { type: "number", description: "关键帧时间点（秒）" },
            },
        },
    },
    {
        name: "camera_update_keyframe",
        group: "camera",
        timeoutClass: "state",
        description: "修改相机关键帧：位置、注视目标、FOV、时间、缓动、停留行为或跟踪主体。",
        inputSchema: {
            type: "object",
            properties: {
                cameraId: { type: "string", description: "机位 ID" },
                keyframeId: { type: "string", description: "关键帧 ID（用 camera_get_trajectory 查询）" },
                targetX: { type: "number", description: "注视目标 X" },
                targetY: { type: "number", description: "注视目标 Y" },
                targetZ: { type: "number", description: "注视目标 Z" },
                fov: { type: "number", description: "视场角" },
                time: { type: "number", description: "时间点（秒）" },
                easing: { type: "string", enum: ["linear", "ease-in-out"], description: "缓动" },
                pointBehavior: { type: "string", enum: ["pass", "hold"], description: "经过或停留" },
                holdSeconds: { type: "number", description: "停留秒数（pointBehavior=hold 时）" },
                targetMode: { type: "string", enum: ["manual", "object"], description: "注视目标模式：手动坐标或跟踪对象" },
                subjectObjectId: { type: "string", description: "跟踪对象 ID（targetMode=object 时）" },
                targetBodyPart: { type: "string", description: "跟踪身体部位（用 stage_list_presets 查询 cameraBodyParts）" },
                targetFollowMode: { type: "string", enum: ["immediate", "smooth"], description: "跟踪响应方式" },
            },
            required: ["cameraId", "keyframeId"],
        },
    },
    {
        name: "camera_delete_keyframe",
        group: "camera",
        timeoutClass: "state",
        description: "删除机位上的一个相机关键帧。破坏性操作。",
        inputSchema: {
            type: "object",
            properties: {
                cameraId: { type: "string", description: "机位 ID" },
                keyframeId: { type: "string", description: "关键帧 ID" },
            },
            required: ["cameraId", "keyframeId"],
        },
    },
    {
        name: "camera_apply_preset",
        group: "camera",
        timeoutClass: "state",
        description: "对机位应用运镜模板（推拉摇移等预设轨迹），可围绕跟踪主体自动生成关键帧。会覆盖该机位现有轨迹。",
        inputSchema: {
            type: "object",
            properties: {
                ...cameraSelectorProperties,
                templateId: { type: "string", description: "运镜模板 ID（用 stage_list_presets 查询 motionTemplates）" },
                subjectObjectId: { type: "string", description: "跟踪主体对象 ID（可选）" },
                range: { type: "number", description: "轨迹幅度缩放（0.25-3，默认 1）" },
                targetBodyPart: { type: "string", description: "跟踪身体部位（默认角色为 chest）" },
                targetFollowMode: { type: "string", enum: ["immediate", "smooth"], description: "跟踪响应方式（默认 smooth）" },
            },
            required: ["templateId"],
        },
    },
    {
        name: "camera_set_pacing",
        group: "camera",
        timeoutClass: "state",
        description: "调整机位轨迹节奏：总时长、插值方式、缓动或预设节奏（uniform/soft/custom 族）。",
        inputSchema: {
            type: "object",
            properties: {
                ...cameraSelectorProperties,
                presetId: { type: "string", description: "节奏预设 ID（用 stage_list_presets 查询 motionTiming）" },
                duration: { type: "number", description: "轨迹总时长（秒）" },
                interpolation: { type: "string", enum: ["linear", "smooth"], description: "插值方式" },
                easing: { type: "string", enum: ["linear", "ease-in-out"], description: "缓动" },
                speedMode: { type: "string", enum: ["uniform", "soft", "custom"], description: "速度模式" },
            },
        },
    },
    {
        name: "camera_set_pose",
        group: "camera",
        timeoutClass: "state",
        description: "直接设置机位位姿（位置/注视目标/FOV）并设为活动机位；未给的字段沿用当前值。调好视角后配合 camera_set_keyframe 逐帧记录轨迹。",
        inputSchema: {
            type: "object",
            properties: {
                ...cameraSelectorProperties,
                targetX: { type: "number", description: "注视目标 X" },
                targetY: { type: "number", description: "注视目标 Y" },
                targetZ: { type: "number", description: "注视目标 Z" },
                fov: { type: "number", description: "视场角" },
            },
        },
    },
    {
        name: "camera_get_trajectory",
        group: "camera",
        timeoutClass: "state",
        description: "读取全部机位的运动轨迹（关键帧位置/目标/时间），用于查看路线或查询 keyframeId。",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "preview_render_frame",
        group: "preview",
        timeoutClass: "render",
        browserRequired: true,
        description: "渲染指定机位在当前时刻的干净单帧并保存 PNG，返回文件名与尺寸（不含 base64，除非 includeData=true）。需要导演台页面在线。",
        inputSchema: {
            type: "object",
            properties: {
                position: { type: "string", enum: ["current", "first", "last"], description: "取哪个机位视角，默认 current" },
                quality: { type: "string", enum: ["720p", "1080p"], description: "分辨率，默认 1080p" },
                includeData: { type: "boolean", description: "是否在结果中内联 base64 图片数据（大，慎用）" },
                fileName: { type: "string", description: "保存文件名" },
            },
        },
    },
    {
        name: "preview_export_animatic",
        group: "preview",
        timeoutClass: "export",
        browserRequired: true,
        description: "导出预演成片 MP4（沿活动机位轨迹渲染）。耗时可达数分钟；活动机位轨迹至少需要 2 个关键帧。需要导演台页面在线。",
        inputSchema: {
            type: "object",
            properties: {
                fileName: { type: "string", description: "导出文件名" },
                fps: { type: "number", enum: [24, 30, 60], description: "帧率，默认 30" },
                quality: { type: "string", enum: ["720p", "1080p"], description: "分辨率，默认 720p" },
            },
        },
    },
];

const TIMEOUT_MS = { state: STATE_TIMEOUT_MS, render: RENDER_TIMEOUT_MS, export: EXPORT_TIMEOUT_MS };

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export function getTool(name) {
    return TOOLS.find((tool) => tool.name === name) || null;
}

export function toolTimeoutMs(name) {
    return TIMEOUT_MS[getTool(name)?.timeoutClass] || STATE_TIMEOUT_MS;
}

/** MCP tools/list 用的精简形态。 */
export function mcpToolList() {
    return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
