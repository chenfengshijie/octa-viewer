/**
 * 通用滑杆：标签左、当前值右（tabular-nums）。
 * @param {{
 *   label: string,
 *   min: number,
 *   max: number,
 *   value: number,
 *   onChange: (value: number) => void,
 *   format?: (value: number) => string, // 值的显示格式，默认直接显示数值
 *   disabled?: boolean,
 * }} props
 */
export default function Slider({ label, min, max, value, onChange, format, disabled = false }) {
  return (
    <div className={disabled ? 'opacity-50' : undefined}>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className="font-medium tabular-nums text-slate-700">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={event => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer accent-blue-600 coarse:h-2.5"
      />
    </div>
  );
}
