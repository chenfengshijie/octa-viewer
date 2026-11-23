import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Activity, Box, CircleDot, Eye, Home, Layers, LogIn, LogOut, RefreshCw, Waypoints } from 'lucide-react';
import { fetchTasks } from '../api.js';
import { useAuth } from '../auth.jsx';
import AuthModal from './AuthModal.jsx';

/** 任务 id → 侧边栏图标（未识别的任务回退为 Activity） */
const TASK_ICONS = { vessel: Waypoints, faz: CircleDot, layers: Layers, faz3d: Box };

/**
 * 全局布局：左侧固定导航（Logo + 首页 + 任务列表 + 用户区），右侧内容区（Outlet）。
 * 任务列表在此统一获取，并通过 Outlet context 传给子页面。
 */
export default function Layout() {
  const { user, logout } = useAuth();
  const [state, setState] = useState({ tasks: [], loading: true, error: null });
  const [authOpen, setAuthOpen] = useState(false);
  const [authTab, setAuthTab] = useState('login');

  const openAuth = tab => {
    setAuthTab(tab);
    setAuthOpen(true);
  };

  const load = useCallback(() => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    fetchTasks()
      .then(data => setState({ tasks: Array.isArray(data?.tasks) ? data.tasks : [], loading: false, error: null }))
      .catch(err => setState({ tasks: [], loading: false, error: err.message }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 z-30 flex w-56 flex-col border-r border-slate-200 bg-white">
        {/* Logo */}
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
            <Eye className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold tracking-tight text-slate-800">OCTA-500 Lab</p>
            <p className="text-[11px] text-slate-400">视网膜影像分析平台</p>
          </div>
        </div>

        {/* 导航 */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          <NavItem to="/" end icon={Home} label="首页" />
          <NavItem to="/hit" icon={Waypoints} label="HIT 大血管复核" />
          {state.loading && (
            <div className="space-y-1 pt-1">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          )}
          {!state.loading &&
            state.tasks.map(task => {
              const Icon = TASK_ICONS[task.id] ?? Activity;
              return <NavItem key={task.id} to={`/task/${task.id}`} icon={Icon} label={task.name} />;
            })}
        </nav>

        {/* 用户区 */}
        <div className="border-t border-slate-100 p-3">
          {user ? (
            <div className="flex items-center gap-2.5 rounded-lg bg-slate-50 px-2.5 py-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
                {user.username.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-700">{user.username}</p>
                <p className="text-[10px] text-slate-400">已登录 · 可编辑标注</p>
              </div>
              <button
                type="button"
                onClick={logout}
                title="退出登录"
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-600"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => openAuth('login')}
                className="btn-primary h-8 flex-1 !px-2 text-xs"
              >
                <LogIn className="h-3.5 w-3.5" /> 登录
              </button>
              <button
                type="button"
                onClick={() => openAuth('register')}
                className="h-8 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-600 shadow-sm transition hover:border-blue-300 hover:text-blue-600"
              >
                注册
              </button>
            </div>
          )}
        </div>

        {/* 底部状态 */}
        <div className="border-t border-slate-100 px-4 py-3 text-[11px] leading-relaxed text-slate-400">
          {state.error ? (
            <div className="flex items-center justify-between gap-2">
              <span>任务列表加载失败</span>
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-blue-600 transition hover:bg-blue-50"
              >
                <RefreshCw className="h-3 w-3" /> 重试
              </button>
            </div>
          ) : (
            <p>系统设计 · 陈峰 / 王越琛 / 钟洺生</p>
          )}
        </div>
      </aside>

      <main className="ml-56 min-h-screen">
        <Outlet context={{ tasks: state.tasks, tasksLoading: state.loading, tasksError: state.error, reloadTasks: load }} />
      </main>

      <AuthModal open={authOpen} initialTab={authTab} onClose={() => setAuthOpen(false)} />
    </div>
  );
}

/**
 * 侧边导航项，当前路由高亮（蓝色左条 + 蓝底）。
 * @param {{to: string, icon: import('lucide-react').LucideIcon, label: string, end?: boolean}} props
 */
function NavItem({ to, icon: Icon, label, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `relative block rounded-lg px-3 py-2 text-sm transition ${
          isActive ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-blue-600" />}
          <span className="flex items-center gap-2.5">
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}
