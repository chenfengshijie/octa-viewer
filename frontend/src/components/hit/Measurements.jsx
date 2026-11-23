import { useState } from 'react';
import { runPath, withQuery } from './api.js';
import useResource from './useResource.js';

export function ProbabilityDistribution({ job, value, setThreshold }) {
  const { data, error } = useResource(
    withQuery(runPath(job) + '/distribution', { threshold: value }),
  );
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>正在计算阈值预览…</p>;
  const maxCount = Math.max(...data.bins.map((bin) => bin.count));
  return (
    <section className="space-y-3 border-t pt-4 text-sm">
      <h3 className="font-semibold">归档概率分布</h3>
      <div className="flex h-24 items-end gap-px border-b">
        {data.bins.map((bin, i) => {
          const label = `${bin.low.toFixed(2)}–${bin.high.toFixed(2)} · ${bin.count} 像素`;
          return (
            <button
              key={i}
              type="button"
              aria-label={label}
              title={label}
              onClick={() => setThreshold(Number(bin.low.toFixed(2)))}
              className={'min-w-0 flex-1 ' + (bin.high <= value ? 'bg-slate-300' : 'bg-teal-600')}
              style={{ height: Math.max(2, (bin.count / maxCount) * 100) + '%' }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-xs">
        <span>0</span>
        <span>大血管概率</span>
        <span>1</span>
      </div>
      <p>
        当前阈值选中 {data.selected.toLocaleString()} / {data.pixels.toLocaleString()} 个像素 （
        {((100 * data.selected) / data.pixels).toFixed(2)}%）。相对原始预测新增{' '}
        {data.comparison.added}、擦除 {data.comparison.erased} 个像素。
      </p>
    </section>
  );
}

export function RegionList({ job, target, reference, selected, onSelect }) {
  const [minArea, setMinArea] = useState(1);
  const [offset, setOffset] = useState(0);
  const limit = 15;
  const { data, error } = useResource(
    withQuery(runPath(job) + '/regions', {
      target,
      reference,
      min_area: minArea,
      limit,
      offset,
    }),
  );
  return (
    <section className="space-y-2 border-t pt-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">定位差异区域</h3>
        <label>
          最小面积
          <select
            className="select-input ml-2"
            value={minArea}
            onChange={(e) => {
              setMinArea(Number(e.target.value));
              setOffset(0);
              onSelect(null);
            }}
          >
            {[1, 5, 20, 100].map((n) => (
              <option key={n} value={n}>
                {n} 像素
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>共 {data.total} 个区域，按八邻域连通并依面积排列。</p>
          {data.total > 0 && (
            <div className="grid gap-2 sm:grid-cols-3">
              {data.regions.map((region) => {
                const active = selected?.x === region.x && selected?.y === region.y;
                return (
                  <button
                    key={region.x + '-' + region.y}
                    aria-pressed={active}
                    className={
                      'rounded border p-2 text-left ' + (active ? 'border-blue-500 bg-blue-50' : '')
                    }
                    onClick={() => onSelect(active ? null : region)}
                  >
                    {region.kind === 'added' ? '新增' : '擦除'} {region.pixels} px · ({region.x},{' '}
                    {region.y})
                  </button>
                );
              })}
            </div>
          )}
          {data.total > limit && (
            <div className="flex gap-4">
              <button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - limit))}>
                上一页
              </button>
              <span>
                {Math.floor(offset / limit) + 1} / {Math.ceil(data.total / limit)}
              </span>
              <button
                disabled={offset + limit >= data.total}
                onClick={() => setOffset(offset + limit)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function RegionMarker({ region }) {
  if (!region) return null;
  const [x0, y0, x1, y1] = region.bounds;
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 448 448"
      aria-label="所选差异区域"
    >
      <rect
        x={x0}
        y={y0}
        width={x1 - x0}
        height={y1 - y0}
        fill="none"
        stroke="white"
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={region.x + 0.5}
        cy={region.y + 0.5}
        r={4}
        fill="none"
        stroke="yellow"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Thickness({ run, row, column, locate }) {
  const [slab, setSlab] = useState('full');
  const path = runPath(run.job_id) + '/thickness/' + slab;
  const { data, error } = useResource(path);
  const jump = (point) => locate(point.y, point.x);
  return (
    <section className="space-y-3 border-t pt-4">
      <label>
        层间距
        <select
          className="select-input ml-2"
          value={slab}
          onChange={(e) => setSlab(e.target.value)}
        >
          <option value="full">ILM 至 BM</option>
          <option value="shallow">ILM 至 OPL 代理曲面</option>
          <option value="deep">OPL 代理曲面至 BM</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {data && (
        <div className="grid gap-4 sm:grid-cols-[192px_1fr]">
          <div
            className="relative aspect-square cursor-crosshair"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const index = (value) => Math.min(447, Math.max(0, Math.floor(448 * value)));
              locate(
                index((e.clientY - rect.top) / rect.height),
                index((e.clientX - rect.left) / rect.width),
              );
            }}
          >
            <img
              src={path + '?image=true'}
              alt="层间距分布，蓝色为薄、红色为厚"
              className="h-full w-full"
            />
            <span
              className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
              style={{
                left: ((column + 0.5) / 448) * 100 + '%',
                top: ((row + 0.5) / 448) * 100 + '%',
              }}
            />
          </div>
          <div className="space-y-2">
            <p>
              色阶范围 {data.minimum}–{data.maximum} px · 全图中位数 {data.median} px
            </p>
            <p>当前扫描行的层间距中位数 {data.row_medians[row]} px</p>
            <div className="flex gap-3">
              <button className="text-blue-700" onClick={() => jump(data.thinnest)}>
                定位最薄点
              </button>
              <button className="text-blue-700" onClick={() => jump(data.thickest)}>
                定位最厚点
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
