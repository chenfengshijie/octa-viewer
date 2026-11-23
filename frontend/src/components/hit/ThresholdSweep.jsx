import { useState } from 'react';
import { runPath, withQuery } from './api.js';
import useResource from './useResource.js';

const measures = {
  fraction: '前景占比',
  dice: '对原始预测的 Dice',
  iou: '对原始预测的 IoU',
};

function plotPoints(points, field) {
  const first = points[0].threshold;
  const span = points.at(-1).threshold - first;
  return points.map((point) => ({
    ...point,
    x: ((point.threshold - first) / span) * 400,
    y: (1 - point[field]) * 120,
  }));
}

function Curve({ points, field, onSelect }) {
  const values = plotPoints(points, field);
  return (
    <svg
      role="img"
      aria-label={measures[field] + '随归档概率阈值的变化'}
      viewBox="-3 -3 406 126"
      preserveAspectRatio="none"
      className="h-36 w-full rounded bg-slate-50"
    >
      {[0, 30, 60, 90, 120].map((y) => (
        <line
          key={y}
          x1={0}
          x2={400}
          y1={y}
          y2={y}
          stroke="#cbd5e1"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polyline
        points={values.map((point) => point.x + ',' + point.y).join(' ')}
        fill="none"
        stroke="#0d9488"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      {values.map((point) => (
        <circle
          key={point.threshold}
          cx={point.x}
          cy={point.y}
          r={2.5}
          fill="#0f766e"
          className="cursor-pointer"
          onClick={() => onSelect(point.threshold)}
        >
          <title>
            阈值 {point.threshold.toFixed(3)} · {measures[field]} {point[field].toFixed(4)}
          </title>
        </circle>
      ))}
    </svg>
  );
}

export default function ThresholdSweep({ job, value, onSelect }) {
  const [open, setOpen] = useState(false);
  const [low, setLow] = useState(0);
  const [high, setHigh] = useState(1);
  const [intervals, setIntervals] = useState(20);
  const [field, setField] = useState('fraction');
  const [expanded, setExpanded] = useState(false);
  const valid =
    Number.isFinite(low) && Number.isFinite(high) && low >= 0 && low < high && high <= 1;
  const path =
    open && valid ? withQuery(runPath(job) + '/thresholds', { low, high, intervals }) : null;
  const { data, error } = useResource(path);
  return (
    <details className="rounded border p-3 text-sm" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold">阈值敏感性</summary>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {[
              [low, setLow, '下限'],
              [high, setHigh, '上限'],
            ].map(([n, change, label]) => (
              <label key={label}>
                {label}
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={Number.isFinite(n) ? n : ''}
                  className="ml-1 w-20 rounded border p-1"
                  onChange={(e) => change(e.target.valueAsNumber)}
                />
              </label>
            ))}
            <label>
              区间数
              <select
                className="select-input ml-1"
                value={intervals}
                onChange={(e) => setIntervals(Number(e.target.value))}
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              纵轴
              <select
                className="select-input ml-1"
                value={field}
                onChange={(e) => setField(e.target.value)}
              >
                {Object.entries(measures).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!valid && <p role="alert">请选择 0 至 1 之间的递增区间。</p>}
          {error && <p role="alert">{error}</p>}
          {data && (
            <>
              <Curve points={data.points} field={field} onSelect={onSelect} />
              <div className="flex justify-between text-xs">
                <span>{low}</span>
                <span>归档概率阈值</span>
                <span>{high}</span>
              </div>
              <p>
                原始预测有 {data.reference_pixels} 个前景像素。选择曲线上的点可查看对应阈值的掩膜。
              </p>
              <button className="text-blue-700" onClick={() => setExpanded(!expanded)}>
                {expanded ? '收起数值表' : '查看各阈值数值'}
              </button>
              {expanded && (
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr>
                        {['阈值', '前景', '新增', '擦除', 'Dice', 'IoU'].map((key) => (
                          <th key={key}>{key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.points.map((point) => (
                        <tr
                          key={point.threshold}
                          className={point.threshold === value ? 'bg-teal-50' : ''}
                        >
                          <td>
                            <button
                              className="p-1 text-blue-700"
                              onClick={() => onSelect(point.threshold)}
                            >
                              {point.threshold.toFixed(3)}
                            </button>
                          </td>
                          <td>{point.selected}</td>
                          <td>{point.added}</td>
                          <td>{point.erased}</td>
                          <td>{point.dice.toFixed(4)}</td>
                          <td>{point.iou.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
