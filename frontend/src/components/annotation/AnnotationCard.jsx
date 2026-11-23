import {
  Brush,
  Eraser,
  Eye,
  Hand,
  Pencil,
  Save,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import Slider from '../Slider.jsx';

const TOOLS = [
  { key: 'brush', icon: Brush, label: '画笔', title: '画笔（[ / ] 调整大小）' },
  { key: 'eraser', icon: Eraser, label: '橡皮', title: '橡皮（[ / ] 调整大小）' },
  { key: 'pan', icon: Hand, label: '拖动', title: '拖动平移（画笔模式下也可按住空格或用右键拖动）' },
];

/**
 * 标注卡：查看版本状态与切换、进入/退出编辑、画笔工具条、保存/放弃/恢复原始 GT。
 * 纯控制面板；掩膜状态与保存逻辑由所属视图（SegmentationView / Faz3dView）提供。
 *
 * @param {{
 *   user: object|null,
 *   editing: boolean, onToggleEditing: () => void,
 *   tool: string, onToolChange: (t: string) => void,
 *   brushSize: number, onBrushSizeChange: (n: number) => void,
 *   canUndo: boolean, canRedo: boolean, onUndo: () => void, onRedo: () => void,
 *   dirty: boolean, saving: boolean,
 *   onSave: () => void, onDiscard: () => void, onResetToGt: () => void,
 *   myVersion: boolean,
 *   viewing: string,             // '' = 原始 GT，否则为用户名
 *   annotators: Array<{username: string, updated_at: string, n_saves: number}>,
 *   onViewChange: (name: string) => void,
 *   targetLabel?: string,        // 当前编辑对象的说明，如「画笔类别：动脉」
 *   extraDisabledReason?: string, // 视图补充的禁用原因（如「请先运行推理」）
 *   error?: string|null,          // 保存等操作的错误信息
 * }} props
 */
export default function AnnotationCard({
  user,
  editing,
  onToggleEditing,
  tool,
  onToolChange,
  brushSize,
  onBrushSizeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  dirty,
  saving,
  onSave,
  onDiscard,
  onResetToGt,
  myVersion,
  viewing,
  annotators,
  onViewChange,
  targetLabel,
  baseLabel = '原始 GT',
  allowCleanSave = false,
  showVersions = true,
  extraDisabledReason,
  error,
}) {
  const viewingOther = Boolean(viewing && user && viewing !== user.username);
  const disabledReason = !user
    ? '请先在左下角登录或注册，即可编辑标注'
    : viewingOther
      ? `正在查看 ${viewing} 的版本（只读），切换到我的版本或${baseLabel}后可编辑`
      : (extraDisabledReason ?? null);

  return (
    <div className="card space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">标注编辑</h3>
        {editing && (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">
            编辑中
          </span>
        )}
      </div>

      {/* 未登录 / 他人版本只读提示 */}
      {disabledReason && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          {disabledReason}
        </p>
      )}

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">{error}</p>
      )}

      {/* 编辑开关 + 工具条 */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={onToggleEditing}
          disabled={Boolean(disabledReason)}
          className={editing ? 'btn-primary w-full' : 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 shadow-sm transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50'}
        >
          {editing ? <><X className="h-4 w-4" /> 退出编辑</> : <><Pencil className="h-4 w-4" /> 开始标注</>}
        </button>

        {editing && (
          <>
            <div className="flex items-center gap-1.5">
              {TOOLS.map(({ key, icon: Icon, label, title }) => (
                <button
                  key={key}
                  type="button"
                  title={title}
                  onClick={() => onToolChange(key)}
                  className={`inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border text-xs font-medium transition ${
                    tool === key
                      ? 'border-blue-500 bg-blue-50 text-blue-600'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
              <button
                type="button"
                title="撤销"
                disabled={!canUndo}
                onClick={onUndo}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="重做"
                disabled={!canRedo}
                onClick={onRedo}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5 -scale-x-100" />
              </button>
            </div>

            <Slider
              label="笔刷大小"
              min={1}
              max={60}
              value={brushSize}
              onChange={onBrushSizeChange}
              format={value => `${value} px`}
            />

            {targetLabel && (
              <p className="text-xs text-slate-500">
                {targetLabel}
                {dirty && <span className="ml-2 font-medium text-amber-600">有未保存的更改</span>}
              </p>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={onSave} disabled={(!dirty && !allowCleanSave) || saving} className="btn-primary h-8 flex-1 !px-2 text-xs">
                <Save className="h-3.5 w-3.5" /> {saving ? '保存中…' : '保存标注'}
              </button>
              <button
                type="button"
                onClick={onDiscard}
                disabled={!dirty || saving}
                className="h-8 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-600 shadow-sm transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                放弃修改
              </button>
            </div>
          </>
        )}
      </div>

      {/* 我的版本管理 */}
      {user && myVersion && !editing && (
        <div className="flex items-center justify-between border-t border-slate-100 pt-3">
          <p className="text-xs text-slate-500">我保存过标注版本</p>
          <button
            type="button"
            onClick={onResetToGt}
            title={`删除我的版本，恢复展示${baseLabel}`}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-500 transition hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> 恢复{baseLabel}
          </button>
        </div>
      )}

      {/* 标注版本列表 */}
      {showVersions && <div className="border-t border-slate-100 pt-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <Eye className="h-3.5 w-3.5" /> 标注版本
        </p>
        <div className="space-y-1">
          <VersionRow
            name={baseLabel}
            title={baseLabel}
            active={viewing === ''}
            onClick={() => onViewChange('')}
            mine={Boolean(user && user.username === '')}
          />
          {annotators.map(a => (
            <VersionRow
              key={a.username}
              name={a.username}
              title={`${a.username} 的标注 · ${a.updated_at ?? ''}${a.n_saves ? ` · ${a.n_saves} 次保存` : ''}`}
              active={viewing === a.username}
              onClick={() => onViewChange(a.username)}
              mine={Boolean(user && a.username === user.username)}
            />
          ))}
          {user && !myVersion && (
            <p className="pt-1 text-[11px] leading-relaxed text-slate-400">
              保存后，这里会出现你自己的标注版本。
            </p>
          )}
        </div>
      </div>}
    </div>
  );
}

function VersionRow({ name, title, active, onClick, mine }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition ${
        active ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-600 hover:bg-slate-50'
      }`}
    >
      <span className="truncate">{name}</span>
      {mine && <span className="ml-2 shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600">我的</span>}
    </button>
  );
}
