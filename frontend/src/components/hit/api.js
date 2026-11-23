import { request } from '../../api.js';

export const ORIGINAL = 'original';
export const runPath = (job) => '/api/hit/runs/' + encodeURIComponent(job);

export function withQuery(path, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.size ? path + '?' + query : path;
}

export function jsonPost(path, payload, options) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...options,
  });
}

export function comparePath(job, reference, target, image = false) {
  return withQuery(runPath(job) + '/compare', { reference, target, image });
}

export function probabilityPath(job, mode, threshold) {
  return withQuery(runPath(job) + '/probability/' + mode, { threshold });
}

export function versionName(version) {
  if (!version) return '原始预测';
  const stamp = new Date(version.updated_at).toLocaleString('zh-CN', { hour12: false });
  return version.username + ' · ' + stamp + ' · ' + version.id.slice(0, 6);
}
