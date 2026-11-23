/**
 * 多模型融合设置（位于任务页顶部模型栏内）。
 *
 * 选择 2–8 个预测同一类别的模型后运行：后端对每个模型的原生概率图逐像素取
 * 最大概率，再按给定阈值判定前景；融合结果作为独立的 "融合输出"保存，
 * 不会与单模型输出或用户标注版本混在一起。
 */
export default function EnsembleBar({
  models = [],
  selected = [],
  onToggle,
  threshold = 0.5,
  onThresholdChange,
  error,
}) {
  const available = (models ?? []).filter(item => item.available);
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-slate-600">选择融合模型（限同一类别，2–8 个）</p>
            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-500">
              已选 {selected.length}
            </span>
          </div>
          <div className="grid max-h-32 grid-cols-1 gap-0.5 overflow-auto pr-1 sm:grid-cols-2">
            {available.map(item => (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-600 hover:bg-white"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-slate-300"
                  checked={selected.includes(item.id)}
                  onChange={() => onToggle?.(item.id)}
                />
                <span className="truncate">{item.name}</span>
              </label>
            ))}
            {available.length === 0 && (
              <p className="col-span-full text-[11px] text-slate-400">当前任务暂无可用模型。</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
          <label className="flex items-center justify-between gap-2 text-xs text-slate-500">
            <span>判定阈值</span>
            <input
              type="number"
              min="0.01"
              max="0.99"
              step="0.01"
              value={threshold}
              onChange={event => onThresholdChange?.(Number(event.target.value))}
              className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1 text-right tabular-nums"
            />
          </label>
          <p className="text-[11px] leading-relaxed text-slate-400">
            选好 2 个以上模型后，到右侧「推理」栏点击按钮（按钮会自动切换为融合推理）。
          </p>
        </div>
      </div>
      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-2.5 py-2 text-[11px] leading-relaxed text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
