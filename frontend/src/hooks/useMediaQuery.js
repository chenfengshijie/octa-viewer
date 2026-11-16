import { useEffect, useState } from 'react';

/**
 * CSS media query 的 React 绑定（SSR 安全：首帧返回 false，挂载后同步一次真实值）。
 *
 * @param {string} query 如 '(pointer: coarse)'、'(min-width: 1024px)'
 * @returns {boolean}
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** 主输入方式为触摸（手机 / 平板）时为 true；桌面鼠标 / 触控板为 false */
export function useCoarsePointer() {
  return useMediaQuery('(pointer: coarse)');
}
