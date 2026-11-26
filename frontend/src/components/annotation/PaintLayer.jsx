import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useViewerInteraction } from './viewerInteraction.js';

const MIN_BRUSH = 1;
const MAX_BRUSH = 60;
const DIM_RATIO = 0.3; // 非当前类别掩膜的弱化透明度比例（当前类别为基准 1.0）
const OUTLINE_LIGHTEN = 0.55; // 描边色：类别色向白色提亮的比例
const RING_LIFT = 48; // 触屏作画时光标环抬离指尖的距离（px），避免手指遮挡落点

/**
 * 编辑模式的掩膜渲染 + 画笔交互层。经 ImageViewer 的 stageExtra 进入缩放平移容器，
 * 逻辑坐标 = 影像原始像素坐标（与 LayersView 的边界曲线 canvas 同一约定）。
 *
 * 渲染：把各 key 的工作掩膜按类别色合成为一张 ImageData（后写的类别覆盖先写的）。
 * 分层：key === activeKey 的当前类别以全量 alpha 填充（showOutline 时外缘再描一圈提亮边），
 *       其余类别 alpha 按 DIM_RATIO 弱化，突出当前绘制目标；当前类别最后合成、盖在最上层，
 *       保证新画的笔画不会被其他类别盖成断线；
 *       canvas 级 opacity 仍是全局滑杆值（作用于所有层）。
 *       对照镜像面板（SegmentationView）只传当前类别的 entry，即可复用同一渲染。
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
 *   showOutline?: boolean,    // 当前类别掩膜外缘描边（边界高亮），缺省关闭
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
  showOutline = false,
  onUndo,
  onRedo,
  onBrushSizeChange,
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(null); // {x, y} 影像坐标的上一采样点
  const ringRef = useRef(null); // 笔刷光标环
  const linkRef = useRef(null); // 触屏偏移光标的指尖连接线
  const interaction = useViewerInteraction(); // ImageViewer 的手势/拒触状态（ref 直读，同步生效）

  // 掩膜合成渲染：其余类别按 DIM_RATIO 弱化并先画，当前类别全量 alpha + 可选描边最后画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims?.w) return;
    canvas.width = dims.w;
    canvas.height = dims.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(dims.w, dims.h);
    const buf = img.data;
    const dimAlpha = Math.round(255 * DIM_RATIO);
    const { w, h } = dims;
    // 当前类别必须最后合成：否则新画的笔画会被后画的弱化类别盖住，一条线显示成断断续续
    const top = entries.find(entry => entry?.key === activeKey);
    const layers = entries.filter(entry => entry !== top); // 其余类别保持原叠放顺序
    if (top) layers.push(top);
    for (const entry of layers) {
      if (!entry?.data) continue;
      const mask = entry.data;
      const isActive = entry.key === activeKey;
      const [r, g, b] = hexRgb(entry.color);
      // 描边色：类别色向白色提亮，在彩色填充与灰阶底图上都清晰可辨
      const er = Math.round(r + (255 - r) * OUTLINE_LIGHTEN);
      const eg = Math.round(g + (255 - g) * OUTLINE_LIGHTEN);
      const eb = Math.round(b + (255 - b) * OUTLINE_LIGHTEN);
      const outline = isActive && showOutline;
      for (let i = 0; i < w * h; i++) {
        if (!mask[i]) continue;
        const j = i * 4;
        if (outline && isEdge(mask, i, w, h)) {
          buf[j] = er;
          buf[j + 1] = eg;
          buf[j + 2] = eb;
        } else {
          buf[j] = r;
          buf[j + 1] = g;
          buf[j + 2] = b;
        }
        buf[j + 3] = isActive ? 255 : dimAlpha;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [dims, entries, version, activeKey, showOutline]);

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

  /** 笔刷光标环：跟随指针，直径按当前缩放实时换算（屏幕 px / 影像 px），微小笔刷保底 8 屏幕 px 可见。
      触屏（pointerType='touch'）时环抬到指尖上方 RING_LIFT px 并画一条连接线，避免手指遮挡落点 */
  const moveRing = event => {
    const ring = ringRef.current;
    const canvas = canvasRef.current;
    if (!ring || !canvas) return;
    const pxPerImg = canvas.getBoundingClientRect().width / dims.w;
    const d = Math.max(8, brushSize * pxPerImg);
    const lift = event.pointerType === 'touch' ? RING_LIFT : 0;
    ring.style.width = `${d}px`;
    ring.style.height = `${d}px`;
    ring.style.left = `${event.clientX - d / 2}px`;
    ring.style.top = `${event.clientY - lift - d / 2}px`;
    ring.style.display = 'block';
    if (linkRef.current) {
      if (lift) {
        linkRef.current.style.left = `${event.clientX - 0.5}px`;
        linkRef.current.style.top = `${event.clientY - lift}px`;
        linkRef.current.style.height = `${lift}px`;
        linkRef.current.style.display = 'block';
      } else {
        linkRef.current.style.display = 'none';
      }
    }
  };

  const hideRing = () => {
    if (ringRef.current) ringRef.current.style.display = 'none';
    if (linkRef.current) linkRef.current.style.display = 'none';
  };

  /** 双指手势打断：撤销刚起的半笔并停止绘制（ImageViewer 在第二指落下的捕获阶段同步调用） */
  const cancelCurrentStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = null;
    editor.cancelStroke?.();
    hideRing();
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

  /** 手指/手掌是否不得起笔：双指手势进行中，或 Pencil 按下时（拒触） */
  const strokeBlocked = event =>
    Boolean(interaction?.twoFinger) || Boolean(interaction?.penActive && event.pointerType === 'touch');

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
          if (strokeBlocked(event)) return;
          event.stopPropagation();
          moveRing(event); // 触屏立即显示偏移光标环（落点已画下，环在指尖上方可见）
          event.currentTarget.setPointerCapture(event.pointerId);
          editor.beginStroke(activeKey);
          drawingRef.current = null;
          applyPaint(event);
          if (interaction) interaction.cancelPaint = cancelCurrentStroke; // 注册双指手势打断入口
        }}
        onPointerMove={event => {
          if (!paintActive) return;
          if (interaction?.twoFinger) {
            hideRing(); // 手势期间不出光标环
            return;
          }
          moveRing(event);
          if (!drawingRef.current || strokeBlocked(event)) return;
          event.stopPropagation();
          // 合并高采样率指针的中间帧（120Hz Pencil 等），快速拖动时笔迹更顺滑
          const frames = event.nativeEvent.getCoalescedEvents?.() ?? [];
          if (frames.length > 1) frames.forEach(frame => applyPaint(frame));
          else applyPaint(event);
        }}
        onPointerUp={event => {
          drawingRef.current = null;
          if (interaction) interaction.cancelPaint = null;
          if (event.pointerType === 'touch') hideRing(); // 手指没有 hover：抬指即隐藏，光标环不残留
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={event => {
          drawingRef.current = null;
          if (interaction) interaction.cancelPaint = null;
          hideRing();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerLeave={hideRing}
      />
      {paintActive &&
        /* 笔刷光标环 + 触屏指尖连接线：portal 到 body 的 fixed 定位跟随指针（在 transform 祖先内 fixed 会失效），直径已按缩放换算 */
        createPortal(
          <>
            <div
              ref={linkRef}
              className="pointer-events-none fixed z-50 hidden w-px"
              style={{ backgroundColor: 'rgba(255,255,255,0.6)' }}
            />
            <div
              ref={ringRef}
              className="pointer-events-none fixed z-50 hidden rounded-full"
              style={{
                borderWidth: 2,
                borderStyle: tool === 'eraser' ? 'dashed' : 'solid',
                borderColor: tool === 'eraser' ? 'rgba(255,255,255,0.85)' : cursorColor || '#ffffff',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.65)', // 深色外圈：亮背景上也能看清
              }}
            />
          </>,
          document.body,
        )}
    </>
  );
}

function hexRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** 掩膜边界判定：4 邻域任一为空（或越界）即为边缘，用于当前类别的高亮描边 */
function isEdge(mask, i, w, h) {
  const x = i % w;
  const y = (i / w) | 0;
  return (
    x === 0 || !mask[i - 1] ||
    x === w - 1 || !mask[i + 1] ||
    y === 0 || !mask[i - w] ||
    y === h - 1 || !mask[i + w]
  );
}
