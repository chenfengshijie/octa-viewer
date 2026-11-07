import { useEffect, useState } from 'react';

/** 焦点是否在输入类元素上（此时不接管空格键） */
function isTypingTarget(el) {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/**
 * 按住空格检测：active 期间监听 Space，按住返回 true（用于画笔模式下临时切换为平移）。
 * active=false 或窗口失焦时自动复位；preventDefault 防止页面滚动 / 聚焦按钮被空格触发。
 *
 * @param {boolean} active 是否处于需要监听的编辑态
 * @returns {boolean}
 */
export default function useSpaceHold(active) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!active) {
      setHeld(false);
      return undefined;
    }
    const handleDown = event => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      setHeld(true);
    };
    const handleUp = event => {
      if (event.code === 'Space') setHeld(false);
    };
    const clear = () => setHeld(false);
    window.addEventListener('keydown', handleDown);
    window.addEventListener('keyup', handleUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', handleDown);
      window.removeEventListener('keyup', handleUp);
      window.removeEventListener('blur', clear);
      setHeld(false);
    };
  }, [active]);

  return held;
}
