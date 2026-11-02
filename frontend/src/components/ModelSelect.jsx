/**
 * 顶栏模型选择器：不可用的模型禁用并标注"暂未接入"。
 * @param {{
 *   models: Array<{id: string, name: string, available: boolean}>,
 *   value: string,
 *   onChange: (id: string) => void,
 *   disabled?: boolean,
 * }} props
 */
export default function ModelSelect({ models, value, onChange, disabled = false }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">模型</span>
      <select
        className="select-input"
        value={value}
        disabled={disabled || models.length === 0}
        onChange={event => onChange(event.target.value)}
      >
        {models.length === 0 ? (
          <option value="">暂无可用模型</option>
        ) : (
          <>
            {!models.some(m => m.id === value) && <option value="">选择模型</option>}
            {models.map(model => (
              <option key={model.id} value={model.id} disabled={!model.available}>
                {model.available ? model.name : `${model.name} · 暂未接入`}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}
