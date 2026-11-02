import { Info } from 'lucide-react';

/**
 * 样本信息卡（性别 / 眼别 / 年龄等），无样本时不渲染。
 * @param {{sample: {id: string, disease: string, sex: string, eye: string, age: number}|null}} props
 */
export default function SampleInfoCard({ sample }) {
  if (!sample) return null;
  const rows = [
    ['样本编号', sample.id],
    ['分型', sample.disease],
    ['性别', sample.sex],
    ['眼别', sample.eye],
    ['年龄', `${sample.age}岁`],
  ];
  return (
    <div className="card p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
        <Info className="h-4 w-4 text-blue-600" /> 样本信息
      </h3>
      <dl className="space-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between">
            <dt className="text-slate-400">{label}</dt>
            <dd className="font-medium tabular-nums text-slate-700">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
