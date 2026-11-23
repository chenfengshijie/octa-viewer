import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AlertCircle, Layers, PanelLeftOpen, RefreshCw, SearchX } from 'lucide-react';
import {
  deleteAnnotation,
  fetchAnnotators,
  fetchModels,
  fetchModelOutputs,
  fetchMyAnnotation,
  runEnsembleInference,
  fetchSamples,
  runInference,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import EnsembleBar from '../components/EnsembleBar.jsx';
import ModelSelect from '../components/ModelSelect.jsx';
import SampleSidebar from '../components/SampleSidebar.jsx';
import Faz3dView from '../components/views/Faz3dView.jsx';
import FazView from '../components/views/FazView.jsx';
import LayersView from '../components/views/LayersView.jsx';
import VesselView from '../components/views/VesselView.jsx';

/** taskId → 任务视图组件 */
const VIEWS = { vessel: VesselView, faz: FazView, layers: LayersView, faz3d: Faz3dView };

/**
 * 任务页：顶栏（任务信息 + 样本/模型选择器）+ 主区（影像查看器 + 控制侧栏）。
 * 负责样本/模型数据获取与推理调度；并管理标注版本状态（查看谁的版本）：
 * 登录用户保存过自己的版本时默认展示自己的版本，可切换模型输出 / 他人版本。
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
  const [modelTouched, setModelTouched] = useState(false); // 用户手动选过模型后，默认选择不再覆盖
  const [result, setResult] = useState(null); // POST /api/infer 结果
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [runId, setRunId] = useState(0); // 每次成功推理自增，驱动视图复位内部状态
  // 左侧样本面板折叠状态（跨会话记忆）
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('octa_sample_sidebar') !== 'hidden');
  const toggleSidebar = open => {
    setSidebarOpen(open);
    localStorage.setItem('octa_sample_sidebar', open ? 'open' : 'hidden');
  };

  // ---- 标注版本状态 ----
  const [viewAs, setViewAs] = useState(''); // '' = 模型输出，否则为用户名
  const [viewTouched, setViewTouched] = useState(false); // 用户手动切换过后不再自动改变
  const [annotators, setAnnotators] = useState([]);
  const [myVersion, setMyVersion] = useState(false);
  // 当前样本/任务下所有已保存的模型输出（单模型 + 融合输出）
  const [modelOutputs, setModelOutputs] = useState([]);
  // 多模型均值概率融合
  const [ensembleSelected, setEnsembleSelected] = useState([]);
  const [ensembleThreshold, setEnsembleThreshold] = useState(0.5);
  const [ensembleOpen, setEnsembleOpen] = useState(false);
  const [ensembleRunning, setEnsembleRunning] = useState(false);
  const [ensembleError, setEnsembleError] = useState(null);

  // 切换任务时清空上一次的推理结果与版本选择：Task 组件在 /task/:id 之间不会卸载，
  // 否则上一个任务的 overlays 会残留到新任务视图（类别 key 不匹配、掩膜错位）。
  useEffect(() => {
    setResult(null);
    setRunError(null);
    setViewTouched(false);
    setModelTouched(false);
    setEnsembleSelected([]);
    setEnsembleError(null);
  }, [taskId]);

  useEffect(() => {
    fetchSamples()
      .then(data => setSamples(Array.isArray(data?.samples) ? data.samples : []))
      .catch(() => setSamples([]));
  }, []);

  // 模型列表随「任务 + 当前样本」刷新：后端把任务与视场都匹配的模型排在前面。
  useEffect(() => {
    fetchModels({ task_id: taskId, sample_id: sampleId })
      .then(data => setModels(Array.isArray(data?.models) ? data.models : []))
      .catch(() => setModels([]));
  }, [taskId, sampleId]);

  // 默认选中第一个样本 / 第一个可用模型
  useEffect(() => {
    if (samples?.length && !samples.some(s => s.id === sampleId)) {
      setSampleId(samples[0].id);
    }
  }, [samples, sampleId]);

  // 默认模型：后端已按「任务匹配 + 视场匹配」排序，直接取第一个（最合适当前任务/样本）。
  useEffect(() => {
    if (!models?.length) return;
    const first = models.find(m => m.available)?.id ?? '';
    if (!first) return;
    if (!modelTouched || !models.some(m => m.id === model)) {
      if (first !== model) setModel(first);
    }
  }, [models, model, modelTouched]);

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

  // 自动查看策略：登出后强制回到模型输出；登录且未手动切换过版本时，
  // 若有自己的版本则默认查看自己的
  useEffect(() => {
    if (!user) {
      setViewAs('');
      return;
    }
    if (!viewTouched) setViewAs(myVersion ? user.username : '');
  }, [user, myVersion, viewTouched]);

  /** 当前样本/任务下所有已保存的模型推理结果（只读查询，不会触发推理） */
  const refreshModelOutputs = useCallback(() => {
    if (!sampleId || !editableTask) {
      setModelOutputs([]);
      return;
    }
    fetchModelOutputs(sampleId, taskId)
      .then(data => setModelOutputs(Array.isArray(data?.outputs) ? data.outputs : []))
      .catch(() => setModelOutputs([]));
  }, [sampleId, taskId, editableTask]);

  useEffect(() => {
    refreshModelOutputs();
  }, [refreshModelOutputs]);

  /** 运行推理；viewAsOverride 供版本切换/保存后立即以新版本重跑 */
  const handleRunEnsemble = useCallback(async () => {
    if (!sampleId || ensembleRunning || ensembleSelected.length < 2) return;
    setEnsembleRunning(true);
    setEnsembleError(null);
    try {
      const data = await runEnsembleInference({
        task_id: taskId, sample_id: sampleId,
        models: ensembleSelected, threshold: ensembleThreshold,
      });
      setViewTouched(true);
      setViewAs('');
      setResult(data);
      setRunId(prev => prev + 1);
      refreshModelOutputs();
    } catch (err) {
      setEnsembleError(err.message);
    } finally {
      setEnsembleRunning(false);
    }
  }, [sampleId, taskId, ensembleSelected, ensembleThreshold, ensembleRunning, refreshModelOutputs]);

  const handleToggleEnsembleModel = useCallback(modelId => {
    setEnsembleSelected(prev => (prev.includes(modelId)
      ? prev.filter(id => id !== modelId)
      : [...prev, modelId].slice(0, 8)));
  }, []);

  const handleRun = async (viewAsOverride, modelIdOverride) => {
    if (!sampleId || running) return;
    setRunning(true);
    setRunError(null);
    try {
      const data = await runInference({
        task_id: taskId,
        sample_id: sampleId,
        model: modelIdOverride ?? model,
        view_as: viewAsOverride !== undefined ? viewAsOverride : viewAs,
      });
      setResult(data);
      setRunId(prev => prev + 1);
      refreshModelOutputs();
    } catch (err) {
      setRunError(err.message);
    } finally {
      setRunning(false);
    }
  };

  // 切换模型：绝不把上一个模型的结果展示成新模型的结果。
  // 该模型已有保存结果则直接读取（后端缓存命中，不重新推理）；否则清空，等用户点运行。
  useEffect(() => {
    if (!model || viewAs) return; // 正在查看标注版本时不受模型切换影响
    if (result?.kind === 'ensemble') return; // 融合结果是显式选择的视图，不被单模型自动加载覆盖
    if (result?.model === model) return;
    if (modelOutputs.some(item => item.kind !== 'ensemble' && item.model_id === model)) {
      handleRun('');
    } else {
      setResult(null);
      setRunError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, modelOutputs, viewAs, result]);

  /** 运行推理按钮：始终运行当前选择的模型、展示模型输出。
   *  保存标注后界面会停在"我的版本"，若这里继续带 view_as 就会跳过推理并混入标注结果。 */
  const handleRunModel = useCallback(() => {
    setViewTouched(true);
    setViewAs('');
    handleRun('');
  }, [handleRun]);

  /** 点击“标注版本”里的模型/融合输出：切换到该结果（融合结果读取缓存，不重复推理） */
  const handleViewModelOutput = useCallback(
    output => {
      if (!output) return;
      setViewTouched(true);
      setModelTouched(true);
      setViewAs('');
      if (output.kind === 'ensemble') {
        setEnsembleRunning(true);
        setEnsembleError(null);
        runEnsembleInference({
          task_id: taskId, sample_id: sampleId,
          models: output.model_ids, threshold: output.threshold ?? 0.5,
        })
          .then(data => {
            setResult(data);
            setRunId(prev => prev + 1);
            refreshModelOutputs();
          })
          .catch(err => setEnsembleError(err.message))
          .finally(() => setEnsembleRunning(false));
        return;
      }
      setModel(output.model_id);
      handleRun('', output.model_id);
    },
    [taskId, sampleId, handleRun, refreshModelOutputs],
  );

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
    refreshModelOutputs();
    handleRun(mine);
  }, [sampleId, taskId, user, model, viewAs, running]);

  /** 删除我的标注版本后：刷新状态并切回模型输出 */
  const handleDeleteVersion = useCallback(async () => {
    if (!window.confirm('确定删除我的标注版本？此后展示模型输出（可重新标注）。')) return;
    try {
      await deleteAnnotation(sampleId, taskId);
    } catch (err) {
      setRunError(err.message);
      return;
    }
    setMyVersion(false);
    // 删除后版本列表必须立即刷新，否则被删用户仍显示在“标注版本”里。
    fetchAnnotators(sampleId, taskId)
      .then(data => setAnnotators(Array.isArray(data?.annotators) ? data.annotators : []))
      .catch(() => setAnnotators([]));
    handleViewChange('');
  }, [sampleId, taskId, handleViewChange]);

  /** 切换样本后清除上一次推理结果 */
  const handleSampleChange = id => {
    setSampleId(id);
    setResult(null);
    setRunError(null);
    setModelOutputs([]);
    setViewTouched(false); // 换样本后重新启用自动查看策略
    setModelTouched(false); // 换样本后回到"最合适当前样本"的默认模型
    setEnsembleSelected([]);
    setEnsembleError(null);
  };

  const activeOutput = viewAs === '' && result && !result.is_edited
    ? { kind: result.kind === 'ensemble' ? 'ensemble' : 'single',
        id: result.kind === 'ensemble' ? result.ensemble_id : result.model }
    : null;
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
        {/* 顶栏（样本切换已移至左侧样本面板；多模型融合放在模型栏内） */}
        <div className="card space-y-4 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold text-slate-800">
                {task.name}
                <span className="ml-2 text-sm font-normal text-slate-400">{task.en}</span>
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">{task.desc}</p>
            </div>
            <div className="w-full shrink-0 space-y-2 sm:w-72">
              <ModelSelect models={models ?? []} value={model} onChange={id => { setModelTouched(true); setModel(id); if (result?.kind === 'ensemble') setResult(null); }} disabled={!models} />
              <button
                type="button"
                onClick={() => setEnsembleOpen(open => !open)}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition hover:border-blue-300 hover:text-blue-600"
              >
                <Layers className="h-3.5 w-3.5" />
                {ensembleOpen ? '收起融合设置' : '多模型融合（最大概率）'}
              </button>
            </div>
          </div>
          {ensembleOpen && (
            <EnsembleBar
              models={models ?? []}
              selected={ensembleSelected}
              onToggle={handleToggleEnsembleModel}
              threshold={ensembleThreshold}
              onThresholdChange={setEnsembleThreshold}
              error={ensembleError}
            />
          )}
        </div>

        {/* 空样本提示（后端未就绪等） */}
        {samples && samples.length === 0 && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            暂无样本 — 后端服务可能尚未就绪，请稍后再试。
          </div>
        )}

        {/* 左：样本面板；右：任务视图 */}
        <div className="mt-6 flex flex-col gap-6 xl:flex-row">
          {sidebarOpen ? (
            <div className="w-full shrink-0 self-start xl:sticky xl:top-8 xl:max-h-[calc(100vh-4rem)] xl:w-64">
              <SampleSidebar
                samples={samples ?? []}
                value={sampleId}
                onChange={handleSampleChange}
                onCollapse={() => toggleSidebar(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => toggleSidebar(true)}
              title="展开样本列表"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center self-start rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-blue-300 hover:text-blue-600"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
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
                onRun={handleRunModel}
                onRunEnsemble={handleRunEnsemble}
                ensembleReady={ensembleSelected.length >= 2 && ensembleSelected.length <= 8}
                ensembleRunning={ensembleRunning}
                ensembleCount={ensembleSelected.length}
                modelOutputs={modelOutputs}
                activeOutput={activeOutput}
                onViewModelOutput={handleViewModelOutput}
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
      <div className="flex flex-col gap-6 xl:flex-row">
        <div className="h-72 w-full shrink-0 animate-pulse rounded-xl bg-slate-200/70 xl:w-64" />
        <div className="min-w-0 flex-1">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="h-[440px] animate-pulse rounded-xl bg-slate-200/70" />
            <div className="space-y-4">
              {[104, 150, 150].map((height, i) => (
                <div key={i} style={{ height }} className="animate-pulse rounded-xl bg-slate-200/70" />
              ))}
            </div>
          </div>
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
