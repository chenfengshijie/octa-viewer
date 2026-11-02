import { useEffect, useState } from 'react';
import ClassChips from '../ClassChips.jsx';
import ImageViewer from '../ImageViewer.jsx';
import InferenceCard from '../InferenceCard.jsx';
import MetricCard from '../MetricCard.jsx';
import SampleInfoCard from '../SampleInfoCard.jsx';
import Slider from '../Slider.jsx';

const DEFAULT_OPACITY = 0.7;

/**
 * 分割类任务共用视图（vessel / faz）：输入 en-face 投影图，
 * 推理后叠加掩膜层，支持类别开关 + 全局不透明度，并展示量化指标。
 *
 * @param {{
 *   task: {id: string, name: string, classes?: Array<{key: string, name: string, color: string}>},
 *   sampleId: string,
 *   sample: object|null,
 *   result: object|null,  // POST /api/infer 结果
 *   running: boolean,
 *   runId: number,        // 每次推理自增，用于复位内部状态
 *   runError: string|null,
 *   onRun: () => void,
 * }} props
 */
export default function SegmentationView({ task, sampleId, sample, result, running, runId, runError, onRun }) {
  const [active, setActive] = useState({}); // 类别 key → 是否显示（未命中默认开启）
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);

  // 每次重新推理后复位开关与透明度
  useEffect(() => {
    setActive({});
    setOpacity(DEFAULT_OPACITY);
  }, [runId]);

  const overlayDefs = result?.overlays ?? [];
  // 推理结果携带类别定义时优先使用，否则回退到任务自带定义
  const chips = overlayDefs.length
    ? overlayDefs.map(o => ({ key: o.key, name: o.name, color: o.color }))
    : task.classes ?? [];
  const overlays = overlayDefs.map(o => ({
    key: o.key,
    src: o.mask_url,
    color: o.color,
    visible: active[o.key] !== false,
    opacity,
  }));
  const metrics = result?.metrics ?? [];

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* 左：影像查看器（黑底） */}
      <div className="h-[62vh] min-h-[420px]">
        <ImageViewer
          baseSrc={sampleId ? `/data/samples/${sampleId}/proj_octa.png` : null}
          overlays={overlays}
          loading={running}
          hint={
            result
              ? overlayDefs.length
                ? undefined
                : '推理完成，但未返回叠加层'
              : sampleId
                ? '尚未运行推理 — 结果叠加层将显示在此'
                : undefined
          }
          emptyText={sampleId ? '影像加载失败或后端未就绪' : '暂无样本'}
        />
      </div>

      {/* 右：控制 / 指标侧栏 */}
      <aside className="space-y-4">
        <SampleInfoCard sample={sample} />
        <InferenceCard onRun={onRun} running={running} disabled={!sampleId} error={runError} result={result} />

        {chips.length > 0 && (
          <div className="card space-y-3.5 p-4">
            <h3 className="text-sm font-semibold text-slate-700">叠加图层</h3>
            <ClassChips
              classes={chips}
              active={active}
              onToggle={key => setActive(prev => ({ ...prev, [key]: prev[key] === false }))}
            />
            <Slider
              label="掩膜不透明度"
              min={0}
              max={100}
              value={Math.round(opacity * 100)}
              onChange={value => setOpacity(value / 100)}
              format={value => `${value}%`}
            />
          </div>
        )}

        {metrics.length > 0 && (
          <div>
            <h3 className="mb-2.5 text-sm font-semibold text-slate-700">量化指标</h3>
            <div className="grid grid-cols-2 gap-3">
              {metrics.map(metric => (
                <MetricCard key={metric.key} label={metric.label} value={metric.value} unit={metric.unit} />
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
