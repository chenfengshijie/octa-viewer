import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { ViewerInteractionContext } from './annotation/viewerInteraction.js';
import { useCoarsePointer } from '../hooks/useMediaQuery.js';

const MIN_SCALE = 0.5;
const MAX_SCALE = 32; // 高倍缩放：400px 影像下单个像素约占 32 屏幕像素，可逐像素标注
const FIT_PADDING = 0.92; // 影像适配容器时的留白比例
const WHEEL_SPEED = 0.0015; // 滚轮缩放灵敏度
const ZOOM_STEP = 1.25; // HUD 按钮 / 键盘 +/- 的步进倍率
const PIXELATED_ABOVE = 2; // 屏幕 px / 影像 px 超过该值时启用像素化渲染（属性可继承到 img/canvas 子层）
const MIN_VISIBLE = 80; // 平移约束：影像至少保留这么多像素在容器内
const MINIMAP_WIDTH = 120; // 小地图宽度（px）
const MINIMAP_WIDTH_TOUCH = 160; // 触屏端小地图宽度（px）：手指导航需要更大的可点区域

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
 *   overlays?: Array<{key: string, src: string, color: string, visible: boolean, opacity: number}>, // 灰度掩膜叠加层（按 color 着色）
 *   loading?: boolean,      // 推理运行中 → 显示骨架屏
 *   hint?: string,          // 影像下方的浮动提示文案
 *   emptyText?: string,     // 无影像时的占位文案
 *   stageExtra?: import('react').ReactNode, // 与影像一同缩放平移的附加层（如边界曲线 canvas）
 *   hudExtra?: import('react').ReactNode,   // 不随缩放变化的浮动 HUD（如 enface 小地图）
 *   onBaseLoad?: (dims: {w: number, h: number}) => void, // 底图加载完成回调（返回原始像素尺寸）
 *   paintMode?: boolean,    // 标注画笔激活：左键留给 PaintLayer（空格/中键/右键仍可平移）
 *   persistKey?: string,    // 缩放位置缓存键（如 `${task.id}-${sampleId}`）；缺省不缓存
 *   mirror?: boolean,       // 只读镜像：无交互（pointer-events-none）、无 HUD/小地图，变换由 viewOverride 驱动
 *   viewOverride?: {scale: number, x: number, y: number}|null, // 外部控制的视图变换（mirror 面板用）
 *   onViewChange?: (view: {scale: number, x: number, y: number}) => void, // 内部视图变化回调（含缓存恢复）
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
  mirror = false,
  viewOverride = null,
  onViewChange,
}) {
  const containerRef = useRef(null);
  const minimapRef = useRef(null);
  const dragRef = useRef(null);
  const restoredRef = useRef(false); // persistKey 缓存是否已恢复（每次挂载只恢复一次）
  // 触屏手势状态（全部 ref：双指判定必须在第二根手指落下的同一事件循环内同步生效，state 异步更新来不及拦住 PaintLayer）
  const pointersRef = useRef(new Map()); // pointerId → {x, y, type, ignored}
  const interactionRef = useRef({ twoFinger: false, penActive: false, cancelPaint: null }); // 经 context 下发给 PaintLayer
  const coarse = useCoarsePointer(); // 主输入为触摸（手机/平板）：HUD 命中区加大、小地图放大上移
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

  // 内部视图变化上报（含 persistKey 缓存恢复），供镜像面板同步
  useEffect(() => {
    if (mirror) return;
    onViewChange?.(view);
  }, [mirror, view, onViewChange]);

  // 滚轮缩放：React 合成 wheel 事件为 passive，需手动绑定才能 preventDefault；镜像面板不接管
  useEffect(() => {
    if (mirror) return undefined;
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
  }, [mirror, fitScale, updateView]);

  // 键盘快捷键：+/- 缩放、0 适应窗口（焦点在输入框或带修饰键时不接管；镜像面板不接管）
  useEffect(() => {
    if (mirror || !interactiveGuard(baseSrc, loading) || !fitScale) return undefined;
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
  }, [mirror, baseSrc, loading, fitScale, view.scale, zoomTo, resetView]);

  // ---- 触屏手势（捕获阶段统一跟踪，先于 PaintLayer 的画布事件执行）----
  /** 事件是否来自 HUD 元素（缩放按钮 / 小地图等自管交互：不参与手势、不抢指针捕获，否则会破坏按钮点击） */
  const inHud = event => event.target instanceof Element && event.target.closest('[data-viewer-hud]') != null;

  /** @param {import('react').PointerEvent} event 记录指针；第二根非手掌手指落下即进入双指手势 */
  const handlePointerDownCapture = event => {
    if (mirror || !baseSrc || loading || inHud(event)) return;
    const pointers = pointersRef.current;
    const interaction = interactionRef.current;
    if (event.pointerType === 'pen') interaction.penActive = true;
    // 拒触：Pencil 按下期间 touch 一律视为手掌——不绘制、不计入手势
    const ignored = event.pointerType === 'touch' && interaction.penActive;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType, ignored });
    if (ignored) {
      event.stopPropagation(); // 不下发给 PaintLayer，避免手掌误画
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (pointers.size >= 2) {
      // 双指落地 → 进入手势：同步取消刚起的手指半笔，并拦住本事件不让 PaintLayer 起新笔
      interaction.twoFinger = true;
      interaction.cancelPaint?.();
      event.stopPropagation();
    }
  };

  /** @param {import('react').PointerEvent} event 双指手势：质心位移平移 + 指间距比例缩放（锚定质心） */
  const handlePointerMoveCapture = event => {
    if (mirror) return;
    const pointers = pointersRef.current;
    const p = pointers.get(event.pointerId);
    if (!p || p.ignored) return;
    if (!interactionRef.current.twoFinger) {
      p.x = event.clientX;
      p.y = event.clientY;
      return;
    }
    const active = [...pointers.entries()].filter(([, v]) => !v.ignored);
    if (active.length < 2) return;
    const [idA, a] = active[0];
    const [idB, b] = active[1];
    if (event.pointerId !== idA && event.pointerId !== idB) return; // 第三根手指不参与手势
    const na = event.pointerId === idA ? { x: event.clientX, y: event.clientY } : { x: a.x, y: a.y };
    const nb = event.pointerId === idB ? { x: event.clientX, y: event.clientY } : { x: b.x, y: b.y };
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pcx = (a.x + b.x) / 2;
    const pcy = (a.y + b.y) / 2;
    const ncx = (na.x + nb.x) / 2;
    const ncy = (na.y + nb.y) / 2;
    const pdist = Math.hypot(b.x - a.x, b.y - a.y);
    const ndist = Math.hypot(nb.x - na.x, nb.y - na.y);
    // 指尖刚落下（距离过近）时只平移不缩放，避免指距抖动导致画面跳动
    const zoomFactor = pdist >= 8 && ndist >= 8 ? ndist / pdist : 1;
    // 质心相对容器中心的偏移（与滚轮缩放同一坐标系）；平移量与缩放合并进同一次 updateView
    const kx = ncx - rect.left - rect.width / 2;
    const ky = ncy - rect.top - rect.height / 2;
    updateView(prev => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * zoomFactor));
      const ratio = next / prev.scale;
      return {
        scale: next,
        x: kx - ratio * (kx - prev.x) + (ncx - pcx),
        y: ky - ratio * (ky - prev.y) + (ncy - pcy),
      };
    });
    a.x = na.x;
    a.y = na.y;
    b.x = nb.x;
    b.y = nb.y;
  };

  /** @param {import('react').PointerEvent} event 双指手势在最后一根手指抬起后才释放，期间余指保持吞掉防误画 */
  const handlePointerEndCapture = event => {
    const pointers = pointersRef.current;
    const p = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (p?.type === 'pen') {
      interactionRef.current.penActive = [...pointers.values()].some(v => v.type === 'pen');
    }
    if (interactionRef.current.twoFinger && pointers.size === 0) {
      interactionRef.current.twoFinger = false;
    }
  };

  /** @param {import('react').PointerEvent} event 左键（非画笔模式）/ 中键 / 右键均可拖动平移 */
  const handlePointerDown = event => {
    if (mirror) return;
    if (!baseSrc || loading) return;
    if (interactionRef.current.twoFinger) return; // 双指手势期间不再起单指拖动
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
    if (!drag || drag.id !== event.pointerId || interactionRef.current.twoFinger) return;
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
  // 镜像面板：变换由外部 viewOverride 驱动，与主视图完全同步
  const v = viewOverride ?? view;
  const pixelated = Boolean(fitScale && v.scale * fitScale >= PIXELATED_ABOVE);

  // 底图必须无条件渲染：dims 只能在 img onLoad 后获得，
  // 若等 fitScale 就绪再渲染 img 会形成死锁（无 img → 无 onLoad → 无 dims → 无 fitScale）。
  // dims 就绪前先按原始尺寸居中显示，就绪后再套用适配与缩放变换。
  return (
    <ViewerInteractionContext.Provider value={interactionRef.current}>
      <div
        ref={containerRef}
        className={`relative h-full w-full select-none overflow-hidden rounded-xl bg-[#0b0f14] [-webkit-touch-callout:none] ${
          mirror
            ? 'pointer-events-none' // 只读镜像：不接管任何指针/滚轮交互
            : paintMode
              ? 'touch-none'
              : interactive
                ? 'cursor-grab touch-none active:cursor-grabbing'
                : ''
        }`}
        onContextMenu={event => event.preventDefault()} // 右键用于平移
        onPointerDownCapture={handlePointerDownCapture}
        onPointerMoveCapture={handlePointerMoveCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onPointerCancelCapture={handlePointerEndCapture}
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
                    transform: `translate(${v.x}px, ${v.y}px) scale(${v.scale})`,
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
              <MaskOverlay key={overlay.key} src={overlay.src} color={overlay.color} visible={overlay.visible} opacity={overlay.opacity} />
            ))}
            {stageExtra}
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-slate-500">{emptyText}</p>
        </div>
      )}

      {/* 左上角：缩放步进 + 百分比 + 适应 + 1:1（镜像面板不显示）；触屏端加大命中区至 ~40px */}
      {interactive && !mirror && (
        <div
          data-viewer-hud
          className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg bg-black/60 px-1.5 py-1 text-xs tabular-nums text-slate-200 backdrop-blur-sm"
          onPointerDown={event => event.stopPropagation()}
        >
          <button
            type="button"
            title="缩小（-）"
            onClick={() => zoomTo(view.scale / ZOOM_STEP)}
            className="rounded p-1 text-slate-300 transition hover:bg-white/10 hover:text-white coarse:p-2.5"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[44px] text-center">{Math.round(view.scale * 100)}%</span>
          <button
            type="button"
            title="放大（+）"
            onClick={() => zoomTo(view.scale * ZOOM_STEP)}
            className="rounded p-1 text-slate-300 transition hover:bg-white/10 hover:text-white coarse:p-2.5"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <span className="mx-0.5 h-4 w-px bg-white/15" />
          <button
            type="button"
            title="适应窗口（0）"
            onClick={resetView}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-300 transition hover:bg-white/10 hover:text-white coarse:px-3 coarse:py-2"
          >
            <RotateCcw className="h-3 w-3" /> 适应
          </button>
          <button
            type="button"
            title="按原始像素显示（1:1）"
            onClick={() => zoomTo(1 / fitScale)}
            disabled={!fitScale}
            className="rounded px-1.5 py-0.5 text-slate-300 transition hover:bg-white/10 hover:text-white disabled:opacity-40 coarse:px-3 coarse:py-2"
          >
            1:1
          </button>
        </div>
      )}

      {/* 左下角：小地图导航（右下角留给各视图自带的 hudExtra，如 faz3d 的 enface 小地图；镜像面板不显示）。
          触屏端放大尺寸并上移，给悬浮标注工具栏让位 */}
      {showMinimap && !mirror && (
        <div
          data-viewer-hud
          className="absolute bottom-3 left-3 z-10 rounded-lg border border-white/15 bg-black/60 p-1.5 backdrop-blur-sm coarse:bottom-20"
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
              style={{ width: coarse ? MINIMAP_WIDTH_TOUCH : MINIMAP_WIDTH }}
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
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/60 px-3 py-1 text-xs text-slate-300 backdrop-blur-sm coarse:bottom-20">
          {hint}
        </div>
      )}
      </div>
    </ViewerInteractionContext.Provider>
  );
}

/**
 * 灰度掩膜叠加层。掩膜 PNG 不透明（白前景 / 黑背景），这里读进 canvas 把亮度搬到 alpha，
 * 再按类别色填充。不用 CSS mask-mode: luminance：Safari 15.4 之前不支持，会退回 alpha 遮罩，
 * 把整块影像盖成纯色；canvas 方案各引擎表现一致。图片就绪前画布为空（不显示）。
 */
function MaskOverlay({ src, color, visible, opacity }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src) return undefined;
    let alive = true;
    let objectUrl = null;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); // 换图（faz3d 切片）时先清掉上一层
    // 掩膜 URL 会原地更新（保存标注后路径不变）：no-cache 让浏览器每次向服务器确认，
    // 直接 new Image() 会命中启发式缓存、继续显示旧掩膜
    fetch(src, { cache: 'no-cache' })
      .then(res => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(blob => {
        objectUrl = URL.createObjectURL(blob);
        return loadImage(objectUrl);
      })
      .then(img => {
        if (!alive) return;
        const painted = colorizeMask(img, color || '#ffffff');
        if (!painted) return;
        canvas.width = painted.width;
        canvas.height = painted.height;
        canvas.getContext('2d').drawImage(painted, 0, 0);
      })
      .catch(() => {
        /* 加载或解码失败：该层不显示 */
      })
      .finally(() => objectUrl && URL.revokeObjectURL(objectUrl));
    return () => {
      alive = false;
    };
  }, [src, color]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ opacity: visible ? opacity : 0 }}
    />
  );
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
}

/** 灰度掩膜图 -> 按指定颜色着色的画布（亮度即不透明度）；像素不可读（跨域等）时返回 null */
function colorizeMask(img, color) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  try {
    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      px[i + 3] = Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    }
    ctx.putImageData(image, 0, 0);
    ctx.globalCompositeOperation = 'source-in'; // 有掩膜处换成类别色，不透明度沿用亮度
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    return work;
  } catch {
    return null;
  }
}

function isTypingTarget(el) {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function interactiveGuard(baseSrc, loading) {
  return Boolean(baseSrc) && !loading;
}
