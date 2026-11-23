import { Eye, Trash2 } from 'lucide-react';

/**
 * 「标注版本」卡：模型输出、融合输出与其他标注员的版本，可点击切换查看。
 * 与「标注编辑」卡分离，避免编辑控件和版本切换混在一起；编辑中禁止切换，防止误丢修改。
 */
export default function VersionPanel({
  user,
  myVersion = false,
  viewing = '',
  annotators = [],
  modelOutputs = [],
  activeOutput = null,
  onViewModelOutput,
  onViewChange,
  onDeleteVersion,
  disabled = false,
}) {
  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <Eye className="h-3.5 w-3.5" /> 标注版本
        </h3>
        {user && myVersion && (
          <button
            type="button"
            onClick={onDeleteVersion}
            disabled={disabled}
            title="删除我的标注版本（历史保留，此后展示模型输出）"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-500 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" /> 删除我的版本
          </button>
        )}
      </div>

      <div className="space-y-1">
        {modelOutputs.map(item => {
          const isEnsemble = item.kind === 'ensemble';
          const label = item.label || (isEnsemble
            ? `融合输出 · ${(item.model_names || []).join(' + ')}`
            : `模型输出 · ${item.model_name}`);
          const active = Boolean(activeOutput && viewing === '' && (
            isEnsemble
              ? activeOutput.kind === 'ensemble' && activeOutput.id === item.ensemble_id
              : activeOutput.kind === 'single' && activeOutput.id === item.model_id
          ));
          return (
            <VersionRow
              key={isEnsemble ? `ensemble-${item.ensemble_id}` : `model-${item.model_id}`}
              name=""
              label={label}
              badge={isEnsemble ? '融合' : undefined}
              title={isEnsemble
                ? `${label} · 最大概率阈值 ${item.threshold ?? 0.5}，点击即读取，不会重新推理`
                : `${label} · 结果已保存，点击即读取，不会重新推理`}
              active={active}
              disabled={disabled}
              onClick={() => onViewModelOutput?.(item)}
              mine={false}
            />
          );
        })}
        {modelOutputs.length === 0 && (
          <p className="pt-1 text-[11px] leading-relaxed text-slate-400">
            运行推理后，这里会列出该样本下所有已保存的模型输出。
          </p>
        )}
        {annotators.map(item => (
          <VersionRow
            key={item.username}
            name={item.username}
            title={`${item.username} 的标注 · ${item.updated_at ?? ''}${item.n_saves ? ` · ${item.n_saves} 次保存` : ''}`}
            active={viewing === item.username}
            disabled={disabled}
            onClick={() => onViewChange?.(item.username)}
            mine={Boolean(user && item.username === user.username)}
          />
        ))}
        {user && !myVersion && (
          <p className="pt-1 text-[11px] leading-relaxed text-slate-400">
            保存后，这里会出现你自己的标注版本。
          </p>
        )}
      </div>
      {disabled && (
        <p className="border-t border-slate-100 pt-2 text-[11px] leading-relaxed text-slate-400">
          编辑中不可切换版本；请先保存或退出编辑。
        </p>
      )}
    </div>
  );
}

function VersionRow({ name, title, active, onClick, mine, label, badge, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition ${
        active ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-600 hover:bg-slate-50'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <span className="truncate">{label ?? (name === '' ? '模型输出' : name)}</span>
      <span className="ml-2 flex shrink-0 items-center gap-1">
        {badge && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              badge === '已保存' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'
            }`}
          >
            {badge}
          </span>
        )}
        {mine && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600">我的</span>}
      </span>
    </button>
  );
}
