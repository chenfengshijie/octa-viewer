import { Thickness } from './Measurements.jsx';
import { useState } from 'react';
import Slider from '../Slider.jsx';
import { runPath, withQuery } from './api.js';
import useResource from './useResource.js';

const surfaces = [
  { key: 'ilm', label: 'ILM', color: '#67e8f9' },
  { key: 'opl', label: 'OPL 代理曲面', color: '#fbbf24' },
  { key: 'bm', label: 'BM', color: '#f472b6' },
];

function position(event, width, axis) {
  const rect = event.currentTarget.getBoundingClientRect();
  const fraction =
    axis === 'x'
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;
  return Math.max(0, Math.min(width - 1, Math.floor(fraction * width)));
}

function Profile({ data, column, onColumn }) {
  const [hidden, setHidden] = useState({});
  const [showOct, setShowOct] = useState(true);
  const [fit, setFit] = useState(true);
  const values = Object.values(data.profiles).flat();
  const top = fit ? Math.max(0, Math.min(...values) - 20) : 0;
  const bottom = fit ? Math.min(data.depth - 1, Math.max(...values) + 20) : data.depth - 1;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {surfaces.map((s) => (
          <label key={s.key}>
            <input
              type="checkbox"
              checked={!hidden[s.key]}
              onChange={(e) => setHidden({ ...hidden, [s.key]: !e.target.checked })}
            />{' '}
            {s.label}
          </label>
        ))}
        <label>
          <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />{' '}
          适配边界范围
        </label>
        {data.slice_url && (
          <label>
            <input
              type="checkbox"
              checked={showOct}
              onChange={(e) => setShowOct(e.target.checked)}
            />{' '}
            叠加结构 OCT
          </label>
        )}
      </div>
      <svg
        viewBox={`-0.5 ${top - 0.5} ${data.width} ${bottom - top + 1}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={'扫描行 ' + data.y + ' 的三条深度曲线'}
        className="h-72 w-full cursor-crosshair rounded bg-slate-950"
        onClick={(e) => onColumn(position(e, data.width, 'x'))}
      >
        {showOct && data.slice_url && (
          <image
            x={-0.5}
            y={-0.5}
            width={data.width}
            height={data.depth}
            preserveAspectRatio="none"
            href={data.slice_url}
          />
        )}
        {surfaces
          .filter((s) => !hidden[s.key])
          .map((s) => (
            <polyline
              key={s.key}
              points={data.profiles[s.key].map((depth, x) => x + ',' + depth).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        <line
          x1={column}
          x2={column}
          y1={top}
          y2={bottom}
          stroke="white"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <p className="text-xs text-slate-600">
        从左到右 X = 0–447，从上到下 Z = {top}–{bottom}（像素）
      </p>
      <Slider label="读取横向位置 X" min={0} max={447} value={column} onChange={onColumn} />
      <dl className="grid grid-cols-3 gap-2">
        {surfaces.map((s) => (
          <div key={s.key} className="rounded bg-slate-50 p-2">
            <dt>{s.label}</dt>
            <dd className="font-mono">{data.profiles[s.key][column]} px</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function coordinate(raw) {
  if (raw == null || !/^\d+$/.test(raw)) return 224;
  const n = Number(raw);
  return n >= 0 && n < 448 ? n : 224;
}

export default function QualityControl({ run, projection, params }) {
  const [row, setRow] = useState(() => coordinate(params.get('y')));
  const [column, setColumn] = useState(() => coordinate(params.get('x')));
  const { data, error } = useResource(runPath(run.job_id) + '/rows/' + row);
  return (
    <section className="card space-y-4 p-4 text-sm">
      <h2 className="font-semibold">分层质控</h2>
      <div className="grid gap-6 lg:grid-cols-[minmax(180px,1fr)_2fr]">
        <div className="space-y-3">
          <div
            className="relative aspect-square cursor-crosshair bg-black"
            onClick={(event) => {
              setRow(position(event, 448, 'y'));
              setColumn(position(event, 448, 'x'));
            }}
          >
            <img src={run.outputs[projection]} alt="选取 B-scan 扫描行" className="h-full w-full" />
            <span
              className="absolute left-0 w-full border-t border-cyan-300"
              style={{ top: ((row + 0.5) / 448) * 100 + '%' }}
            />
          </div>
          <Slider label="扫描行 Y" min={0} max={447} value={row} onChange={setRow} />
          <a
            className="text-blue-700"
            href={run.outputs.boundary_qc}
            target="_blank"
            rel="noreferrer"
          >
            打开归档质控图
          </a>
          <a
            className="block text-blue-700"
            download
            href={runPath(run.job_id) + '/rows/' + row + '/profile.csv'}
          >
            下载第 {row} 行曲面读数
          </a>
          {params.get('round') && (
            <a
              className="block text-blue-700"
              href={withQuery('/hit', {
                run: run.job_id,
                version: params.get('version'),
                tab: 'reviews',
                round: params.get('round'),
              })}
            >
              返回对应复核轮次
            </a>
          )}
        </div>
        {error ? (
          <p role="alert">{error}</p>
        ) : data ? (
          <Profile data={data} column={column} onColumn={setColumn} />
        ) : (
          <p>正在读取扫描行…</p>
        )}
      </div>
      <Thickness
        run={run}
        row={row}
        column={column}
        locate={(y, x) => {
          setRow(y);
          setColumn(x);
        }}
      />
    </section>
  );
}
