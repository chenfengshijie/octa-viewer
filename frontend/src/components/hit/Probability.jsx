import ThresholdSweep from './ThresholdSweep.jsx';
import { ProbabilityDistribution } from './Measurements.jsx';
import { useState } from 'react';
import ImageViewer from '../ImageViewer.jsx';
import Slider from '../Slider.jsx';
import { probabilityPath } from './api.js';

export default function Probability({ run, projection, user, onSeed }) {
  const [threshold, setThreshold] = useState(run.parameters.threshold);
  const [opacity, setOpacity] = useState(65);
  const [mode, setMode] = useState('heatmap');
  const preview = probabilityPath(run.job_id, 'mask', threshold);
  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-semibold">概率与阈值</h2>
      <div className="flex flex-wrap gap-3">
        <label>
          显示图层
          <select
            value={mode}
            className="select-input ml-2"
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="heatmap">概率热图</option>
            <option value="mask">阈值掩膜</option>
          </select>
        </label>
        {user && (
          <button className="btn-primary" onClick={() => onSeed(threshold)}>
            以此阈值开始个人修订
          </button>
        )}
      </div>
      <div className="h-[52vh] min-h-72">
        <ImageViewer
          baseSrc={run.outputs[projection]}
          persistKey={'prob-' + run.job_id}
          overlays={
            mode === 'mask'
              ? [
                  {
                    key: 'mask',
                    src: preview,
                    color: '#22d3ee',
                    visible: true,
                    opacity: opacity / 100,
                  },
                ]
              : []
          }
          stageExtra={
            mode === 'heatmap' && (
              <img
                alt="大血管概率热图"
                className="pointer-events-none absolute inset-0 h-full w-full"
                style={{ opacity: opacity / 100 }}
                src={probabilityPath(run.job_id, 'heatmap')}
              />
            )
          }
          hint={
            mode === 'mask' ? '高于当前阈值的像素显示为青色' : '概率从低到高对应深蓝、青绿、黄、红'
          }
        />
      </div>
      <Slider
        label="概率阈值"
        value={Math.round(threshold * 1000)}
        min={0}
        max={1000}
        onChange={(value) => {
          setThreshold(value / 1000);
          setMode('mask');
        }}
        format={(v) => (v / 1000).toFixed(3)}
      />
      <Slider
        label="图层不透明度"
        value={opacity}
        min={0}
        max={100}
        onChange={setOpacity}
        format={(v) => v + '%'}
      />
      <ProbabilityDistribution
        job={run.job_id}
        value={threshold}
        setThreshold={(value) => {
          setThreshold(value);
          setMode('mask');
        }}
      />
      <ThresholdSweep
        job={run.job_id}
        value={threshold}
        onSelect={(value) => {
          setThreshold(value);
          setMode('mask');
        }}
      />
    </section>
  );
}
