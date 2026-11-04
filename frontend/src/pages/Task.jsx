import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AlertCircle, RefreshCw, SearchX } from 'lucide-react';
import {
  deleteAnnotation,
  fetchAnnotators,
  fetchModels,
  fetchMyAnnotation,
  fetchSamples,
  runInference,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import ModelSelect from '../components/ModelSelect.jsx';
import SamplePicker from '../components/SamplePicker.jsx';
import Faz3dView from '../components/views/Faz3dView.jsx';
import FazView from '../components/views/FazView.jsx';
import LayersView from '../components/views/LayersView.jsx';
import VesselView from '../components/views/VesselView.jsx';

/** taskId → 任务视图组件 */
const VIEWS = { vessel: VesselView, faz: FazView, layers: LayersView, faz3d: Faz3dView };

/**
 * 任务页：顶栏（任务信息 + 样本/模型选择器）+ 主区（影像查看器 + 控制侧栏）。
 * 负责样本/模型数据获取与推理调度；并管理标注版本状态（查看谁的版本）：
 * 登录用户保存过自己的版本时默认展示自己的版本，可切换原始 GT / 他人版本。
 */
export default function Task() {
  const { taskId } = useParams();
  const { tasks, tasksLoading, tasksError, reloadTasks } = useOutletContext();
  const { user } = useAuth();
  const task = tasks.find(t => t.id === taskId);

  const [samples, setSamples] = useState(null); // null = 加载中
  const [models, setModels] = useState(null); // null = 加载中
  const [sampleId, setSampleId] = useState('');
  const [model, setModel] = useState('');
  const [result, setResult] = useState(null); // POST /api/infer 结果
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [runId, setRunId] = useState(0); // 每次成功推理自增，驱动视图复位内部状态

  // ---- 标注版本状态 ----
  const [viewAs, setViewAs] = useState(''); // '' = 原始 GT，否则用户名
  const [viewTouched, setViewTouched] = useState(false); // 用户手动切换过后不再自动改变
  const [annotators, setAnnotators] = useState([]);
  const [myVersion, setMyVersion] = useState(false);

  useEffect(() => {
    fetchSamples()
      .then(data => setSamples(Array.isArray(data?.samples) ? data.samples : []))
      .catch(() => setSamples([]));
    fetchModels()
      .then(data => setModels(Array.isArray(data?.models) ? data.models : []))
      .catch(() => setModels([]));
  }, []);

  // 默认选中第一个样本 / 第一个可用模型
  useEffect(() => {
    if (samples?.length && !samples.some(s => s.id === sampleId)) {
      setSampleId(samples[0].id);
    }
  }, [samples, sampleId]);

  useEffect(() => {
    if (models?.length && !models.some(m => m.id === model)) {
      setModel(models.find(m => m.available)?.id ?? '');
    }
  }, [models, model]);

  // 样本/任务/用户变化：刷新标注版本列表与「我是否有版本」（可编辑任务才有版本概念）
  const editableTask = Boolean(VIEWS[taskId] && taskId !== 'layers');
  useEffect(() => {
    if (!sampleId || !editableTask) {
      setAnnotators([]);
      setMyVersion(false);
      return undefined;
    }
    let alive = true;
    fetchAnnotators(sampleId, taskId)
      .then(data => alive && setAnnotators(Array.isArray(data?.annotators) ? data.annotators : []))
      .catch(() => alive && setAnnotators([]));
    if (user) {
      fetchMyAnnotation(sampleId, taskId)
        .then(data => alive && setMyVersion(Boolean(data?.has)))
        .catch(() => alive && setMyVersion(false));
    } else {
      setMyVersion(false);
    }
    return () => {
      alive = false;
    };
  }, [sampleId, taskId, user, editableTask]);

  // 自动查看策略：登出后强制回到原始 GT；登录且未手动切换过版本时，
  // 若有自己的版本则默认查看自己的
  useEffect(() => {
    if (!user) {
      setViewAs('');
      return;
    }
    if (!viewTouched) setViewAs(myVersion ? user.username : '');
  }, [user, myVersion, viewTouched]);

  /** 运行推理；viewAsOverride 供版本切换/保存后立即以新版本重跑 */
  const handleRun = async (viewAsOverride) => {
    if (!sampleId || running) return;
    setRunning(true);
    setRunError(null);
    try {
      const data = await runInference({
        task_id: taskId,
        sample_id: sampleId,
        model,
        view_as: viewAsOverride !== undefined ? viewAsOverride : viewAs,
      });
      setResult(data);
      setRunId(prev => prev + 1);
    } catch (err) {
      setRunError(err.message);
    } finally {
      setRunning(false);
    }
  };

  /** 切换查看的标注版本：立即以该版本重新推理 */
  const handleViewChange = useCallback(
    name => {
      setViewTouched(true);
      setViewAs(name);
      handleRun(name);
    },
    [sampleId, model, viewAs, running],
  );

  /** 保存成功后：刷新版本列表、切到我的版本并重跑推理 */
  const handleSaved = useCallback(() => {
    setViewTouched(true);
    setMyVersion(true);
    const mine = user?.username ?? '';
    setViewAs(mine);
    fetchAnnotators(sampleId, taskId)
      .then(data => setAnnotators(Array.isArray(data?.annotators) ? data.annotators : []))
      .catch(() => {});
    handleRun(mine);
  }, [sampleId, taskId, user, model, viewAs, running]);

  /** 删除我的版本（恢复原始 GT）后：刷新状态并切回原始 GT */
  const handleDeleteVersion = useCallback(async () => {
    if (!window.confirm('确定删除我的标注版本？此后展示原始 GT（可重新标注）。')) return;
    try {
      await deleteAnnotation(sampleId, taskId);
    } catch (err) {
      setRunError(err.message);
      return;
    }
    setMyVersion(false);
    handleViewChange('');
  }, [sampleId, taskId, handleViewChange]);

  /** 切换样本后清除上一次推理结果 */
  const handleSampleChange = id => {
    setSampleId(id);
    setResult(null);
    setRunError(null);
    setViewTouched(false); // 换样本后重新启用自动查看策略
  };

  const View = VIEWS[taskId];
  const sample = samples?.find(s => s.id === sampleId) ?? null;

  let content;
  if (tasksLoading && !task) {
    content = <PageSkeleton />;
  } else if (!task) {
    content = (
      <NoticePanel
        title={tasksError ? '任务列表加载失败' : '未找到该任务'}
        detail={tasksError ?? `任务 “${taskId}” 不在当前任务列表中。`}
        action={tasksError ? { label: '重试', onClick: reloadTasks } : { label: '返回首页', to: '/' }}
      />
    );
  } else {
    content = (
      <>
        {/* 顶栏 */}
        <div className="card flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-slate-800">
              {task.name}
              <span className="ml-2 text-sm font-normal text-slate-400">{task.en}</span>
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-slate-500">{task.desc}</p>
          </div>
          <div className="flex w-full shrink-0 flex-col gap-3 sm:flex-row lg:w-auto">
            <div className="w-full sm:w-64">
              <SamplePicker samples={samples ?? []} value={sampleId} onChange={handleSampleChange} disabled={!samples} />
            </div>
            <div className="w-full sm:w-64">
              <ModelSelect models={models ?? []} value={model} onChange={setModel} disabled={!models} />
            </div>
          </div>
        </div>

        {/* 空样本提示（后端未就绪等） */}
        {samples && samples.length === 0 && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            暂无样本 — 后端服务可能尚未就绪，请稍后再试。
          </div>
        )}

        <div className="mt-6">
          {View ? (
            <View
              key={`${taskId}-${sampleId}-${runId}`}
              task={task}
              sampleId={sampleId}
              sample={sample}
              result={result}
              running={running}
              runId={runId}
              runError={runError}
              onRun={() => handleRun()}
              user={user}
              viewing={viewAs}
              annotators={annotators}
              myVersion={myVersion}
              onViewChange={handleViewChange}
              onSaved={handleSaved}
              onDeleteVersion={handleDeleteVersion}
            />
          ) : (
            <div className="card p-12 text-center text-sm text-slate-500">该任务的展示视图暂未实现。</div>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-8">
      {content}
    </div>
  );
}

/** 任务页数据加载中的骨架屏 */
function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-[104px] animate-pulse rounded-xl bg-slate-200/70" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-[440px] animate-pulse rounded-xl bg-slate-200/70" />
        <div className="space-y-4">
          {[104, 150, 150].map((height, i) => (
            <div key={i} style={{ height }} className="animate-pulse rounded-xl bg-slate-200/70" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 居中提示面板（任务不存在 / 任务列表加载失败）。
 * @param {{title: string, detail: string, action?: {label: string, onClick?: () => void, to?: string}}} props
 */
function NoticePanel({ title, detail, action }) {
  return (
    <div className="card mx-auto mt-16 flex max-w-md flex-col items-center gap-3 px-8 py-12 text-center">
      <SearchX className="h-8 w-8 text-slate-300" />
      <h2 className="text-base font-semibold text-slate-700">{title}</h2>
      <p className="text-sm text-slate-500">{detail}</p>
      {action &&
        (action.to ? (
          <Link to={action.to} className="btn-primary mt-1">
            {action.label}
          </Link>
        ) : (
          <button type="button" onClick={action.onClick} className="btn-primary mt-1">
            <RefreshCw className="h-4 w-4" /> {action.label}
          </button>
        ))}
    </div>
  );
}
