import SegmentationView from './SegmentationView.jsx';

/**
 * FAZ 分割任务视图：en-face 投影图 + FAZ 掩膜叠加 + 面积 / 等效直径指标。
 * 与血管分割共用 SegmentationView 骨架，props 说明见该组件。
 */
export default function FazView(props) {
  return <SegmentationView {...props} />;
}
