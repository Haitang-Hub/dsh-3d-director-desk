import { palette } from "@/lib/design-tokens";

export type SceneTheme = "light" | "dark";

/**
 * 天空 / 地面随明暗主题切换的默认配色。
 * 深色沿用项目原有的黑天空 + 深灰地面，浅色取 DSH 冷调中性灰，
 * 保证浅色界面下视口不再是一块黑底。
 */
export const SCENE_THEME_COLORS: Record<SceneTheme, { sky: string; ground: string }> = {
  light: { sky: palette.neutralBluish55, ground: palette.neutralBluish300 },
  dark: { sky: "#000000", ground: "#303640" },
};

/** 纯黑 / 纯白视为「未自定义」的历史默认值，跟随主题一起切换。 */
const LEGACY_AUTO_COLORS = ["#000000", "#ffffff"];

function isThemeDefaultColor(value: string, key: "sky" | "ground") {
  const normalized = value.toLowerCase();
  return (
    normalized === SCENE_THEME_COLORS.light[key]
    || normalized === SCENE_THEME_COLORS.dark[key]
    || LEGACY_AUTO_COLORS.includes(normalized)
  );
}

/**
 * 主题切换时同步天空 / 地面颜色：
 * 只有仍停留在「主题默认色」的通道才跟随新主题，用户手动调过的颜色保持不变。
 */
export function getThemeSceneColorPatch(
  scene: { backgroundColor: string; groundColor: string },
  theme: SceneTheme
) {
  const target = SCENE_THEME_COLORS[theme];
  const patch: { backgroundColor?: string; groundColor?: string } = {};

  if (isThemeDefaultColor(scene.backgroundColor, "sky") && scene.backgroundColor.toLowerCase() !== target.sky) {
    patch.backgroundColor = target.sky;
  }

  if (isThemeDefaultColor(scene.groundColor, "ground") && scene.groundColor.toLowerCase() !== target.ground) {
    patch.groundColor = target.ground;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
