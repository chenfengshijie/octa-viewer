/**
 * 统一 fetch 封装。API base = ''，
 * 开发期由 Vite 代理（/api、/data → http://localhost:8000），生产环境同源部署。
 */
const BASE = '';

/** @param {string} path 相对 API 路径 */
async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, options);
  } catch {
    throw new Error('无法连接后端服务，请确认服务已启动');
  }
  if (!res.ok) {
    throw new Error(`请求失败（HTTP ${res.status}）`);
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
 * @param {{task_id: string, sample_id: string, model: string}} payload
 * @returns {Promise<object>} 推理结果（overlays / metrics / extra 等）
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
 * @returns {Promise<{n: number, input: string, label: string}>}
 */
export const fetchVolumeSlice = (sampleId, n) =>
  request(`/api/samples/${sampleId}/volume/${n}`);
