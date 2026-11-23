import { CohortControls, DistributionTable } from './CohortControls.jsx';
import ExportPreview from './ExportPreview.jsx';
import { useState } from 'react';
import { jsonPost, withQuery } from './api.js';
import useResource from './useResource.js';

const prefix = '/api/hit/research';

function decimal(value) {
  return value == null ? '—' : value.toFixed(4);
}

export function Agreement({ navigate }) {
  const [selection, setSelection] = useState({ author: '', reference_author: '' });
  const [sort, setSort] = useState('job');
  const { data, error } = useResource(withQuery(prefix + '/summary', selection));
  const [query, setQuery] = useState('');
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>正在汇总各批次的修订…</p>;
  const rows = data.rows.filter((row) =>
    [row.case_id, row.job, row.author].some((text) => text.includes(query)),
  );
  rows.sort((a, b) => (sort === 'job' ? a.job.localeCompare(b.job) : a[sort] - b[sort]));
  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-semibold">批次一致性</h2>
      <CohortControls
        authors={data.available_authors}
        selection={selection}
        onChange={setSelection}
      />
      <p className="text-sm">
        每批次固定一对掩膜计算指标，各批次等权。两份掩膜均为空时重合度为 1。
      </p>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['平均 Dice', decimal(data.mean.dice)],
          ['平均 IoU', decimal(data.mean.iou)],
          ['纳入批次', data.rows.length],
          ['未形成比较对', data.missing.length],
        ].map(([name, value]) => (
          <div key={name} className="rounded bg-slate-50 p-3">
            <dt className="text-xs text-slate-600">{name}</dt>
            <dd className="font-mono text-xl">{value}</dd>
          </div>
        ))}
      </dl>
      <DistributionTable data={data} />
      <label className="text-sm">
        查找比较对
        <input
          className="ml-2 rounded border p-2"
          placeholder="病例、批次或作者"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <button
        className="ml-2 rounded border px-3 py-2 text-sm"
        disabled={!rows.length}
        onClick={() => {
          const body = JSON.stringify({ selection, filter: query, rows }, null, 2);
          download(new Blob([body], { type: 'application/json' }), 'hit-agreement.json');
        }}
      >
        下载当前比较表
      </button>
      <label className="block text-sm">
        排列顺序
        <select
          className="select-input ml-2"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="job">推理批次</option>
          <option value="dice">Dice 从低到高</option>
          <option value="iou">IoU 从低到高</option>
        </select>
      </label>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {['病例 / 批次', '作者', 'Dice', 'IoU', '新增', '擦除', '修订版本'].map((key) => (
                <th className="p-2" key={key}>
                  {key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.job} className="border-t">
                <td className="p-2">
                  {row.case_id}
                  <br />
                  {row.job}
                </td>
                <td>{row.author}</td>
                <td>{decimal(row.dice)}</td>
                <td>{decimal(row.iou)}</td>
                <td>{row.added}</td>
                <td>{row.erased}</td>
                <td>
                  <button
                    className="text-blue-700"
                    onClick={() => navigate(row.job, row.target, 'compare', null, row.reference)}
                  >
                    对比 {row.target.slice(0, 8)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="text-sm">没有符合条件的版本对。</p>}
      {data.missing.length > 0 && (
        <details className="text-sm">
          <summary>查看未形成比较对的批次（{data.missing.length}）</summary>
          <ul>
            {data.missing.map((row) => (
              <li key={row.job}>
                <button
                  className="p-1 text-blue-700"
                  onClick={() => navigate(row.job, 'original', 'edit')}
                >
                  {row.case_id} · {row.job} · {row.reason}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function download(blob, name = 'hit-research.zip') {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ResearchExport({ user }) {
  const { data, error } = useResource(user ? prefix + '/candidates' : null);
  const [filters, setFilters] = useState({ case: '', job: '', author: '' });
  const [choices, setChoices] = useState({});
  const [excluded, setExcluded] = useState({});
  const [seed, setSeed] = useState('octa-hit-v1');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!user) return <p>请登录后导出研究数据。</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>正在读取通过复核的版本…</p>;
  const groups = new Map();
  for (const row of data.candidates) {
    if (
      !row.case_id.includes(filters.case) ||
      !row.job.includes(filters.job) ||
      !row.author.includes(filters.author)
    )
      continue;
    if (!groups.has(row.job)) groups.set(row.job, []);
    groups.get(row.job).push(row);
  }
  const batches = Array.from(groups, ([job, rows]) => ({
    job,
    rows,
    selected: rows.find((row) => row.version === choices[job]) ?? rows[0],
  }));
  const chosen = batches.filter((batch) => !excluded[batch.job]);
  async function exportSelected() {
    setBusy(true);
    setMessage('');
    try {
      const blob = await jsonPost(
        prefix + '/export',
        {
          versions: chosen.map((batch) => batch.selected.version),
          filters,
          seed: seed.trim(),
        },
        { responseType: 'blob' },
      );
      download(blob);
      setMessage('已生成包含 ' + chosen.length + ' 个批次的研究包。');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-semibold">研究数据导出</h2>
      <fieldset disabled={busy} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {Object.entries({ case: '病例', job: '批次', author: '修订作者' }).map(([key, name]) => (
            <label key={key} className="text-sm">
              {name}
              <input
                className="block w-full rounded border p-2"
                value={filters[key]}
                onChange={(e) => {
                  setFilters({ ...filters, [key]: e.target.value });
                  setMessage('');
                }}
              />
            </label>
          ))}
        </div>
        {batches.map(({ job, rows, selected }) => (
          <div key={job} className="flex flex-wrap items-center gap-3 border-t py-2">
            <label>
              <input
                type="checkbox"
                checked={!excluded[job]}
                onChange={(e) => setExcluded({ ...excluded, [job]: !e.target.checked })}
              />{' '}
              {selected.case_id} · {job}
            </label>
            <select
              className="select-input"
              aria-label={job + ' 已通过的版本'}
              value={selected.version}
              onChange={(e) => setChoices({ ...choices, [job]: e.target.value })}
            >
              {rows.map((row) => (
                <option key={row.version} value={row.version}>
                  {row.author} · {row.version.slice(0, 8)} ·{' '}
                  {new Date(row.decided).toLocaleString()}
                </option>
              ))}
            </select>
          </div>
        ))}
        {!batches.length && (
          <p className="text-sm text-slate-600">筛选范围内尚无通过复核的版本。</p>
        )}
        <label className="block text-sm">
          病例划分种子
          <input
            className="ml-2 rounded border p-2"
            value={seed}
            maxLength={128}
            onChange={(e) => setSeed(e.target.value)}
          />
        </label>
        <p className="text-sm">
          按病例固定划分训练、验证、测试集，比例为 80% / 10% / 10%。每个批次导出一份通过复核的修订。
        </p>
        <ExportPreview
          selection={chosen.map((batch) => batch.selected.version)}
          seed={seed}
          filters={filters}
        />
        <button
          className="btn-primary"
          disabled={!chosen.length || !seed.trim() || busy}
          onClick={exportSelected}
        >
          {busy ? '正在准备文件…' : '导出 ' + chosen.length + ' 个批次'}
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
