import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const MIN_BRUSH = 1;
const MAX_BRUSH = 60;

/**
 * 编辑模式的掩膜渲染 + 画笔交互层。经 ImageViewer 的 stageExtra 进入缩放平移容器，
 * 逻辑坐标 = 影像原始像素坐标（与 LayersView 的边界曲线 canvas 同一约定）。
 *
 * 渲染：把各 key 的工作掩膜按类别色合成为一张 ImageData（后写的类别覆盖先写的）。
 * 绘制：editing 时接管指针事件（左键；中/右键放行给 ImageViewer 平移），
 *       屏幕坐标经 getBoundingClientRect 线性映射回影像像素坐标。
 * 光标：系统光标隐藏，用 portal 到 body 的 fixed 圆环实时预览笔刷大小与落点（直径随缩放换算；
 *       必须 portal —— fixed 元素在带 transform 的祖先内会退化为其定位上下文），直接改 DOM 避免重渲染。
 *
 * @param {{
 *   dims: {w: number, h: number},
 *   entries: Array<{key: string, data: Uint8Array, color: string}>, // 待渲染的掩膜（按叠放顺序）
 *   version: number,          // 编辑器版本号，变更触发重绘
 *   opacity: number,
 *   editing: boolean,         // false 时仅渲染不绘制（视图层在按住空格平移时也会置 false）
 *   tool: 'brush'|'eraser'|'pan',
 *   brushSize: number,        // 笔刷直径（影像像素）
 *   activeKey: string,        // 当前绘制目标（类别 key 或切片号）
 *   editor: object,           // useMaskEditor 返回值
 *   onFirstChange?: () => void,
 *   cursorColor?: string,     // 笔刷光标环颜色（当前类别色），缺省白色
 *   onUndo?: () => void,      // Ctrl+Z
 *   onRedo?: () => void,      // Ctrl+Shift+Z / Ctrl+Y
 *   onBrushSizeChange?: (n: number) => void, // [ / ]
 * }} props
 */
export default function PaintLayer({
  dims,
  entries,
  version,
  opacity,
  editing,
  tool,
  brushSize,
  activeKey,
  editor,
  onFirstChange,
  cursorColor,
  onUndo,
  onRedo,
  onBrushSizeChange,
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(null); // {x, y} 影像坐标的上一采样点
  const ringRef = useRef(null); // 笔刷光标环

  // 掩膜合成渲染
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims?.w) return;
    canvas.width = dims.w;
    canvas.height = dims.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(dims.w, dims.h);
    const buf = img.data;
    for (const entry of entries) {
      if (!entry?.data) continue;
      const [r, g, b] = hexRgb(entry.color);
      const mask = entry.data;
      for (let i = 0; i < dims.w * dims.h; i++) {
        if (!mask[i]) continue;
        buf[i * 4] = r;
        buf[i * 4 + 1] = g;
        buf[i * 4 + 2] = b;
        buf[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [dims, entries, version]);

  // 快捷键：Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销重做，[ / ] 调笔刷大小
  useEffect(() => {
    if (!editing || (!onUndo && !onRedo && !onBrushSizeChange)) return undefined;
    const isTyping = el =>
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    const handleKey = event => {
      if (isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) onRedo?.();
        else onUndo?.();
      } else if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault();
        onRedo?.();
      } else if (!event.ctrlKey && !event.metaKey && (event.key === '[' || event.key === ']')) {
        event.preventDefault();
        const next = event.key === '[' ? brushSize - 1 : brushSize + 1;
        onBrushSizeChange?.(Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, next)));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [editing, brushSize, onUndo, onRedo, onBrushSizeChange]);

  if (!dims?.w) return null;

  const paintActive = editing && tool !== 'pan';

  /** 屏幕坐标 -> 影像像素坐标（CSS transform 下 rect 为变换后的实际矩形，线性映射即可） */
  const toImage = event => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * dims.w,
      y: ((event.clientY - rect.top) / rect.height) * dims.h,
    };
  };

  /** 笔刷光标环：跟随指针，直径按当前缩放实时换算（屏幕 px / 影像 px），微小笔刷保底 8 屏幕 px 可见 */
  const moveRing = event => {
    const ring = ringRef.current;
    const canvas = canvasRef.current;
    if (!ring || !canvas) return;
    const pxPerImg = canvas.getBoundingClientRect().width / dims.w;
    const d = Math.max(8, brushSize * pxPerImg);
    ring.style.width = `${d}px`;
    ring.style.height = `${d}px`;
    ring.style.left = `${event.clientX - d / 2}px`;
    ring.style.top = `${event.clientY - d / 2}px`;
    ring.style.display = 'block';
  };

  const hideRing = () => {
    if (ringRef.current) ringRef.current.style.display = 'none';
  };

  const applyPaint = event => {
    const p = toImage(event);
    const prev = drawingRef.current;
    editor.stroke(
      activeKey,
      prev ? prev.x : p.x,
      prev ? prev.y : p.y,
      p.x,
      p.y,
      Math.max(0.5, brushSize / 2), // brushSize=1 时半径 0.5 ≈ 单像素
      tool === 'eraser',
    );
    drawingRef.current = p;
    onFirstChange?.();
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{
          opacity,
          pointerEvents: paintActive ? 'auto' : 'none',
          cursor: paintActive ? 'none' : 'default', // 系统光标隐藏，由光标环代替
        }}
        onPointerDown={event => {
          if (!paintActive || event.button !== 0) return; // 中/右键不拦截，冒泡给 ImageViewer 平移
          event.stopPropagation();
          hideRing();
          event.currentTarget.setPointerCapture(event.pointerId);
          editor.beginStroke(activeKey);
          drawingRef.current = null;
          applyPaint(event);
        }}
        onPointerMove={event => {
          if (!paintActive) return;
          moveRing(event);
          if (!drawingRef.current) return;
          event.stopPropagation();
          applyPaint(event);
        }}
        onPointerUp={event => {
          drawingRef.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={event => {
          drawingRef.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerLeave={hideRing}
      />
      {paintActive &&
        /* 笔刷光标环：portal 到 body 的 fixed 定位跟随指针（在 transform 祖先内 fixed 会失效），直径已按缩放换算 */
        createPortal(
          <div
            ref={ringRef}
            className="pointer-events-none fixed z-50 hidden rounded-full"
            style={{
              borderWidth: 1.5,
              borderStyle: tool === 'eraser' ? 'dashed' : 'solid',
              borderColor: tool === 'eraser' ? 'rgba(255,255,255,0.85)' : cursorColor || '#ffffff',
              boxShadow: '0 0 1px rgba(0,0,0,0.6)',
            }}
          />,
          document.body,
        )}
    </>
  );
}

function hexRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
