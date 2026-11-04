import { useEffect, useState } from 'react';
import { Eye, LogIn, UserPlus, X } from 'lucide-react';
import { useAuth } from '../auth.jsx';

/**
 * 登录 / 注册弹窗（两个 tab）。成功后自动关闭；输入校验与错误提示由后端返回的 detail 透出。
 * @param {{open: boolean, initialTab?: 'login'|'register', onClose: () => void}} props
 */
export default function AuthModal({ open, initialTab = 'login', onClose }) {
  const { login, register } = useAuth();
  const [tab, setTab] = useState(initialTab);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setError(null);
      setPassword('');
      setPassword2('');
    }
  }, [open, initialTab]);

  if (!open) return null;

  const switchTab = next => {
    setTab(next);
    setError(null);
  };

  const handleSubmit = async event => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (tab === 'register' && password !== password2) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      await (tab === 'register' ? register : login)(username.trim(), password);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="card w-full max-w-sm p-6" onClick={event => event.stopPropagation()}>
        {/* 标题 + tab 切换 */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
              <Eye className="h-4.5 w-4.5" />
            </span>
            <h2 className="text-base font-bold text-slate-800">
              {tab === 'login' ? '登录' : '注册'} · OCTA-500 Lab
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium">
          {[['login', '登录'], ['register', '注册']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => switchTab(key)}
              className={`rounded-md py-1.5 transition ${
                tab === key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">用户名</span>
            <input
              type="text"
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="2-32 位中文、字母、数字或下划线"
              autoFocus
              className="h-9 w-full rounded-lg border border-slate-200 px-2.5 text-sm text-slate-700 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">密码</span>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder={tab === 'register' ? '至少 6 位' : '输入密码'}
              className="h-9 w-full rounded-lg border border-slate-200 px-2.5 text-sm text-slate-700 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </label>
          {tab === 'register' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">确认密码</span>
              <input
                type="password"
                value={password2}
                onChange={event => setPassword2(event.target.value)}
                placeholder="再次输入密码"
                className="h-9 w-full rounded-lg border border-slate-200 px-2.5 text-sm text-slate-700 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </label>
          )}

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">{error}</p>
          )}

          <button type="submit" disabled={busy || !username || !password} className="btn-primary w-full">
            {tab === 'login' ? <LogIn className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
            {busy ? '请稍候…' : tab === 'login' ? '登录' : '注册并登录'}
          </button>

          <p className="text-center text-[11px] leading-relaxed text-slate-400">
            {tab === 'login' ? '还没有账号？点击上方「注册」创建' : '注册后即可编辑并保存自己的标注版本'}
          </p>
        </form>
      </div>
    </div>
  );
}
