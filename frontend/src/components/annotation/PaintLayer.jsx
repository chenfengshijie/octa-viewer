import { useEffect, useRef } from 'react';

/**
 * 编辑模式的掩膜渲染 + 画笔交互层。经 ImageViewer 的 stageExtra 进入缩放平移容器，
 * 逻辑坐标 = 影像原始像素坐标（与 LayersView 的边界曲线 canvas 同一约定）。
 *
 * 渲染：把各 key 的工作掩膜按类别色合成为一张 ImageData（后写的类别覆盖先写的）。
 * 绘制：editing 时接管指针事件（阻止冒泡避免触发 ImageViewer 平移），
 *       屏幕坐标经 getBoundingClientRect 线性映射回影像像素坐标。
 *
 * @param {{
 *   dims: {w: number, h: number},
 *   entries: Array<{key: string, data: Uint8Array, color: string}>, // 待渲染的掩膜（按叠放顺序）
 *   version: number,          // 编辑器版本号，变更触发重绘
 *   opacity: number,
 *   editing: boolean,
 *   tool: 'brush'|'eraser'|'pan',
 *   brushSize: number,        // 笔刷直径（影像像素）
 *   activeKey: string,        // 当前绘制目标（类别 key 或切片号）
 *   editor: object,           // useMaskEditor 返回值
 *   onFirstChange?: () => void,
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
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(null); // {x, y} 影像坐标的上一采样点

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

  const applyPaint = event => {
    const p = toImage(event);
    const prev = drawingRef.current;
    editor.stroke(
      activeKey,
      prev ? prev.x : p.x,
      prev ? prev.y : p.y,
      p.x,
      p.y,
      Math.max(0.5, brushSize / 2),
      tool === 'eraser',
    );
    drawingRef.current = p;
    onFirstChange?.();
  };

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full touch-none"
      style={{
        opacity,
        pointerEvents: paintActive ? 'auto' : 'none',
        cursor: paintActive ? (tool === 'eraser' ? 'cell' : 'crosshair') : 'default',
      }}
      onPointerDown={event => {
        if (!paintActive || event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        editor.beginStroke(activeKey);
        drawingRef.current = null;
        applyPaint(event);
      }}
      onPointerMove={event => {
        if (!paintActive || !drawingRef.current) return;
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
    />
  );
}

function hexRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
