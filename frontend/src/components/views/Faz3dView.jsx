import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { fetchVolumeSlice } from '../../api.js';
import ClassChips from '../ClassChips.jsx';
import ImageViewer from '../ImageViewer.jsx';
import InferenceCard from '../InferenceCard.jsx';
import MetricCard from '../MetricCard.jsx';
import SampleInfoCard from '../SampleInfoCard.jsx';
import Slider from '../Slider.jsx';

const PLAY_INTERVAL_MS = 150;
const DEFAULT_OPACITY = 0.6;

/**
 * FAZ 三维浏览视图：体数据逐层切片（vol jpg + lab 标注叠加），
 * 切片滑杆 + 播放/暂停（150ms 自动推进循环）+ enface 小地图标注当前切片位置。
 *
 * @param {{
 *   sampleId: string,
 *   sample: object|null,
 *   result: object|null,  // 推理结果（extra.volume 提供 n_slices；metrics 提供 FAZ 体积）
 *   running: boolean,
 *   runId: number,
 *   runError: string|null,
 *   onRun: () => void,
 * }} props
 */
export default function Faz3dView({ sampleId, sample, result, running, runId, runError, onRun }) {
  const nSlices = result?.extra?.volume?.n_slices ?? 400;
  const [n, setN] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [slice, setSlice] = useState(null); // {n, input, label}
  const [loadFailed, setLoadFailed] = useState(false);
  const [showLabel, setShowLabel] = useState(true);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const cacheRef = useRef(new Map()); // n → 切片数据缓存

  // 每次推理后复位标注显示
  useEffect(() => {
    setShowLabel(true);
    setOpacity(DEFAULT_OPACITY);
  }, [runId]);

  // 切换样本时清空缓存并回到第一层
  useEffect(() => {
    cacheRef.current.clear();
    setN(1);
    setPlaying(false);
    setSlice(null);
    setLoadFailed(false);
  }, [sampleId]);

  // 播放循环：150ms 自动推进，到末层循环
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => setN(prev => (prev >= nSlices ? 1 : prev + 1)), PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, nSlices]);

  // 拉取当前切片（带缓存，仅采纳最新请求）
  useEffect(() => {
    if (!sampleId) return undefined;
    const cache = cacheRef.current;
    const cached = cache.get(n);
    if (cached) {
      setSlice(cached);
      setLoadFailed(false);
      return undefined;
    }
    let alive = true;
    fetchVolumeSlice(sampleId, n)
      .then(data => {
        cache.set(n, data);
        if (alive) {
          setSlice(data);
          setLoadFailed(false);
        }
      })
      .catch(() => {
        if (alive) setLoadFailed(true); // 失败时保留上一帧画面
      });
    return () => {
      alive = false;
    };
  }, [sampleId, n]);

  // 预取下一层，保证播放流畅
  useEffect(() => {
    if (!sampleId) return;
    const next = n >= nSlices ? 1 : n + 1;
    const cache = cacheRef.current;
    if (!cache.has(next)) {
      fetchVolumeSlice(sampleId, next)
        .then(data => cache.set(next, data))
        .catch(() => {});
    }
  }, [sampleId, n, nSlices]);

  // FAZ 标注叠加：仅推理后显示（青色着色，与「FAZ 标注」chip 一致）
  const labelOverlays =
    slice?.label && result
      ? [{ key: 'label', src: slice.label, color: '#22d3ee', visible: showLabel, opacity }]
      : [];

  const metrics = result?.metrics ?? [];

  // enface 小地图：proj 右下角 120px 缩略图 + 横线标当前切片位置
  const minimap = sampleId && (
    <div
      className="absolute bottom-3 right-3 z-10 w-[120px] rounded-lg border border-white/15 bg-black/60 p-1.5 backdrop-blur-sm"
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="relative overflow-hidden rounded-md">
        <img
          src={`/data/samples/${sampleId}/proj_octa.png`}
          alt="en-face 投影小地图"
          draggable={false}
          className="block w-full"
        />
        <div
          className="absolute left-0 right-0 h-0.5 -translate-y-1/2 bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)] transition-[top] duration-100 ease-linear"
          style={{ top: `${(n / nSlices) * 100}%` }}
        />
      </div>
      <p className="mt-1 text-center text-[10px] tabular-nums text-slate-300">
        {n} / {nSlices}
      </p>
    </div>
  );

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* 左：切片查看器（黑底） */}
      <div className="h-[62vh] min-h-[420px]">
        <ImageViewer
          baseSrc={slice?.input ?? null}
          overlays={labelOverlays}
          loading={running}
          hudExtra={minimap}
          hint={!result ? '尚未运行推理 — FAZ 标注与体积指标将在推理后显示' : undefined}
          emptyText={!sampleId ? '暂无样本' : loadFailed && !slice ? '切片加载失败或后端未就绪' : '切片加载中…'}
        />
      </div>

      {/* 右：控制 / 指标侧栏 */}
      <aside className="space-y-4">
        <SampleInfoCard sample={sample} />
        <InferenceCard onRun={onRun} running={running} disabled={!sampleId} error={runError} result={result} />

        <div className="card space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">切片浏览</h3>
            <button
              type="button"
              onClick={() => setPlaying(prev => !prev)}
              disabled={!sampleId}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 shadow-sm transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {playing ? '暂停' : '播放'}
            </button>
          </div>
          <Slider
            label="切片序号"
            min={1}
            max={nSlices}
            value={Math.min(n, nSlices)}
            onChange={value => {
              setPlaying(false);
              setN(value);
            }}
            format={value => `${value} / ${nSlices}`}
          />
          <ClassChips
            classes={[{ key: 'label', name: 'FAZ 标注', color: '#22d3ee' }]}
            active={{ label: showLabel }}
            onToggle={() => setShowLabel(prev => !prev)}
          />
          <Slider
            label="标注不透明度"
            min={0}
            max={100}
            value={Math.round(opacity * 100)}
            onChange={value => setOpacity(value / 100)}
            disabled={!result}
            format={value => `${value}%`}
          />
        </div>

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
