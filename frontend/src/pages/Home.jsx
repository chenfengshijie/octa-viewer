/**
 * 首页：Hero + 任务卡片（GET /api/tasks）+ 页脚署名
 * 系统设计：陈峰 / 王越琛 / 钟洺生
 */
import { Link, useOutletContext } from 'react-router-dom';
import { ArrowRight, Database, Microscope, RefreshCw, ScanLine, Tags } from 'lucide-react';

/** Hero 区数据集徽标行 */
const HIGHLIGHTS = [
  { icon: Database, label: '500 眼' },
  { icon: ScanLine, label: '6mm / 3mm 扫描协议' },
  { icon: Tags, label: '8 类标注' },
];

/** 首页：Hero + 任务卡片（GET /api/tasks）+ 数据集说明 */
export default function Home() {
  const { tasks, tasksLoading, tasksError, reloadTasks } = useOutletContext();

  return (
    <div className="mx-auto max-w-[1400px] space-y-8 px-8 py-8">
      {/* Hero（浅色卡片，与全站卡片语言一致） */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white px-8 py-12 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-blue-600">
          <Microscope className="h-4 w-4" /> OCTA-500 Dataset
        </div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">视网膜影像分析与可视化平台</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600 md:text-base">
          基于 OCTA-500 数据集构建的科研展示平台，覆盖血管分割、FAZ 分割、视网膜分层与 FAZ
          三维浏览四大任务，支持掩膜叠加、逐层切片浏览与实时指标量化。
        </p>
        <div className="mt-6 flex flex-wrap gap-2.5">
          {HIGHLIGHTS.map(({ icon: Icon, label }) => (
            <span
              key={label}
              className="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700"
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </span>
          ))}
        </div>
      </section>

      {/* 任务卡片 */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">分析任务</h2>
          <span className="text-sm text-slate-400">{tasksLoading ? '加载中…' : `共 ${tasks.length} 个`}</span>
        </div>

        {tasksLoading ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="card overflow-hidden">
                <div className="h-36 animate-pulse bg-slate-100" />
                <div className="space-y-2.5 p-5">
                  <div className="h-4 w-24 animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100" />
                </div>
              </div>
            ))}
          </div>
        ) : tasksError ? (
          <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
            <p className="text-sm text-slate-500">任务列表加载失败：{tasksError}</p>
            <button type="button" onClick={reloadTasks} className="btn-primary">
              <RefreshCw className="h-4 w-4" /> 重试
            </button>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {tasks.map(task => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        )}
      </section>

      {/* 页脚署名（低调小字） */}
      <footer className="pb-2 text-center text-xs text-slate-300">系统设计 · 陈峰 / 王越琛 / 钟洺生</footer>
    </div>
  );
}

/**
 * 任务卡片：黑底缩略图 + 名称/英文 + 描述 + 类别色点 + 「进入任务」。
 * @param {{task: {id: string, name: string, en: string, desc: string, classes?: Array<{key: string, name: string, color: string}>, thumb?: string}}} props
 */
function TaskCard({ task }) {
  return (
    <Link
      to={`/task/${task.id}`}
      className="card group flex flex-col overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex h-36 items-center justify-center bg-[#0b0f14]">
        {task.thumb ? (
          <img src={task.thumb} alt={task.name} loading="lazy" className="h-full w-full object-contain" />
        ) : (
          <Microscope className="h-10 w-10 text-slate-700" />
        )}
      </div>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="whitespace-nowrap font-semibold text-slate-800">{task.name}</h3>
          <span className="min-w-0 truncate text-right text-[11px] uppercase tracking-wide text-slate-400">{task.en}</span>
        </div>
        <p className="mt-2 line-clamp-2 flex-1 text-sm leading-relaxed text-slate-500">{task.desc}</p>
        {(task.classes?.length ?? 0) > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
            {task.classes.map(cls => (
              <span key={cls.key} className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: cls.color }} />
                {cls.name}
              </span>
            ))}
          </div>
        )}
        <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-blue-600 transition-all group-hover:gap-2">
          进入任务 <ArrowRight className="h-4 w-4" />
        </span>
      </div>
    </Link>
  );
}
