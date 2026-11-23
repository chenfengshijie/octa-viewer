import { useState } from 'react';
import { runPath, withQuery } from './api.js';
import useResource from './useResource.js';

const views = [
  ['reference', '参照掩膜'],
  ['target', '目标掩膜'],
  ['difference', '局部差异'],
];

export default function WindowInspector({ job, reference, target, projection, start }) {
  const [position, setPosition] = useState({ x: start?.x ?? 224, y: start?.y ?? 224 });
  const [size, setSize] = useState(65);
  const [open, setOpen] = useState(Boolean(start));
  const options = { reference, target, projection, x: position.x, y: position.y, size };
  const url = runPath(job) + '/window';
  const { data, error } = useResource(open ? withQuery(url, options) : null);
  function locate(event) {
    if (!data) return;
    const [left, top, right, bottom] = data.window.bounds;
    const rect = event.currentTarget.getBoundingClientRect();
    const cell = (value, extent) => Math.max(0, Math.min(extent - 1, Math.floor(value * extent)));
    setPosition({
      x: left + cell((event.clientX - rect.left) / rect.width, right - left),
      y: top + cell((event.clientY - rect.top) / rect.height, bottom - top),
    });
  }
  return (
    <details
      className="rounded border p-3 text-sm"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer font-semibold">局部对照与像素读数</summary>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {['x', 'y'].map((axis) => (
              <label key={axis}>
                {axis.toUpperCase()}
                <input
                  type="number"
                  min={0}
                  max={447}
                  value={position[axis]}
                  className="ml-1 w-20 rounded border p-1"
                  onChange={(e) => {
                    const n = e.target.valueAsNumber;
                    if (Number.isInteger(n) && n >= 0 && n < 448)
                      setPosition({ ...position, [axis]: n });
                  }}
                />
              </label>
            ))}
            <label>
              同步视野
              <select
                className="select-input ml-1"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
              >
                {[17, 33, 65, 129, 257, 448].map((n) => (
                  <option key={n} value={n}>
                    {n} × {n} px
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {views.map(([view, label]) => (
              <figure key={view}>
                <div className="relative aspect-square cursor-crosshair" onClick={locate}>
                  <img
                    style={{ imageRendering: 'pixelated' }}
                    className="h-full w-full"
                    src={withQuery(url, { ...options, view })}
                    alt={label}
                  />
                  {data && (
                    <span
                      className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white"
                      style={{
                        left: ((position.x - data.window.bounds[0] + 0.5) / size) * 100 + '%',
                        top: ((position.y - data.window.bounds[1] + 0.5) / size) * 100 + '%',
                      }}
                    />
                  )}
                </div>
                <figcaption>{label}</figcaption>
              </figure>
            ))}
          </div>
          {error && <p role="alert">{error}</p>}
          {data && (
            <>
              <dl className="grid gap-2 sm:grid-cols-3">
                {[
                  ['归档概率', data.pixel.probability.toFixed(5)],
                  ['参照像素', data.pixel.reference ? '血管' : '背景'],
                  ['目标像素', data.pixel.target ? '血管' : '背景'],
                  ['ILM 深度', data.pixel.depths.ilm],
                  ['OPL 代理深度', data.pixel.depths.opl],
                  ['BM 深度', data.pixel.depths.bm],
                  ['全层灰度', data.pixel.intensities.full_projection],
                  ['浅层灰度', data.pixel.intensities.shallow_projection],
                  ['深层灰度', data.pixel.intensities.deep_projection],
                ].map(([name, value]) => (
                  <div key={name} className="rounded bg-slate-50 p-2">
                    <dt>{name}</dt>
                    <dd className="font-mono">{value}</dd>
                  </div>
                ))}
              </dl>
              <p>
                视野内 Dice {data.window.metrics.dice.toFixed(4)}，IoU{' '}
                {data.window.metrics.iou.toFixed(4)}， 新增 {data.window.metrics.added} px，擦除{' '}
                {data.window.metrics.erased} px。
              </p>
            </>
          )}
        </div>
      )}
    </details>
  );
}
