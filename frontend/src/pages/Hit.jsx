import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { deleteHitMask, fetchHitRun, fetchHitRuns, saveHitMask } from '../api.js';
import { useAuth } from '../auth.jsx';
import SegmentationView from '../components/views/SegmentationView.jsx';

const vessel = { key: 'largevessel', name: '大血管', color: '#f59e0b' };
const task = { id: 'hit', classes: [vessel] };
const projections = {
  full_projection: '全层投影', shallow_projection: '浅层投影',
  deep_projection: '深层投影', model_input: '模型输入',
};

export default function Hit() {
  const { user } = useAuth();
  const [runs, setRuns] = useState(null);
  const [params, setParams] = useSearchParams();
  const selected = params.get('run');
  const job = runs?.find(run => run.job_id === selected)?.job_id ?? runs?.[0]?.job_id ?? '';
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    fetchHitRuns().then(({ runs: items }) => {
      if (live) setRuns(items);
    }).catch(err => live && setError(err.message));
    return () => { live = false; };
  }, []);
  return (
    <section className="mx-auto max-w-[1500px] space-y-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">HIT 大血管复核</h1>
        {runs?.length > 0 && <label>病例与推理批次
          <select className="ml-2 rounded border p-2" value={job} disabled={editing}
            onChange={e => setParams({ run: e.target.value }, { replace: true })}>
            {runs.map(run => <option key={run.job_id} value={run.job_id}>{run.case_id} · {run.job_id}</option>)}
          </select>
        </label>}
      </header>
      {error && <p role="alert">{error}</p>}
      {!error && !job && <p>{runs ? '尚无已导入的 HIT 推理结果。' : '正在读取病例列表…'}</p>}
      {job && <Review key={JSON.stringify([job, user?.username])} job={job} user={user} setEditing={setEditing} />}
    </section>
  );
}

function Review({ job, user, setEditing }) {
  const [run, setRun] = useState(null);
  const [view, setView] = useState('');
  const [projection, setProjection] = useState('full_projection');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let live = true;
    setEditing(false);
    fetchHitRun(job).then(item => {
      if (!live) return;
      setRun(item);
      if (item.versions.some(v => v.username === user?.username)) setView(user.username);
    }).catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [job, user?.username, setEditing]);

  const show = name => {
    setEditing(false);
    setView(name);
    setGeneration(n => n + 1);
  };
  const reload = async name => {
    setRun(await fetchHitRun(job));
    show(name);
  };
  const remove = async () => {
    if (!window.confirm('删除本批次中我的修订版本？')) return;
    try {
      await deleteHitMask(job);
      await reload('');
    } catch (err) {
      setError(err.message);
    }
  };
  if (!run) return <p>{error || '正在读取推理结果…'}</p>;
  const version = run.versions.find(v => v.username === view);
  const outputs = run.outputs;
  return <>
    {error && <p role="alert">{error}</p>}
    <SegmentationView key={generation} task={task} sampleId={job} user={user}
      baseSrc={outputs[projection]} baseLabel="原始预测" viewing={view} annotators={run.versions}
      myVersion={run.versions.some(v => v.username === user?.username)}
      result={{ overlays: [{ ...vessel, mask_url: version?.mask_url ?? outputs.mask }] }}
      onViewChange={show} onEditChange={setEditing} onSaved={() => reload(user.username)}
      onDeleteVersion={remove} persistMasks={saveHitMask}
      resultControls={<div className="card space-y-3 p-4 text-sm">
        <label className="block font-semibold">投影底图
          <select className="mt-2 block w-full rounded border p-2" value={projection}
            onChange={e => setProjection(e.target.value)}>
            {Object.entries(projections).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select>
        </label>
        <p>阈值 {run.parameters.threshold} · 切块 {run.parameters.tile_size_px} px · 重叠 {run.parameters.tile_overlap * 100}%</p>
        <p className="break-all text-slate-500">{run.model.vessel_weight}</p>
        <div className="flex flex-wrap gap-3 text-blue-700">
          <a href={outputs.boundary_qc} target="_blank" rel="noreferrer">查看层边界质控图</a>
          <a href={outputs.probability} download>下载概率图</a>
          <a href={version?.mask_url ?? outputs.mask} download>下载当前掩膜</a>
        </div>
      </div>}
    />
  </>;
}
