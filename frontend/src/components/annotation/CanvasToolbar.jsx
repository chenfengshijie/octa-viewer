import { useEffect, useState } from 'react';
import { Brush, ChevronDown, ChevronLeft, ChevronRight, Eraser, Hand, Save, Undo2 } from 'lucide-react';

const TOOLS = [
  { key: 'brush', icon: Brush, label: '画笔' },
  { key: 'eraser', icon: Eraser, label: '橡皮' },
  { key: 'pan', icon: Hand, label: '拖动' },
];

/**
 * 画布悬浮标注工具栏（仅触屏设备编辑态显示，由各视图挂载在查看器容器上）。
 * 深色玻璃拟态横条悬浮于画布底部居中：撤销/重做 · 画笔/橡皮/拖动 · 笔刷大小（弹层滑杆）
 * · 画笔类别（弹层选择，多类别任务）· 保存徽章；Faz3dView 额外注入切片 ‹› 步进（精细定位在小地图）。
 * 弹层向上展开，点工具栏外任意处关闭；按钮命中区 ≥40px。
 *
 * @param {{
 *   visible: boolean,
 *   tool: string, onToolChange: (t: string) => void,
 *   brushSize: number, onBrushSizeChange: (n: number) => void,
 *   canUndo: boolean, canRedo: boolean, onUndo: () => void, onRedo: () => void,
 *   classes?: Array<{key: string, name: string, color: string}>|null, // 多类别任务的画笔类别
 *   activeClass?: string|null, onClassChange?: (key: string) => void,
 *   dirty: boolean, saving: boolean, onSave: () => void,
 *   slice?: {n: number, total: number, onChange: (n: number) => void}, // faz3d 逐切片步进
 * }} props
 */
export default function CanvasToolbar({
  visible,
  tool,
  onToolChange,
  brushSize,
  onBrushSizeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  classes = null,
  activeClass = null,
  onClassChange,
  dirty,
  saving,
  onSave,
  slice,
}) {
  const [pop, setPop] = useState(null); // 'brush' | 'class' | null（向上展开的弹层）

  useEffect(() => {
    if (!visible) setPop(null);
  }, [visible]);

  if (!visible) return null;

  const activeClassDef = classes?.find(c => c.key === activeClass);
  // 36px 宽的紧凑命中区：390px 手机视口下整条工具栏（撤销/重做/3 工具/笔刷/类别/保存）必须放得下
  const iconBtn = (active, disabled) =>
    `inline-flex h-10 w-9 shrink-0 items-center justify-center rounded-xl transition active:scale-95 disabled:opacity-40 ${
      active ? 'bg-blue-600 text-white' : disabled ? 'text-slate-500' : 'text-slate-300'
    }`;

  return (
    /* 外层只在水平方向占位，点击穿透（弹层/横条自身恢复 pointer-events）；
       -left/right-4 突破页面 px-4 内边距，让 390px 手机视口下横条有足够宽度 */
    <div className="pointer-events-none absolute -left-4 -right-4 bottom-3 z-20 flex justify-center px-1.5">
      {pop && (
        <button
          type="button"
          aria-label="关闭弹层"
          onClick={() => setPop(null)}
          className="pointer-events-auto fixed inset-0 cursor-default"
        />
      )}

      <div className="pointer-events-auto relative flex max-w-full flex-none items-center gap-0 rounded-2xl border border-white/10 bg-black/70 p-1 shadow-lg backdrop-blur-md">
        {/* 撤销 / 重做 */}
        <button type="button" title="撤销" disabled={!canUndo} onClick={onUndo} className={iconBtn(false, !canUndo)}>
          <Undo2 className="h-5 w-5" />
        </button>
        <button type="button" title="重做" disabled={!canRedo} onClick={onRedo} className={iconBtn(false, !canRedo)}>
          <Undo2 className="h-5 w-5 -scale-x-100" />
        </button>

        <span className="h-6 w-px shrink-0 bg-white/15" />

        {/* 工具切换 */}
        {TOOLS.map(({ key, icon: Icon, label }) => (
          <button key={key} type="button" title={label} onClick={() => onToolChange(key)} className={iconBtn(tool === key)}>
            <Icon className="h-5 w-5" />
          </button>
        ))}

        <span className="h-6 w-px shrink-0 bg-white/15" />

        {/* 笔刷大小（点开向上弹层：滑杆 + 步进）；圆点直径即笔刷大小的直观示意 */}
        <button
          type="button"
          title="笔刷大小"
          onClick={() => setPop(prev => (prev === 'brush' ? null : 'brush'))}
          className="inline-flex h-10 shrink-0 items-center rounded-xl px-2 text-slate-300 transition active:bg-white/10"
        >
          <span
            className={`inline-block rounded-full ${tool === 'eraser' ? 'border border-dashed border-slate-300' : 'bg-slate-300'}`}
            style={{ width: `${Math.max(6, Math.min(18, brushSize / 3))}px`, height: `${Math.max(6, Math.min(18, brushSize / 3))}px` }}
          />
        </button>

        {/* 画笔类别（多类别任务） */}
        {classes && (
          <button
            type="button"
            title="画笔类别"
            onClick={() => setPop(prev => (prev === 'class' ? null : 'class'))}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-2 text-slate-300 transition active:bg-white/10"
          >
            <span
              className="inline-block h-3.5 w-3.5 rounded-full border border-white/40"
              style={{ backgroundColor: activeClassDef?.color ?? 'transparent' }}
            />
            <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
          </button>
        )}

        {/* 切片步进（faz3d）：精细定位用 enface 小地图拖动，这里只做相邻切片步进 */}
        {slice && (
          <>
            <button
              type="button"
              title="上一张切片"
              disabled={slice.n <= 1}
              onClick={() => slice.onChange(slice.n - 1)}
              className={iconBtn(false, slice.n <= 1)}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              title="下一张切片"
              disabled={slice.n >= slice.total}
              onClick={() => slice.onChange(slice.n + 1)}
              className={iconBtn(false, slice.n >= slice.total)}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}

        <span className="h-6 w-px shrink-0 bg-white/15" />

        {/* 保存徽章：有未保存修改时常亮 */}
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className={`inline-flex h-10 shrink-0 items-center gap-1 rounded-xl px-2 text-xs font-medium transition active:scale-95 disabled:opacity-40 ${
            dirty ? 'bg-blue-600 text-white' : 'text-slate-300'
          }`}
        >
          <Save className="h-4 w-4" />
          {saving ? '保存中' : '保存'}
          {dirty && !saving && <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />}
        </button>

        {/* 笔刷大小弹层 */}
        {pop === 'brush' && (
          <div className="absolute bottom-full left-1/2 mb-2 w-60 -translate-x-1/2 rounded-xl border border-white/10 bg-black/85 p-3 shadow-lg backdrop-blur-md">
            <div className="mb-2.5 flex items-center justify-between text-xs text-slate-300">
              <span>笔刷大小</span>
              <span className="tabular-nums">{brushSize} px</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="调小笔刷"
                onClick={() => onBrushSizeChange(Math.max(1, brushSize - 1))}
                className="h-9 w-9 rounded-lg text-slate-300 transition active:bg-white/10"
              >
                −
              </button>
              <input
                type="range"
                min={1}
                max={60}
                value={brushSize}
                onChange={event => onBrushSizeChange(Number(event.target.value))}
                className="h-9 flex-1 accent-blue-500"
              />
              <button
                type="button"
                aria-label="调大笔刷"
                onClick={() => onBrushSizeChange(Math.min(60, brushSize + 1))}
                className="h-9 w-9 rounded-lg text-slate-300 transition active:bg-white/10"
              >
                +
              </button>
            </div>
          </div>
        )}

        {/* 画笔类别弹层 */}
        {pop === 'class' && classes && (
          <div className="absolute bottom-full left-1/2 mb-2 w-44 -translate-x-1/2 rounded-xl border border-white/10 bg-black/85 p-2 shadow-lg backdrop-blur-md">
            {classes.map(c => (
              <button
                key={c.key}
                type="button"
                onClick={() => {
                  onClassChange?.(c.key);
                  setPop(null);
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm transition active:bg-white/10 ${
                  c.key === activeClass ? 'bg-blue-600/80 font-medium text-white' : 'text-slate-200'
                }`}
              >
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
