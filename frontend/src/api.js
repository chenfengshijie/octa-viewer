/**
 * 统一 fetch 封装。API base = ''，
 * 开发期由 Vite 代理（/api、/data → http://localhost:8000），生产环境同源部署。
 * 已登录时所有请求自动附带 Authorization: Bearer <token>。
 */
const BASE = '';

const TOKEN_KEY = 'octa_token';
let authToken = localStorage.getItem(TOKEN_KEY);

/** 登录态变化时由 auth 上下文调用；token=null 表示登出。 */
export function setAuthToken(token) {
  authToken = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export const getAuthToken = () => authToken;

/** @param {string} path 相对 API 路径 @param {object} options fetch 参数 */
async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  let res;
  try {
    res = await fetch(BASE + path, { ...options, headers });
  } catch {
    throw new Error('无法连接后端服务，请确认服务已启动');
  }
  if (!res.ok) {
    // 优先透出后端 detail（业务错误信息），并附带状态码供调用方区分（如 401 未登录）
    let detail = `请求失败（HTTP ${res.status}）`;
    try {
      const data = await res.json();
      if (data?.detail) detail = typeof data.detail === 'string' ? data.detail : detail;
    } catch { /* 非 JSON 响应则用默认文案 */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 获取任务列表 @returns {Promise<{tasks: Array}>} */
export const fetchTasks = () => request('/api/tasks');

/** 获取样本列表 @returns {Promise<{samples: Array}>} */
export const fetchSamples = () => request('/api/samples');

/** 获取模型列表 @returns {Promise<{models: Array}>} */
export const fetchModels = () => request('/api/models');

/**
 * 运行推理
 * @param {{task_id: string, sample_id: string, model: string, view_as?: string|null}} payload
 * @returns {Promise<object>} 推理结果（overlays / metrics / extra / is_edited 等）
 */
export function runInference(payload) {
  return request('/api/infer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * 获取指定扫描行的边界曲线（layers 任务）
 * @param {string} sampleId 样本编号
 * @param {number} y 扫描行（0-399）
 * @returns {Promise<{y: number, curves: Array<{key: string, name: string, color: string, points: number[]}>}>}
 */
export const fetchBoundaryCurves = (sampleId, y) =>
  request(`/api/samples/${sampleId}/layers?y=${y}`);

/**
 * 获取体数据第 n 层切片（faz3d 任务）
 * @param {string} sampleId 样本编号
 * @param {number} n 切片序号（1-400）
 * @param {string} [asUser] 查看谁的标注版本：'' = 强制原始 GT，用户名 = 其版本；
 *                          undefined = 不指定（后端回退为当前登录用户的版本）
 * @returns {Promise<{n: number, input: string, label: string|null, edited_by: string|null}>}
 */
export const fetchVolumeSlice = (sampleId, n, asUser) =>
  request(
    `/api/samples/${sampleId}/volume/${n}${
      asUser === undefined ? '' : `?as_user=${encodeURIComponent(asUser)}`
    }`,
  );

// ---------------------------------------------------------------- 认证
/** 注册并自动登录 @returns {Promise<{token: string, user: object}>} */
export function register(username, password) {
  return request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

/** 登录 @returns {Promise<{token: string, user: object}>} */
export function login(username, password) {
  return request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

/** 当前登录用户 @returns {Promise<{user: object}>} */
export const fetchMe = () => request('/api/auth/me');

// ---------------------------------------------------------------- 标注
/**
 * 某样本+任务的全部标注版本（公开）
 * @returns {Promise<{sample_id: string, task_id: string, annotators: Array<{username: string, updated_at: string, n_saves: number}>}>}
 */
export const fetchAnnotators = (sampleId, taskId) =>
  request(`/api/annotations/${sampleId}/${taskId}`);

/** 我的标注 meta @returns {Promise<{has: boolean, meta: object|null}>} */
export const fetchMyAnnotation = (sampleId, taskId) =>
  request(`/api/annotations/${sampleId}/${taskId}/mine`);

/**
 * 保存我的标注版本（首次保存自动从 GT fork）
 * @param {string} sampleId
 * @param {string} taskId vessel / faz 用 masks；faz3d 用 slices
 * @param {{masks?: Object<string, string|null>, slices?: Object<string, string>}} payload
 *        掩膜/切片值为 base64 PNG；masks 中 null 表示删除该类掩膜
 */
export function saveAnnotation(sampleId, taskId, payload) {
  return request(`/api/annotations/${sampleId}/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 删除我的标注版本（恢复原始 GT） */
export const deleteAnnotation = (sampleId, taskId) =>
  request(`/api/annotations/${sampleId}/${taskId}`, { method: 'DELETE' });
