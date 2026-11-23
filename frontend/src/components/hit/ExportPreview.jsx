import { useState } from 'react';
import { jsonPost } from './api.js';

const names = { train: '训练集', validation: '验证集', test: '测试集' };

export default function ExportPreview({ selection, seed, filters }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const payload = { versions: selection, seed: seed.trim(), filters };
  const identity = JSON.stringify(payload);
  const current = result?.identity === identity ? result.data : null;
  async function preview() {
    setBusy(true);
    setError('');
    try {
      const data = await jsonPost('/api/hit/research/preview', payload);
      setResult({ identity, data });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <button
        className="rounded border px-3 py-2"
        disabled={busy || !selection.length || !payload.seed}
        onClick={preview}
      >
        {busy ? '正在核对入选版本…' : '预览病例划分'}
      </button>
      {error && <p role="alert">{error}</p>}
      {current && (
        <>
          <p>
            入选 {current.cases} 个病例、{current.batches} 个批次。
          </p>
          <dl className="grid grid-cols-3 gap-2">
            {Object.entries(names).map(([key, title]) => (
              <div className="rounded bg-slate-50 p-2" key={key}>
                <dt>{title}</dt>
                <dd>
                  {current.case_counts[key] ?? 0} 个病例 · {current.batch_counts[key] ?? 0} 批
                </dd>
              </div>
            ))}
          </dl>
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {['病例', '批次', '划分', '修订', '复核人'].map((key) => (
                  <th key={key}>{key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {current.rows.map((row) => (
                <tr key={row.job}>
                  <td>{row.case_id}</td>
                  <td>{row.job}</td>
                  <td>{names[row.split]}</td>
                  <td title={row.digest}>{row.version.slice(0, 8)}</td>
                  <td>{row.reviewer}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
