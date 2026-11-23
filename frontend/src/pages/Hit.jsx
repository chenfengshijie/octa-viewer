import RunProvenance from '../components/hit/RunProvenance.jsx';
import useRevisionSave from '../components/hit/useRevisionSave.js';
import SaveConflict from '../components/hit/SaveConflict.jsx';
import RevisionHistory from '../components/hit/RevisionHistory.jsx';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { deleteHitMask } from '../api.js';
import { useAuth } from '../auth.jsx';
import SegmentationView from '../components/views/SegmentationView.jsx';
import Comparison, { VersionSelect } from '../components/hit/Comparison.jsx';
import Probability from '../components/hit/Probability.jsx';
import QualityControl from '../components/hit/QualityControl.jsx';
import ReviewPanel from '../components/hit/ReviewPanel.jsx';
import { Agreement, ResearchExport } from '../components/hit/ResearchPanel.jsx';
import useResource from '../components/hit/useResource.js';
import { ORIGINAL, probabilityPath, runPath, versionName } from '../components/hit/api.js';

const vessel = { key: 'largevessel', name: '大血管', color: '#f59e0b' };
const task = { id: 'hit', classes: [vessel] };
const projections = {
  full_projection: '全层投影',
  shallow_projection: '浅层投影',
  deep_projection: '深层投影',
  model_input: '模型输入',
};
const tabs = {
  edit: '影像与修订',
  compare: '版本对比',
  probability: '概率与阈值',
  reviews: '成员互审',
  qc: '分层质控',
  agreement: '批次统计',
  export: '研究导出',
};

export default function Hit() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data, error } = useResource('/api/hit/runs');
  const [editing, setEditing] = useState(false);
  const job = params.get('run') || data?.runs[0]?.job_id;
  function navigate(nextJob, version, tab = 'edit', round = null, reference = null) {
    const query = { run: nextJob, tab };
    if (version) query.version = version;
    if (round) query.round = round;
    if (reference) query.reference = reference;
    setParams(query, { replace: true });
  }
  return (
    <section className="mx-auto max-w-[1500px] space-y-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">HIT 大血管复核</h1>
        {data?.runs.length > 0 && (
          <label>
            病例与推理批次
            <select
              className="select-input ml-2"
              value={job}
              disabled={editing}
              onChange={(e) => navigate(e.target.value, null)}
            >
              {data.runs.map((run) => (
                <option key={run.job_id} value={run.job_id}>
                  {run.case_id} · {run.job_id}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>正在读取病例列表…</p>}
      {data && !job && <p>尚无已导入的 HIT 推理结果。</p>}
      {job && data && (
        <Workspace
          key={JSON.stringify([job, user?.username])}
          job={job}
          user={user}
          params={params}
          navigate={navigate}
          editing={editing}
          setEditing={setEditing}
        />
      )}
    </section>
  );
}

function Workspace({ job, user, params, navigate, editing, setEditing }) {
  const [generation, setGeneration] = useState(0);
  const [projection, setProjection] = useState('full_projection');
  const [seed, setSeed] = useState(null);
  const save = useRevisionSave();
  const [actionError, setActionError] = useState('');
  const { data: run, error } = useResource(runPath(job), generation);
  useEffect(() => {
    setEditing(false);
    return () => setEditing(false);
  }, [setEditing]);
  if (error) return <p role="alert">{error}</p>;
  if (!run) return <p>正在读取批次…</p>;
  const myHead = run.versions.find((v) => v.username === user?.username);
  const selected = params.get('version') ?? myHead?.id ?? ORIGINAL;
  const version = run.history.find((v) => v.id === selected);
  if (selected !== ORIGINAL && !version) {
    return (
      <p role="alert">
        本批次中没有所选的版本。
        <button onClick={() => navigate(job, ORIGINAL)} className="ml-2 text-blue-700">
          返回原始预测
        </button>
      </p>
    );
  }
  const requestedTab = params.get('tab');
  const tab = Object.hasOwn(tabs, requestedTab) ? requestedTab : 'edit';
  function show(nextJob, versionId, nextTab = tab, round = null, reference = null) {
    save.clear();
    if (
      nextJob === job &&
      versionId &&
      versionId !== ORIGINAL &&
      !run.history.some((item) => item.id === versionId)
    )
      setGeneration((value) => value + 1);
    setSeed(null);
    setActionError('');
    navigate(nextJob, versionId, nextTab, round, reference);
  }
  function refresh(identity) {
    setEditing(false);
    setGeneration((value) => value + 1);
    show(job, identity, 'edit');
  }
  async function reset() {
    if (!window.confirm('将我的当前版本恢复为原始预测？历史修订仍可查阅。')) return;
    try {
      await deleteHitMask(job, myHead.id);
      refresh(ORIGINAL);
    } catch (err) {
      setActionError(err.message);
    }
  }
  const mask =
    seed !== null ? probabilityPath(job, 'mask', seed) : (version?.mask_url ?? run.outputs.mask);
  return (
    <>
      <nav aria-label="HIT 工作区" className="flex flex-wrap gap-1 border-b pb-2">
        {Object.entries(tabs).map(([key, title]) => (
          <button
            key={key}
            disabled={editing}
            aria-current={tab === key ? 'page' : undefined}
            className={
              tab === key
                ? 'btn-primary'
                : 'rounded px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50'
            }
            onClick={() => show(job, selected, key)}
          >
            {title}
          </button>
        ))}
      </nav>
      {['edit', 'compare', 'reviews'].includes(tab) && (
        <VersionSelect
          label="当前修订版本"
          value={selected}
          history={run.history}
          disabled={editing}
          onChange={(id) => show(job, id)}
        />
      )}
      {['edit', 'compare', 'probability', 'qc'].includes(tab) && (
        <label className="block text-sm">
          投影底图
          <select
            className="select-input ml-2"
            value={projection}
            disabled={editing}
            onChange={(e) => setProjection(e.target.value)}
          >
            {Object.entries(projections).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {tab === 'edit' && (
        <SegmentationView
          key={selected + ':' + seed}
          task={task}
          sampleId={job}
          user={user}
          baseSrc={run.outputs[projection]}
          baseLabel="原始预测"
          viewing={version?.username ?? ''}
          annotators={[]}
          customHistory
          myVersion={false}
          onEditChange={(value) => {
            setEditing(value);
            if (!value) save.clear();
          }}
          result={{ overlays: [{ ...vessel, mask_url: mask }] }}
          onSaved={(saved) => refresh(saved.id)}
          persistMasks={(jobId, taskId, payload) =>
            save.persist(jobId, taskId, payload, user.username, {
              expected_head: myHead?.id ?? null,
              parent: version?.id ?? null,
              threshold: seed,
            })
          }
          resultControls={
            <section className="card space-y-3 p-4 text-sm">
              <SaveConflict conflict={save.conflict} onKeep={save.keepDraft} />
              <h2 className="font-semibold">
                {seed === null ? versionName(version) : '阈值预览 · ' + seed}
              </h2>
              <p>
                模型阈值 {run.parameters.threshold} · 切块 {run.parameters.tile_size_px} px · 重叠{' '}
                {run.parameters.tile_overlap * 100}%
              </p>
              <p className="break-all text-slate-600">{run.model.vessel_weight}</p>
              {version?.source === 'threshold' && <p>修订起点 · 概率阈值 {version.threshold}</p>}
              {version?.parent && (
                <button
                  className="text-blue-700"
                  disabled={editing}
                  onClick={() => show(job, version.parent)}
                >
                  查看来源版本
                </button>
              )}
              <div className="flex flex-wrap gap-3 text-blue-700">
                <a href={run.outputs.boundary_qc} target="_blank" rel="noreferrer">
                  查看质控图
                </a>
                <a href={run.outputs.probability} download>
                  下载概率图
                </a>
                <a href={mask} download="mask.png">
                  下载当前掩膜
                </a>
              </div>
              {myHead && !editing && (
                <button className="text-blue-700" onClick={reset}>
                  恢复原始预测
                </button>
              )}
            </section>
          }
        />
      )}
      {tab === 'edit' && (
        <RevisionHistory run={run} version={version} disabled={editing} navigate={show} />
      )}
      {tab === 'edit' && <RunProvenance run={run} />}
      {tab === 'compare' && (
        <Comparison
          key={selected + ':' + params.get('reference')}
          initialReference={params.get('reference')}
          run={run}
          version={version}
          projection={projection}
        />
      )}
      {tab === 'probability' && (
        <Probability
          run={run}
          projection={projection}
          user={user}
          onSeed={(threshold) => {
            navigate(job, ORIGINAL, 'edit');
            setSeed(threshold);
          }}
        />
      )}
      {tab === 'qc' && <QualityControl run={run} projection={projection} params={params} />}
      {tab === 'reviews' && (
        <ReviewPanel
          run={run}
          version={version}
          user={user}
          selected={params.get('round')}
          navigate={show}
        />
      )}
      {tab === 'agreement' && <Agreement navigate={show} />}
      {tab === 'export' && <ResearchExport user={user} />}
    </>
  );
}
