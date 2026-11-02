/**
 * 样本对象格式化为下拉选项文案，如 "10101 · NORMAL · M · OD · 55岁"。
 * @param {{id: string, disease: string, sex: string, eye: string, age: number}} sample
 * @returns {string}
 */
export function formatSample(sample) {
  return `${sample.id} · ${sample.disease} · ${sample.sex} · ${sample.eye} · ${sample.age}岁`;
}

/**
 * 顶栏样本选择器。
 * @param {{
 *   samples: Array<{id: string, disease: string, sex: string, eye: string, age: number}>,
 *   value: string,
 *   onChange: (id: string) => void,
 *   disabled?: boolean, // 列表尚在加载时禁用
 * }} props
 */
export default function SamplePicker({ samples, value, onChange, disabled = false }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">样本</span>
      <select
        className="select-input"
        value={value}
        disabled={disabled || samples.length === 0}
        onChange={event => onChange(event.target.value)}
      >
        {samples.length === 0 ? (
          <option value="">暂无样本</option>
        ) : (
          <>
            {!samples.some(s => s.id === value) && <option value="">选择样本</option>}
            {samples.map(sample => (
              <option key={sample.id} value={sample.id}>
                {formatSample(sample)}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}
