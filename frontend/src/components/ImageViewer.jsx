import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';

const MIN_SCALE = 0.5;
const MAX_SCALE = 32; // 高倍缩放：400px 影像下单个像素约占 32 屏幕像素，可逐像素标注
const FIT_PADDING = 0.92; // 影像适配容器时的留白比例
const WHEEL_SPEED = 0.0015; // 滚轮缩放灵敏度
const ZOOM_STEP = 1.25; // HUD 按钮 / 键盘 +/- 的步进倍率
const PIXELATED_ABOVE = 2; // 屏幕 px / 影像 px 超过该值时启用像素化渲染（属性可继承到 img/canvas 子层）
const MIN_VISIBLE = 80; // 平移约束：影像至少保留这么多像素在容器内
const MINIMAP_WIDTH = 120; // 小地图宽度（px）

/**
 * 缩放位置缓存：persistKey → { cx, cy, scale }（影像坐标下的视口中心 + 缩放倍数）。
 * 推理 / 保存会因视图 key 变化重挂载查看器，缓存让高倍缩放位置得以延续；换样本（key 变化）自然回到适配视图。
 */
const viewCache = new Map();

/**
 * 黑底影像查看器（4 个任务共用骨架）。
 * 图层堆叠 = 输入影像 + N 张掩膜叠加层（各自受可见性 / 全局不透明度控制）。
 * 缩放平移：滚轮以光标为中心缩放（0.5~32x）；拖动（左键 / 中键 / 右键）平移，画笔模式下
 * 左键留给 PaintLayer，用空格按住 / 中键 / 右键平移；高倍时自动显示左下角小地图导航；
 * 影像始终至少保留 MIN_VISIBLE px 在容器内；传 persistKey 时跨重挂载保持缩放位置。
 *
 * @param {{
 *   baseSrc: string|null,   // 底层输入影像 URL（决定画布几何）
 *   overlays?: Array<{key: string, src: string, visible: boolean, opacity: number}>, // 掩膜叠加层
 *   loading?: boolean,      // 推理运行中 → 显示骨架屏
 *   hint?: string,          // 影像下方的浮动提示文案
 *   emptyText?: string,     // 无影像时的占位文案
 *   stageExtra?: import('react').ReactNode, // 与影像一同缩放平移的附加层（如边界曲线 canvas）
 *   hudExtra?: import('react').ReactNode,   // 不随缩放变化的浮动 HUD（如 enface 小地图）
 *   onBaseLoad?: (dims: {w: number, h: number}) => void, // 底图加载完成回调（返回原始像素尺寸）
 *   paintMode?: boolean,    // 标注画笔激活：左键留给 PaintLayer（空格/中键/右键仍可平移）
 *   persistKey?: string,    // 缩放位置缓存键（如 `${task.id}-${sampleId}`）；缺省不缓存
 * }} props
 */
export default function ImageViewer({
  baseSrc,
  overlays = [],
  loading = false,
  hint,
  emptyText = '暂无影像',
  stageExtra,
  hudExtra,
  onBaseLoad,
  paintMode = false,
  persistKey,
}) {
  const containerRef = useRef(null);
  const minimapRef = useRef(null);
  const dragRef = useRef(null);
  const restoredRef = useRef(false); // persistKey 缓存是否已恢复（每次挂载只恢复一次）
  const [box, setBox] = useState(null); // 容器内容区尺寸
  const [dims, setDims] = useState(null); // 输入影像原始像素尺寸
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });

  // 跟踪容器尺寸，用于按 contain 方式适配影像
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      setBox({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** 影像的基础显示比例（px / 原始 px） */
  const fitScale = useMemo(() => {
    if (!box || !dims || box.w <= 0 || box.h <= 0) return null;
    return Math.min(box.w / dims.w, box.h / dims.h) * FIT_PADDING;
  }, [box, dims]);

  /** 约束平移量：变换后的影像至少保留 MIN_VISIBLE px 在容器内，避免被拖丢 */
  const clampView = useCallback(
    next => {
      if (!box || !dims || !fitScale) return next;
      const halfW = (dims.w * fitScale * next.scale) / 2;
      const halfH = (dims.h * fitScale * next.scale) / 2;
      const loX = MIN_VISIBLE - box.w / 2 - halfW;
      const hiX = box.w / 2 + halfW - MIN_VISIBLE;
      const loY = MIN_VISIBLE - box.h / 2 - halfH;
      const hiY = box.h / 2 + halfH - MIN_VISIBLE;
      return {
        scale: next.scale,
        x: Math.min(Math.max(next.x, loX), hiX),
        y: Math.min(Math.max(next.y, loY), hiY),
      };
    },
    [box, dims, fitScale],
  );

  /** 缩放/平移统一入口：套用约束并写入 persistKey 缓存 */
  const updateView = useCallback(
    updater => {
      setView(prev => {
        const next = clampView(typeof updater === 'function' ? updater(prev) : updater);
        if (persistKey && dims && fitScale && box) {
          // 视口中心换算回影像坐标：p = c - t/s（容器局部）→ 除以 fitScale
          viewCache.set(persistKey, {
            cx: (box.w / 2 - next.x / next.scale) / fitScale,
            cy: (box.h / 2 - next.y / next.scale) / fitScale,
            scale: next.scale,
          });
        }
        return next;
      });
    },
    [clampView, persistKey, dims, fitScale, box],
  );

  const resetView = useCallback(() => updateView({ scale: 1, x: 0, y: 0 }), [updateView]);

  /** 以容器中心相对坐标 (kx, ky) 为锚点缩放到 nextScale（k 缺省 = 0 即视口中心） */
  const zoomTo = useCallback(
    (nextScale, kx = 0, ky = 0) => {
      updateView(prev => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
        const ratio = next / prev.scale;
        // 保持锚点下的内容点不动：t' = k - (s'/s)(k - t)
        return { scale: next, x: kx - ratio * (kx - prev.x), y: ky - ratio * (ky - prev.y) };
      });
    },
    [updateView],
  );

  // persistKey 有缓存时，fitScale 首次就绪后恢复上次的缩放位置
  useEffect(() => {
    if (!persistKey || restoredRef.current || !fitScale || !dims || !box) return;
    restoredRef.current = true;
    const saved = viewCache.get(persistKey);
    if (saved) {
      setView({
        scale: saved.scale,
        x: (box.w / 2 - saved.cx * fitScale) * saved.scale,
        y: (box.h / 2 - saved.cy * fitScale) * saved.scale,
      });
    }
  }, [persistKey, fitScale, dims, box]);

  // 滚轮缩放：React 合成 wheel 事件为 passive，需手动绑定才能 preventDefault
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !fitScale) return undefined;
    const handleWheel = event => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY; // 行模式（Firefox）归一化
      const rect = el.getBoundingClientRect();
      // 光标相对容器中心的偏移
      const kx = event.clientX - rect.left - rect.width / 2;
      const ky = event.clientY - rect.top - rect.height / 2;
      updateView(prev => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * Math.exp(-delta * WHEEL_SPEED)));
        const ratio = next / prev.scale;
        return { scale: next, x: kx - ratio * (kx - prev.x), y: ky - ratio * (ky - prev.y) };
      });
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [fitScale, updateView]);

  // 键盘快捷键：+/- 缩放、0 适应窗口（焦点在输入框或带修饰键时不接管）
  useEffect(() => {
    if (!interactiveGuard(baseSrc, loading) || !fitScale) return undefined;
    const handleKey = event => {
      const el = event.target;
      if (el instanceof HTMLElement && isTypingTarget(el)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomTo(view.scale * ZOOM_STEP);
      } else if (event.key === '-') {
        event.preventDefault();
        zoomTo(view.scale / ZOOM_STEP);
      } else if (event.key === '0') {
        event.preventDefault();
        resetView();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [baseSrc, loading, fitScale, view.scale, zoomTo, resetView]);

  /** @param {import('react').PointerEvent} event 左键（非画笔模式）/ 中键 / 右键均可拖动平移 */
  const handlePointerDown = event => {
    if (!baseSrc || loading) return;
    const leftPan = event.button === 0 && !paintMode; // 画笔模式下左键留给 PaintLayer
    const auxiliary = event.button === 1 || event.button === 2;
    if (!leftPan && !auxiliary) return;
    if (event.button === 1) event.preventDefault(); // 阻止中键自动滚动
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, lastX: event.clientX, lastY: event.clientY };
  };

  /** @param {import('react').PointerEvent} event */
  const handlePointerMove = event => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    updateView(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  };

  /** @param {import('react').PointerEvent} event */
  const handlePointerEnd = event => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  // ---- 小地图：影像显示尺寸超出容器时出现，展示当前视野框，点击/拖动跳转 ----
  const showMinimap = Boolean(
    baseSrc && dims && box && fitScale && !loading && (
      dims.w * fitScale * view.scale > box.w + 16 || dims.h * fitScale * view.scale > box.h + 16
    ),
  );

  // 视野框在小地图中的位置（百分比，裁剪到 [0,1]）
  const viewportRect = useMemo(() => {
    if (!showMinimap) return null;
    const centerImgX = (box.w / 2 - view.x / view.scale) / fitScale;
    const centerImgY = (box.h / 2 - view.y / view.scale) / fitScale;
    const halfImgW = box.w / 2 / (fitScale * view.scale);
    const halfImgH = box.h / 2 / (fitScale * view.scale);
    const left = Math.max(0, (centerImgX - halfImgW) / dims.w);
    const right = Math.min(1, (centerImgX + halfImgW) / dims.w);
    const top = Math.max(0, (centerImgY - halfImgH) / dims.h);
    const bottom = Math.min(1, (centerImgY + halfImgH) / dims.h);
    return { left: left * 100, top: top * 100, width: Math.max(1, (right - left) * 100), height: Math.max(1, (bottom - top) * 100) };
  }, [showMinimap, box, view, fitScale, dims]);

  /** 小地图点击/拖动：把视野中心设为对应影像坐标 */
  const minimapSeek = event => {
    const el = minimapRef.current;
    if (!el || !dims || !box || !fitScale) return;
    const rect = el.getBoundingClientRect();
    const ix = ((event.clientX - rect.left) / rect.width) * dims.w;
    const iy = ((event.clientY - rect.top) / rect.height) * dims.h;
    updateView({
      scale: view.scale,
      x: (box.w / 2 - ix * fitScale) * view.scale,
      y: (box.h / 2 - iy * fitScale) * view.scale,
    });
  };

  const interactive = Boolean(baseSrc) && !loading;
  const pixelated = Boolean(fitScale && view.scale * fitScale >= PIXELATED_ABOVE);

  // 底图必须无条件渲染：dims 只能在 img onLoad 后获得，
  // 若等 fitScale 就绪再渲染 img 会形成死锁（无 img → 无 onLoad → 无 dims → 无 fitScale）。
  // dims 就绪前先按原始尺寸居中显示，就绪后再套用适配与缩放变换。
  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full select-none overflow-hidden rounded-xl bg-[#0b0f14] ${
        paintMode
          ? 'touch-none'
          : interactive
            ? 'cursor-grab touch-none active:cursor-grabbing'
            : ''
      }`}
      onContextMenu={event => event.preventDefault()} // 右键用于平移
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center p-8">
          <div className="w-full max-w-sm space-y-4">
            <div className="aspect-square w-full animate-pulse rounded-xl bg-white/[0.06]" />
            <div className="mx-auto h-3 w-40 animate-pulse rounded-full bg-white/[0.06]" />
          </div>
        </div>
      ) : baseSrc ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="relative shrink-0"
            style={
              fitScale
                ? {
                    width: dims.w * fitScale,
                    height: dims.h * fitScale,
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    transformOrigin: 'center',
                    willChange: 'transform',
                    imageRendering: pixelated ? 'pixelated' : 'auto', // 可继承：底图/掩膜/canvas 高倍下均呈像素块
                  }
                : { maxWidth: '100%', maxHeight: '100%' }
            }
          >
            <img
              src={baseSrc}
              alt="输入影像"
              draggable={false}
              className="block h-full w-full"
              onLoad={event => {
                const next = { w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight };
                setDims(prev => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
                onBaseLoad?.(next);
              }}
            />
            {overlays.map(overlay => (
              /* 掩膜是白底黑背景灰度图：用 luminance mask 以类别色着色渲染 */
              <div
                key={overlay.key}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full"
                style={{
                  backgroundColor: overlay.color || '#ffffff',
                  WebkitMaskImage: `url("${overlay.src}")`,
                  maskImage: `url("${overlay.src}")`,
                  WebkitMaskSize: '100% 100%',
                  maskSize: '100% 100%',
                  WebkitMaskMode: 'luminance',
                  maskMode: 'luminance',
                  opacity: overlay.visible ? overlay.opacity : 0,
                }}
              />
            ))}
            {stageExtra}
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-slate-500">{emptyText}</p>
        </div>
      )}

      {/* 左上角：缩放步进 + 百分比 + 适应 + 1:1 */}
      {interactive && (
        <div
          className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg bg-black/60 px-1.5 py-1 text-xs tabular-nums text-slate-200 backdrop-blur-sm"
          onPointerDown={event => event.stopPropagation()}
        >
          <button
            type="button"
            title="缩小（-）"
            onClick={() => zoomTo(view.scale / ZOOM_STEP)}
            className="rounded p-1 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[44px] text-center">{Math.round(view.scale * 100)}%</span>
          <button
            type="button"
            title="放大（+）"
            onClick={() => zoomTo(view.scale * ZOOM_STEP)}
            className="rounded p-1 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <span className="mx-0.5 h-4 w-px bg-white/15" />
          <button
            type="button"
            title="适应窗口（0）"
            onClick={resetView}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="h-3 w-3" /> 适应
          </button>
          <button
            type="button"
            title="按原始像素显示（1:1）"
            onClick={() => zoomTo(1 / fitScale)}
            disabled={!fitScale}
            className="rounded px-1.5 py-0.5 text-slate-300 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            1:1
          </button>
        </div>
      )}

      {/* 左下角：小地图导航（右下角留给各视图自带的 hudExtra，如 faz3d 的 enface 小地图） */}
      {showMinimap && (
        <div
          className="absolute bottom-3 left-3 z-10 rounded-lg border border-white/15 bg-black/60 p-1.5 backdrop-blur-sm"
          onPointerDown={event => event.stopPropagation()}
        >
          <div
            ref={minimapRef}
            className="relative cursor-pointer overflow-hidden rounded-md touch-none"
            onPointerDown={event => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              minimapSeek(event);
            }}
            onPointerMove={event => {
              if (event.buttons & 1) minimapSeek(event);
            }}
          >
            <img
              src={baseSrc}
              alt="导航小地图"
              draggable={false}
              style={{ width: MINIMAP_WIDTH }}
              className="block"
            />
            {viewportRect && (
              <div
                className="absolute border border-blue-400 bg-blue-400/10 shadow-[0_0_6px_rgba(59,130,246,0.6)]"
                style={{
                  left: `${viewportRect.left}%`,
                  top: `${viewportRect.top}%`,
                  width: `${viewportRect.width}%`,
                  height: `${viewportRect.height}%`,
                }}
              />
            )}
          </div>
        </div>
      )}

      {hudExtra}

      {hint && !loading && baseSrc && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/60 px-3 py-1 text-xs text-slate-300 backdrop-blur-sm">
          {hint}
        </div>
      )}
    </div>
  );
}

function isTypingTarget(el) {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function interactiveGuard(baseSrc, loading) {
  return Boolean(baseSrc) && !loading;
}
