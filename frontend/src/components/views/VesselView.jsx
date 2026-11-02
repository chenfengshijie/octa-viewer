import SegmentationView from './SegmentationView.jsx';

/**
 * 血管分割任务视图：en-face 投影图 + 血管掩膜叠加 + 血管密度指标。
 * 与 FAZ 分割共用 SegmentationView 骨架，props 说明见该组件。
 */
export default function VesselView(props) {
  return <SegmentationView {...props} />;
}
