import { useState } from 'react';
import useResource from './useResource.js';
import { versionName } from './api.js';

const names = { pending: '待复核', returned: '已退回', approved: '已通过' };

function trail(rows, selected) {
  const indexed = new Map(rows.map((row) => [row.id, row]));
  let first = selected;
  const seen = new Set();
  while (first?.previous && indexed.has(first.previous) && !seen.has(first.id)) {
    seen.add(first.id);
    first = indexed.get(first.previous);
  }
  seen.clear();
  const chain = [];
  let row = first;
  while (row && !seen.has(row.id)) {
    chain.push(row);
    seen.add(row.id);
    row = indexed.get(row.successor);
  }
  return chain;
}

export function ReviewTrail({ run, selected, rounds, open, compare }) {
  const chain = trail(rounds, selected);
  const byId = new Map(run.history.map((v) => [v.id, v]));
  if (!chain.length) return null;
  return (
    <details className="rounded border p-3 text-sm" open={chain.length > 1 ? true : undefined}>
      <summary className="font-semibold">送审与重提历史（{chain.length} 轮）</summary>
      <ol className="mt-3 space-y-2 border-l pl-4">
        {chain.map((row, index) => {
          const parent = chain[index - 1];
          const same = parent?.version === row.version;
          return (
            <li key={row.id} className="space-y-1 rounded bg-slate-50 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <button className="text-blue-700" onClick={() => open(row)}>
                  第 {index + 1} 轮 · {names[row.state]}
                </button>
                <span>{new Date(row.submitted).toLocaleString()}</span>
                {row.id === selected.id && <span>当前查看</span>}
              </div>
              <p>{versionName(byId.get(row.version))}</p>
              {parent && <p>{same ? '原版附说明重提' : '修订后重新提交'}</p>}
              {row.reason && <p className="whitespace-pre-wrap">说明 · {row.reason}</p>}
              {row.reviewer && <p>复核人 · {row.reviewer}</p>}
              {parent && !same && (
                <button className="text-blue-700" onClick={() => compare(row, parent)}>
                  对照本轮与上轮掩膜
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export function QueueSummary({ rows, user, choose }) {
  const actionable = rows.filter((row) => row.state === 'pending' && row.author !== user.username);
  const mine = rows.filter(
    (row) => row.state === 'returned' && !row.successor && row.author === user.username,
  );
  const waiting = rows.filter((row) => row.state === 'pending' && row.author === user.username);
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-3">
      {[
        ['可由我复核', actionable, 'actionable'],
        ['我的待处理退回', mine, 'returned'],
        ['我的待复核版本', waiting, 'submitted'],
      ].map(([title, items, role]) => (
        <div key={role} className="rounded bg-slate-50 p-3">
          <dt>{title}</dt>
          <dd>
            <button className="font-mono text-xl text-blue-700" onClick={() => choose(role)}>
              {items.length}
            </button>
          </dd>
        </div>
      ))}
    </dl>
  );
}
