import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { fetchMe, login as apiLogin, register as apiRegister, setAuthToken } from './api.js';

/**
 * 全局登录态上下文：token 持久化在 localStorage（由 api.js 管理），
 * user 信息存内存 + localStorage，刷新页面后通过 fetchMe 校验 token 有效性。
 */
const AuthContext = createContext(null);

const USER_KEY = 'octa_user';

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => readStoredUser());

  const applySession = useCallback((data) => {
    // data: {token, user}（register / login 的返回）
    setAuthToken(data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  const login = useCallback(async (username, password) => {
    applySession(await apiLogin(username, password));
  }, [applySession]);

  const register = useCallback(async (username, password) => {
    applySession(await apiRegister(username, password));
  }, [applySession]);

  // 启动时校验持久化的 token（过期/无效则静默登出）
  useEffect(() => {
    if (!localStorage.getItem('octa_token')) return;
    fetchMe().catch(() => logout());
  }, [logout]);

  const value = useMemo(
    () => ({ user, login, register, logout }),
    [user, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
