import { useEffect, useState } from 'react';
import { request } from '../../api.js';

/** Hide stale data when the user changes case, revision, row or login. */
export default function useResource(path, generation = 0) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    request(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ path, generation, data });
      },
      (err) => {
        if (!controller.signal.aborted) setResult({ path, generation, error: err.message });
      },
    );
    return () => controller.abort();
  }, [path, generation]);
  if (!path) return {};
  if (result?.path === path && result.generation === generation) return result;
  return { loading: true };
}
