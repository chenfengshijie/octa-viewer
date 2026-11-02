/**
 * 量化指标卡片：标签 + 大号数值（tabular-nums）+ 单位。
 * @param {{label: string, value: number|string, unit?: string}} props
 */
export default function MetricCard({ label, value, unit }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-800">
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-slate-400">{unit}</span>}
      </p>
    </div>
  );
}
