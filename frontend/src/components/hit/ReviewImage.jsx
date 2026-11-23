import { withQuery } from './api.js';
import { useState } from 'react';
import ImageViewer from '../ImageViewer.jsx';
import Slider from '../Slider.jsx';

const planes = {
  full_projection: '全层投影',
  deep_projection: '深层投影',
  shallow_projection: '浅层投影',
  model_input: '模型输入',
};

function markerStyle(x, y) {
  return { left: ((x + 0.5) / 448) * 100 + '%', top: ((y + 0.5) / 448) * 100 + '%' };
}

function NoteLayer({ comments, point, onPoint, picking, showMarkers }) {
  function select(event) {
    if (!picking) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pixel = (ratio) => Math.max(0, Math.min(447, Math.floor(ratio * 448)));
    onPoint({
      x: pixel((event.clientX - rect.left) / rect.width),
      y: pixel((event.clientY - rect.top) / rect.height),
    });
  }
  return (
    <div
      className={'absolute inset-0 ' + (picking ? 'cursor-crosshair' : 'pointer-events-none')}
      onClick={select}
    >
      {showMarkers &&
        comments.map(
          (note, index) =>
            note.x !== null && (
              <button
                key={note.id}
                title={note.body}
                aria-label={'定位第 ' + (index + 1) + ' 条意见'}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-slate-900 px-1 text-[10px] text-white"
                style={markerStyle(note.x, note.y)}
                onClick={(e) => {
                  e.stopPropagation();
                  onPoint(note);
                }}
              >
                {index + 1}
              </button>
            ),
        )}
      {point && (
        <span
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan-300"
          style={markerStyle(point.x, point.y)}
          aria-label={'位置 ' + point.x + ', ' + point.y}
        />
      )}
    </div>
  );
}

export default function ReviewImage({
  run,
  version,
  point,
  onPoint,
  interactive,
  comments,
  round,
}) {
  const [projection, setProjection] = useState('full_projection');
  const [pick, setPick] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [opacity, setOpacity] = useState(60);
  const matching = comments.filter((note) => point && note.x === point.x && note.y === point.y);
  function setAxis(axis, n) {
    if (!Number.isInteger(n) || n < 0 || n > 447) return;
    onPoint({ x: point?.x ?? 224, y: point?.y ?? 224, [axis]: n });
  }
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label>
          意见底图
          <select
            className="select-input ml-1"
            value={projection}
            onChange={(e) => setProjection(e.target.value)}
          >
            {Object.entries(planes).map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </select>
        </label>
        {interactive && (
          <label>
            <input type="checkbox" checked={pick} onChange={(e) => setPick(e.target.checked)} />{' '}
            点击标记
          </label>
        )}
        <label>
          <input
            type="checkbox"
            checked={showMarkers}
            onChange={(e) => setShowMarkers(e.target.checked)}
          />{' '}
          显示意见位置
        </label>
      </div>
      <div className="h-[48vh] min-h-72">
        <ImageViewer
          baseSrc={run.outputs[projection]}
          persistKey={'review-' + run.job_id}
          paintMode={interactive && pick}
          overlays={[
            {
              key: 'reviewed',
              src: version.mask_url,
              color: '#f59e0b',
              visible: true,
              opacity: opacity / 100,
            },
          ]}
          hint={interactive && pick ? '点击标记位置，滚轮缩放，右键拖动平移' : '滚轮缩放，拖动平移'}
          stageExtra={
            <NoteLayer
              comments={comments}
              point={point}
              onPoint={onPoint}
              picking={interactive && pick}
              showMarkers={showMarkers}
            />
          }
        />
      </div>
      <Slider
        label="送审掩膜不透明度"
        min={0}
        max={100}
        value={opacity}
        onChange={setOpacity}
        format={(n) => n + '%'}
      />
      {interactive && (
        <div className="flex items-center gap-2 text-xs">
          {['x', 'y'].map((axis) => (
            <label key={axis}>
              {axis.toUpperCase()}
              <input
                aria-label={'意见坐标 ' + axis.toUpperCase()}
                type="number"
                min={0}
                max={447}
                className="ml-1 w-20 rounded border p-1"
                value={point?.[axis] ?? ''}
                onChange={(e) => setAxis(axis, e.target.valueAsNumber)}
              />
            </label>
          ))}
        </div>
      )}
      {matching.length > 0 && (
        <div className="rounded bg-cyan-50 p-2 text-sm">
          {matching.map((note) => (
            <p key={note.id} className="whitespace-pre-wrap">
              {note.author} · {note.body}
            </p>
          ))}
        </div>
      )}
      {point && (
        <a
          className="text-sm text-blue-700"
          target="_blank"
          rel="noreferrer"
          href={withQuery('/hit', {
            run: run.job_id,
            version: version.id,
            round,
            tab: 'qc',
            x: point.x,
            y: point.y,
          })}
        >
          查看此位置的分层质控
        </a>
      )}
    </section>
  );
}
