import { createContext, useContext } from 'react';

/**
 * ImageViewer 与内部绘制层（PaintLayer）之间的指针状态共享。
 *
 * ImageViewer 在容器的捕获阶段统一跟踪所有指针，把手势状态写进一个可变对象再经
 * context 下发（ref 直读，同步无重渲染——第二次手指落下的同一事件循环内就要生效，
 * state 异步更新来不及阻止 PaintLayer 起新笔画）：
 * - twoFinger: 双指手势进行中或刚结束仍有一指未抬起（此时 PaintLayer 不得起笔）。
 *   ImageViewer 进入手势时会同步调用 cancelPaint() 取消刚起的半笔。
 * - penActive: 任一 Apple Pencil 指针正按下（拒触：touch 既不绘制也不参与手势计数）。
 * - cancelPaint: PaintLayer 起笔时注册的取消回调；退出笔画时置 null。
 *
 * @type {import('react').Context<{twoFinger: boolean, penActive: boolean, cancelPaint: (() => void)|null}|null>}
 */
export const ViewerInteractionContext = createContext(null);

/** @returns {{twoFinger: boolean, penActive: boolean, cancelPaint: (() => void)|null}|null} */
export function useViewerInteraction() {
  return useContext(ViewerInteractionContext);
}
