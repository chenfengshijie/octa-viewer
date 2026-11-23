import { useState } from 'react';

const artifacts = [
  ['full_projection', '全层投影'],
  ['shallow_projection', '浅层投影'],
  ['deep_projection', '深层投影'],
  ['model_input', '模型输入'],
  ['surfaces', '层边界数组'],
  ['boundary_qc', '边界质控图'],
  ['probability', '归档概率'],
  ['mask', '原始大血管掩膜'],
  ['overlay', '原始叠加图'],
];

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}

function ArtifactRow({ run, item }) {
  const [key, name] = item;
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const expected = run.sha256?.[key];
  async function check() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(run.outputs[key]);
      if (!response.ok) throw new Error('文件读取失败');
      const data = await response.arrayBuffer();
      const actual = hex(await crypto.subtle.digest('SHA-256', data));
      setResult({
        actual,
        message:
          (actual === expected ? '摘要一致' : '摘要不同') +
          ' · ' +
          data.byteLength.toLocaleString() +
          ' B',
      });
    } catch (err) {
      setResult({ message: err.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr className="border-t align-top">
      <th scope="row" className="p-2 text-left font-normal">
        <a className="text-blue-700" href={run.outputs[key]} download>
          {name}
        </a>
      </th>
      <td className="max-w-64 break-all p-2 font-mono text-xs">{expected ?? '无记录'}</td>
      <td className="p-2">
        {typeof crypto.subtle !== 'undefined' && expected && (
          <button className="text-blue-700" disabled={busy} onClick={check}>
            {busy ? '读取中…' : '核对文件'}
          </button>
        )}
        {result && (
          <span className="block text-xs" role="status" title={result.actual}>
            {result.message}
          </span>
        )}
      </td>
    </tr>
  );
}

export default function RunProvenance({ run }) {
  return (
    <details className="card p-4 text-sm">
      <summary className="cursor-pointer font-semibold">批次来源与归档文件</summary>
      <div className="mt-3 space-y-3">
        <dl className="grid gap-2 sm:grid-cols-2">
          {[
            ['病例', run.case_id],
            ['推理批次', run.job_id],
            ['分层模型', run.model.layer_model],
            ['血管模型权重', run.model.vessel_weight],
            ['模型输入通道', '深层、浅层、全层'],
            [
              '切块视野',
              run.parameters.tile_fov_mm && run.parameters.tile_fov_mm.join(' × ') + ' mm',
            ],
            ['归档时间', run.completed_at && new Date(run.completed_at).toLocaleString()],
            ['模型权重 SHA-256', run.model.vessel_weight_sha256],
          ]
            .filter(([, value]) => value)
            .map(([name, value]) => (
              <div className="rounded bg-slate-50 p-2" key={name}>
                <dt>{name}</dt>
                <dd className="break-all font-mono">{value}</dd>
              </div>
            ))}
        </dl>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['产物', '归档 SHA-256', '核对'].map((title) => (
                  <th key={title} className="p-2 text-left">
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {artifacts
                .filter(([key]) => run.outputs[key])
                .map((item) => (
                  <ArtifactRow key={item[0]} run={run} item={item} />
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
