import { useState } from 'react';
import { versionName } from './api.js';

const sources = {
  threshold: '阈值预览',
  revision: '历史修订',
  original: '原始预测',
  legacy: '已有个人修订',
};

function ancestors(selected, byId) {
  const chain = [];
  const seen = new Set();
  let item = selected;
  while (item && !seen.has(item.id)) {
    chain.push(item);
    seen.add(item.id);
    item = byId.get(item.parent);
  }
  return chain;
}

export default function RevisionHistory({ run, version, disabled, navigate }) {
  const [query, setQuery] = useState('');
  const [onlyLine, setOnlyLine] = useState(false);
  const byId = new Map(run.history.map((item) => [item.id, item]));
  const rows = (onlyLine ? ancestors(version, byId) : run.history).filter((item) =>
    [item.username, item.id, sources[item.source]].some((text) => text?.includes(query.trim())),
  );
  return (
    <details className="card p-4 text-sm">
      <summary className="cursor-pointer font-semibold">版本历史（{run.history.length}）</summary>
      <fieldset className="mt-3 space-y-3" disabled={disabled}>
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="rounded border p-2"
            placeholder="作者、版本或来源"
            aria-label="筛选修订历史"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {version && (
            <label>
              <input
                type="checkbox"
                checked={onlyLine}
                onChange={(e) => setOnlyLine(e.target.checked)}
              />{' '}
              仅看所选版本及其来源
            </label>
          )}
        </div>
        <ul className="max-h-80 divide-y overflow-auto">
          {rows.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <button
                  className="text-blue-700"
                  onClick={() => navigate(run.job_id, item.id, 'edit')}
                >
                  {versionName(item)}
                </button>
                <p className="text-xs text-slate-600">
                  {sources[item.source]} {item.threshold ?? ''}
                  {item.current && ' · 当前个人版本'}
                </p>
              </div>
              <button
                className="text-blue-700"
                onClick={() => navigate(run.job_id, item.id, 'compare')}
              >
                与原始预测比较
              </button>
            </li>
          ))}
        </ul>
        {!rows.length && <p>当前条件下没有修订记录。</p>}
      </fieldset>
    </details>
  );
}
