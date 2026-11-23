import WindowInspector from './WindowInspector.jsx';
import { RegionList, RegionMarker } from './Measurements.jsx';
import { useState } from 'react';
import ImageViewer from '../ImageViewer.jsx';
import Slider from '../Slider.jsx';
import { comparePath, ORIGINAL, versionName } from './api.js';
import useResource from './useResource.js';

export function VersionSelect({ label, value, onChange, history, disabled = false }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <select
        className="select-input w-full"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={ORIGINAL}>原始预测</option>
        {history.map((item) => (
          <option key={item.id} value={item.id}>
            {versionName(item)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Scores({ metrics }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[
        ['Dice', metrics.dice.toFixed(4)],
        ['IoU', metrics.iou.toFixed(4)],
        ['新增像素', metrics.added.toLocaleString()],
        ['擦除像素', metrics.erased.toLocaleString()],
      ].map(([name, value]) => (
        <div className="rounded-md bg-slate-50 px-3 py-2" key={name}>
          <dt className="text-xs text-slate-600">{name}</dt>
          <dd className="font-mono text-lg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function Comparison({ run, version, projection, initialReference }) {
  const [region, setRegion] = useState(null);
  const [reference, setReference] = useState(initialReference || ORIGINAL);
  const [mode, setMode] = useState('difference');
  const [divider, setDivider] = useState(50);
  const target = version?.id ?? ORIGINAL;
  const findMask = (id) => run.history.find((item) => item.id === id)?.mask_url ?? run.outputs.mask;
  const path = comparePath(run.job_id, reference, target);
  const { data, error } = useResource(path);
  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-semibold">修订对比</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <VersionSelect
          label="参照掩膜"
          history={run.history}
          value={reference}
          onChange={(id) => {
            setReference(id);
            setRegion(null);
          }}
        />
        <label className="block space-y-1 text-sm">
          <span>显示方式</span>
          <select
            className="select-input w-full"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="difference">差异叠加</option>
            <option value="wipe">滑动对照</option>
          </select>
        </label>
      </div>
      <p className="text-sm">比较对象 · {versionName(version)}</p>
      <div className="h-[52vh] min-h-72">
        <ImageViewer
          baseSrc={run.outputs[projection]}
          persistKey={'compare-' + run.job_id}
          hint={
            mode === 'difference'
              ? '青色为新增，粉色为擦除，灰色为重合'
              : '左侧为参照，右侧为比较对象'
          }
          stageExtra={
            <>
              {mode === 'difference' ? (
                <img
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  alt="掩膜差异"
                  src={comparePath(run.job_id, reference, target, true)}
                />
              ) : (
                <div className="pointer-events-none absolute inset-0">
                  {[reference, target].map((id, i) => (
                    <img
                      key={i}
                      src={findMask(id)}
                      alt={i ? '比较对象' : '参照'}
                      className="absolute inset-0 h-full w-full opacity-75 mix-blend-screen"
                      style={{
                        clipPath: i
                          ? 'inset(0 0 0 ' + divider + '%)'
                          : 'inset(0 ' + (100 - divider) + '% 0 0)',
                      }}
                    />
                  ))}
                  <div
                    className="absolute inset-y-0 w-px bg-white"
                    style={{ left: divider + '%' }}
                  />
                </div>
              )}
              <RegionMarker region={region} />
            </>
          }
        />
      </div>
      {mode === 'wipe' && (
        <Slider label="对照分界" value={divider} min={0} max={100} onChange={setDivider} />
      )}
      {error && <p role="alert">{error}</p>}
      {data && <Scores metrics={data} />}
      <RegionList
        key={reference + target}
        job={run.job_id}
        target={target}
        reference={reference}
        selected={region}
        onSelect={setRegion}
      />
      <WindowInspector
        key={[reference, target, region?.x, region?.y].join(':')}
        job={run.job_id}
        reference={reference}
        target={target}
        projection={projection}
        start={region}
      />
    </section>
  );
}
