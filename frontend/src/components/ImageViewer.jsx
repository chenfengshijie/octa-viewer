import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const FIT_PADDING = 0.92; // 影像适配容器时的留白比例
const WHEEL_SPEED = 0.0015; // 滚轮缩放灵敏度

/**
 * 黑底影像查看器（4 个任务共用骨架）。
 * 图层堆叠 = 输入影像 + N 张掩膜叠加层（各自受可见性 / 全局不透明度控制）；
 * 支持滚轮以光标为中心缩放（0.5~8x）与拖拽平移。
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
}) {
  const containerRef = useRef(null);
  const dragRef = useRef(null);
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

  const resetView = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);

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
      setView(prev => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * Math.exp(-delta * WHEEL_SPEED)));
        const ratio = next / prev.scale;
        // 保持光标下的内容点不动：t' = k - (s'/s)(k - t)
        return { scale: next, x: kx - ratio * (kx - prev.x), y: ky - ratio * (ky - prev.y) };
      });
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [fitScale]);

  /** @param {import('react').PointerEvent} event */
  const handlePointerDown = event => {
    if (event.button !== 0 || !baseSrc) return;
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
    setView(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  };

  /** @param {import('react').PointerEvent} event */
  const handlePointerEnd = event => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const interactive = Boolean(baseSrc) && !loading;

  // 底图必须无条件渲染：dims 只能在 img onLoad 后获得，
  // 若等 fitScale 就绪再渲染 img 会形成死锁（无 img → 无 onLoad → 无 dims → 无 fitScale）。
  // dims 就绪前先按原始尺寸居中显示，就绪后再套用适配与缩放变换。
  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full select-none overflow-hidden rounded-xl bg-[#0b0f14] ${
        interactive ? 'cursor-grab touch-none active:cursor-grabbing' : ''
      }`}
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

      {/* 左上角：缩放百分比 + 重置 */}
      {interactive && (
        <div
          className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-lg bg-black/60 px-2 py-1 text-xs tabular-nums text-slate-200 backdrop-blur-sm"
          onPointerDown={event => event.stopPropagation()}
        >
          <span className="min-w-[38px] text-center">{Math.round(view.scale * 100)}%</span>
          <button
            type="button"
            onClick={resetView}
            title="重置视图"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="h-3 w-3" /> 重置
          </button>
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
