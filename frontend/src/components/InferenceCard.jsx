import RunButton from './RunButton.jsx';

/**
 * 推理控制卡：运行按钮 + 耗时 / 模型信息 + 错误提示（各任务视图共用）。
 * @param {{
 *   onRun: () => void,
 *   running: boolean,
 *   onRunEnsemble?: () => void,     // 已选 2+ 融合模型时，按钮改为融合推理
 *   ensembleReady?: boolean,
 *   ensembleRunning?: boolean,
 *   ensembleCount?: number,
 *   disabled?: boolean,   // 未选择样本时禁用
 *   error?: string|null,  // 推理失败的错误信息
 *   result?: object|null, // 上一次推理结果（用于展示耗时与模型名）
 * }} props
 */
export default function InferenceCard({ onRun, running, disabled = false, error = null, result = null,
                                        onRunEnsemble, ensembleReady = false, ensembleRunning = false,
                                        ensembleCount = 0 }) {
  const fusionMode = Boolean(ensembleReady && onRunEnsemble);
  const busy = fusionMode ? ensembleRunning : running;
  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">推理</h3>
        {result && typeof result.latency_ms === 'number' && (
          <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium tabular-nums text-teal-600">
            {result.latency_ms} ms
          </span>
        )}
      </div>
      {result?.model_name && (
        <p className="text-xs text-slate-400">
          模型：<span className="text-slate-600">{result.model_name}</span>
          {result.cached && (
            <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500"
                  title="该样本的模型结果已保存，直接复用，不会重复推理">
              已保存
            </span>
          )}
        </p>
      )}
      {fusionMode && (
        <p className="rounded-lg bg-blue-50 px-2.5 py-2 text-[11px] leading-relaxed text-blue-600">
          已选 {ensembleCount} 个模型，将按最大概率融合后出结果。
        </p>
      )}
      <RunButton
        onClick={fusionMode ? onRunEnsemble : onRun}
        loading={busy}
        disabled={disabled}
      >
        {fusionMode ? '融合推理（最大概率）' : '运行推理'}
      </RunButton>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">{error}</p>}
    </div>
  );
}
