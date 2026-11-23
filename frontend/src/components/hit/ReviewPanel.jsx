import ReviewImage from './ReviewImage.jsx';
import { QueueSummary, ReviewTrail } from './ReviewTrail.jsx';
import { useState } from 'react';
import { jsonPost, runPath, versionName } from './api.js';
import useResource from './useResource.js';

const labels = { pending: '待复核', approved: '已通过', returned: '已退回' };
const reviewsPath = '/api/hit/reviews';

function time(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function Submission({ run, version, rounds, refresh, busy, perform }) {
  const [reason, setReason] = useState('');
  const [previous, setPrevious] = useState('');
  const last = rounds.find((row) => row.version === version.id);
  const parents = rounds.filter(
    (row) =>
      row.job === run.job_id &&
      row.author === version.username &&
      row.state === 'returned' &&
      !row.successor,
  );
  if (last && (last.state !== 'returned' || last.successor)) {
    return <p className="text-sm">此版本最近一轮为{labels[last.state]}。</p>;
  }
  const prev = last?.id ?? previous;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        perform(async () => {
          await jsonPost(runPath(run.job_id) + '/reviews', {
            version: version.id,
            previous: prev || null,
            reason,
          });
          refresh();
        });
      }}
    >
      <p className="text-sm">送审版本 · {versionName(version)}</p>
      {parents.length > 0 && (
        <label className="block text-sm">
          关联退回轮次
          <select
            className="select-input block w-full"
            value={prev}
            disabled={Boolean(last)}
            onChange={(e) => setPrevious(e.target.value)}
          >
            <option value="">独立提交</option>
            {parents.map((row) => (
              <option value={row.id} key={row.id}>
                {time(row.submitted)} · {row.version.slice(0, 6)}
              </option>
            ))}
          </select>
        </label>
      )}
      {prev && (
        <label className="block text-sm">
          重提说明
          <textarea
            className="block w-full rounded border p-2"
            maxLength={4000}
            value={reason}
            required={Boolean(last)}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      <button className="btn-primary" disabled={busy || (Boolean(last) && !reason.trim())}>
        提交复核
      </button>
    </form>
  );
}

function RoundDetail({ run, round, user, generation, perform, refresh, busy, openPrevious }) {
  const { data, error } = useResource(reviewsPath + '/' + round.id, generation);
  const [body, setBody] = useState('');
  const [point, setPoint] = useState(null);
  const [note, setNote] = useState('');
  const version = run.history.find((item) => item.id === round.version);
  if (error) return <p role="alert">{error}</p>;
  if (!data || !version) return <p>正在读取轮次…</p>;
  const pending = data.state === 'pending';
  const prefix = reviewsPath + '/' + round.id;
  const decide = (outcome) =>
    perform(async () => {
      await jsonPost(prefix + '/decision', { outcome, note });
      refresh();
    });
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h3 className="font-semibold">
        {labels[data.state]} · {versionName(version)}
      </h3>
      {data.previous && (
        <button className="text-blue-700" onClick={() => openPrevious(data.previous)}>
          查看关联的上轮意见
        </button>
      )}
      {data.reason && <p className="whitespace-pre-wrap">重提说明 · {data.reason}</p>}
      <ReviewImage
        round={round.id}
        comments={data.comments}
        run={run}
        version={version}
        point={point}
        onPoint={setPoint}
        interactive={pending}
      />
      <ul className="space-y-2">
        {data.comments.map((item) => (
          <li key={item.id} className="rounded bg-slate-50 p-2 text-sm">
            <p>
              {item.author} · {time(item.created)}
              {item.x !== null && (
                <button className="ml-2 text-blue-700" onClick={() => setPoint(item)}>
                  定位 ({item.x}, {item.y})
                </button>
              )}
            </p>
            <p className="whitespace-pre-wrap">{item.body}</p>
          </li>
        ))}
      </ul>
      {pending && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            perform(async () => {
              await jsonPost(prefix + '/comments', { body, x: point?.x, y: point?.y });
              setPoint(null);
              setBody('');
              refresh();
            });
          }}
        >
          <label className="block text-sm">
            复核意见
            <textarea
              value={body}
              maxLength={4000}
              className="mt-1 block w-full rounded border p-2"
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <p className="text-sm">
            {point ? `图上位置 (${point.x}, ${point.y})` : '点击图像可为意见标记位置'}
            {point && (
              <button className="ml-2 text-blue-700" type="button" onClick={() => setPoint(null)}>
                清除位置
              </button>
            )}
          </p>
          <button className="btn-primary" disabled={busy || !body.trim()}>
            保存意见
          </button>
        </form>
      )}
      {pending && data.author !== user.username && (
        <div className="space-y-2 border-t pt-3">
          <label className="block text-sm">
            结论说明
            <textarea
              value={note}
              maxLength={4000}
              className="block w-full rounded border p-2"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button className="btn-primary mr-2" disabled={busy} onClick={() => decide('approved')}>
            通过本轮
          </button>
          <button
            className="rounded border px-3 py-2"
            disabled={busy}
            onClick={() => decide('returned')}
          >
            退回作者
          </button>
        </div>
      )}
      {!pending && (
        <p className="whitespace-pre-wrap text-sm">
          {data.reviewer} · {time(data.decided)} · {labels[data.state]} {data.conclusion}
        </p>
      )}
    </section>
  );
}

export default function ReviewPanel({ run, version, user, selected, navigate }) {
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { data, error: readError } = useResource(user ? reviewsPath : null, generation);
  if (!user) return <p>请登录后查看复核队列与意见。</p>;
  const rounds = data?.rounds ?? [];
  const refresh = () => setGeneration((n) => n + 1);
  const perform = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err.message);
      if (err.status === 409) refresh();
    } finally {
      setBusy(false);
    }
  };
  const open = (row) => navigate(row.job, row.version, 'reviews', row.id);
  const active = rounds.find((row) => row.id === selected && row.job === run.job_id);
  const visible = rounds.filter(
    (row) =>
      (!state || row.state === state) &&
      (scope !== 'submitted' || (row.state === 'pending' && row.author === user.username)) &&
      (scope !== 'returned' ||
        (row.state === 'returned' && !row.successor && row.author === user.username)) &&
      (scope !== 'actionable' || (row.state === 'pending' && row.author !== user.username)) &&
      [row.case_id, row.job, row.author].some((value) => value.includes(search.trim())),
  );
  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-semibold">复核队列</h2>
      {data && (
        <QueueSummary
          rows={rounds}
          user={user}
          choose={(value) => {
            setScope(value);
            setState('');
            setSearch('');
          }}
        />
      )}
      {(error || readError) && <p role="alert">{error || readError}</p>}
      {data && version && version.username === user.username && (
        <Submission
          key={version.id}
          run={run}
          version={version}
          rounds={rounds}
          refresh={refresh}
          perform={perform}
          busy={busy}
        />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="rounded border p-2"
          aria-label="筛选病例、批次或作者"
          placeholder="病例、批次或作者"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select-input"
          aria-label="复核状态"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(labels).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
        <label>
          工作范围
          <select
            className="select-input ml-2"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="all">全部成员</option>
            <option value="actionable">可由我复核</option>
            <option value="returned">我的待处理退回</option>
            <option value="submitted">我的待复核版本</option>
          </select>
        </label>
        <button className="text-blue-700" onClick={refresh}>
          刷新队列
        </button>
      </div>
      {data && !visible.length && (
        <p className="text-sm text-slate-600">当前条件下没有复核轮次。</p>
      )}
      <ul className="max-h-72 divide-y overflow-y-auto">
        {visible.map((row) => (
          <li key={row.id}>
            <button
              className="w-full p-2 text-left text-sm hover:bg-slate-50"
              onClick={() => open(row)}
            >
              {labels[row.state]} · {row.case_id} · {row.job} · {row.author} · {time(row.submitted)}{' '}
              · {row.comment_count} 条意见
            </button>
          </li>
        ))}
      </ul>
      {active && (
        <ReviewTrail
          run={run}
          rounds={rounds}
          selected={active}
          open={open}
          compare={(row, parent) => navigate(row.job, row.version, 'compare', null, parent.version)}
        />
      )}
      {active && (
        <RoundDetail
          key={active.id}
          run={run}
          round={active}
          user={user}
          generation={generation}
          perform={perform}
          refresh={refresh}
          busy={busy}
          openPrevious={(id) => {
            const previous = rounds.find((row) => row.id === id);
            if (previous) open(previous);
          }}
        />
      )}
    </section>
  );
}
