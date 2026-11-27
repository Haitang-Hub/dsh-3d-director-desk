import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BackSide,
  ClampToEdgeWrapping,
  Color,
  EquirectangularReflectionMapping,
  LinearFilter,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import type { DirectorAssetRef, PanoramaProjectionMode } from "../schema/directorProject";
import { useResolvedLocalAssetUrl } from "../loaders/useResolvedLocalAssetUrl";
import { getPanoramaRotationRadians } from "./panoramaMath";

type PanoramaTextureState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; texture: Texture }
  | { status: "error"; error: Error };

export function configurePanoramaTexture(texture: Texture, projectionMode: PanoramaProjectionMode = "equirectangular") {
  texture.colorSpace = SRGBColorSpace;
  if (projectionMode === "equirectangular") {
    texture.mapping = EquirectangularReflectionMapping;
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
  } else {
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.repeat.set(-1, 1);
    texture.offset.set(1, 0);
  }
  texture.needsUpdate = true;
  return texture;
}

function toTextureLoadError(error: unknown) {
  if (error instanceof Error) return error;
  return new Error("全景图纹理加载失败");
}

function usePanoramaTexture(url: string | null, projectionMode: PanoramaProjectionMode): PanoramaTextureState {
  const [state, setState] = useState<PanoramaTextureState>({ status: "idle" });

  useEffect(() => {
    if (!url) {
      setState({ status: "idle" });
      return undefined;
    }

    let cancelled = false;
    setState({ status: "loading" });

    let texture: Texture | null = null;

    try {
      texture = new TextureLoader().load(
        url,
        (loadedTexture) => {
          if (cancelled) {
            loadedTexture.dispose();
            return;
          }

          setState({ status: "ready", texture: configurePanoramaTexture(loadedTexture, projectionMode) });
        },
        undefined,
        (error) => {
          if (!cancelled) {
            setState({ status: "error", error: toTextureLoadError(error) });
          }
        }
      );
    } catch (error) {
      setState({ status: "error", error: toTextureLoadError(error) });
    }

    return () => {
      cancelled = true;
      texture?.dispose();
    };
  }, [projectionMode, url]);

  return state;
}

export function ViewportBackground({
  backgroundColor,
  backgroundBrightness = 1,
  panoramaAsset,
  panoramaRadius,
  panoramaYaw,
}: {
  backgroundColor: string;
  backgroundBrightness?: number;
  panoramaAsset?: DirectorAssetRef | null;
  panoramaRadius: number;
  panoramaYaw: number;
}) {
  const { gl, scene } = useThree();
  const projectionMode = panoramaAsset?.projectionMode ?? "equirectangular";
  const resolvedPanoramaUrl = useResolvedLocalAssetUrl(panoramaAsset ?? undefined);
  const textureState = usePanoramaTexture(resolvedPanoramaUrl ?? null, projectionMode);
  const safeRadius = Math.max(10, panoramaRadius);
  const rotationY = getPanoramaRotationRadians(panoramaYaw);
  const fallbackColor = useMemo(
    () => new Color(backgroundColor).multiplyScalar(Math.max(0, backgroundBrightness)),
    [backgroundBrightness, backgroundColor]
  );
  const panoramaBrightness = useMemo(
    () => new Color("#ffffff").multiplyScalar(Math.max(0, backgroundBrightness)),
    [backgroundBrightness]
  );
  // 天空色按帧插值，主题/亮度变化时是渐变过去而不是瞬切
  const animatedColorRef = useRef(new Color(backgroundColor));
  const animatedOnceRef = useRef(false);
  const panoramaTexture = textureState.status === "ready" && projectionMode === "equirectangular"
    ? textureState.texture
    : null;

  useEffect(() => {
    scene.background = panoramaTexture ?? animatedColorRef.current;
    scene.backgroundBlurriness = 0;
    scene.backgroundIntensity = Math.max(0, backgroundBrightness);
    scene.backgroundRotation.set(0, panoramaTexture ? rotationY : 0, 0);
  }, [backgroundBrightness, gl, panoramaTexture, rotationY, scene, textureState]);

  useFrame((_, delta) => {
    const current = animatedColorRef.current;
    if (!animatedOnceRef.current) {
      current.copy(fallbackColor);
      animatedOnceRef.current = true;
    } else {
      current.lerp(fallbackColor, 1 - Math.exp(-6 * Math.min(delta, 0.1)));
    }

    if (!panoramaTexture) scene.background = current;
    gl.setClearColor(current, 1);
  });

  return (
    <>
      {textureState.status === "ready" && projectionMode === "backdrop" ? (
        <mesh
          frustumCulled={false}
          name="panorama-backdrop-dome"
          renderOrder={-1000}
          rotation={[0, rotationY, 0]}
        >
          <sphereGeometry args={[safeRadius, 96, 64]} />
          <meshBasicMaterial
            color={panoramaBrightness}
            depthWrite={false}
            map={textureState.texture}
            side={BackSide}
            toneMapped={false}
          />
        </mesh>
      ) : null}
      {textureState.status === "error" ? (
        <Html center>
          <div className="viewport-error-card" role="status">
            <strong>全景图加载失败</strong>
            <span>请重新导入 JPG / PNG / WEBP 图片</span>
          </div>
        </Html>
      ) : null}
    </>
  );
}
