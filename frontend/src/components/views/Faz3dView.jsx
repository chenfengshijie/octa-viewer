import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { fetchVolumeSlice, saveAnnotation } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import AnnotationCard from '../annotation/AnnotationCard.jsx';
import PaintLayer from '../annotation/PaintLayer.jsx';
import { loadMaskFromUrl, useMaskEditor } from '../annotation/useMaskEditor.js';
import useSpaceHold from '../annotation/useSpaceHold.js';
import ClassChips from '../ClassChips.jsx';
import ImageViewer from '../ImageViewer.jsx';
import InferenceCard from '../InferenceCard.jsx';
import MetricCard from '../MetricCard.jsx';
import SampleInfoCard from '../SampleInfoCard.jsx';
import Slider from '../Slider.jsx';

const PLAY_INTERVAL_MS = 150;
const DEFAULT_OPACITY = 0.6;
const DEFAULT_BRUSH = 16;
const LABEL_COLOR = '#22d3ee'; // 与 GT 标注 chip 一致的青色

/**
 * FAZ 三维浏览视图：体数据逐层切片（vol jpg + lab 标注叠加），
 * 切片滑杆 + 播放/暂停 + enface 小地图。登录用户可在当前切片上画笔编辑 FAZ 标注，
 * 保存为自己版本的一个切片（首次保存自动从 GT fork 全部 400 张）。
 *
 * @param {{
 *   sampleId: string,
 *   sample: object|null,
 *   result: object|null,
 *   running: boolean,
 *   runId: number,
 *   runError: string|null,
 *   onRun: () => void,
 *   user: object|null,
 *   viewing: string,            // '' = 模型输出，否则用户名
 *   annotators: Array,
 *   myVersion: boolean,
 *   onViewChange: (name: string) => void,
 *   onSaved: () => void,
 *   onDeleteVersion: () => void,
 * }} props
 */
export default function Faz3dView({
  task,
  sampleId,
  sample,
  result,
  running,
  runId,
  runError,
  onRun,
  user,
  viewing,
  annotators,
  myVersion,
  onViewChange,
  onSaved,
  onDeleteVersion,
}) {
  const nSlices = result?.extra?.volume?.n_slices ?? 400;
  const [n, setN] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [slice, setSlice] = useState(null); // {n, input, label}
  const [loadFailed, setLoadFailed] = useState(false);
  const [showLabel, setShowLabel] = useState(true);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [dims, setDims] = useState(null); // B-scan 原始像素尺寸（400×640）
  const cacheRef = useRef(new Map()); // n → 切片数据缓存
  const imgDims = dims ?? { w: 400, h: 640 };

  // ---- 标注编辑状态（editor 以切片号为 key）----
  const editor = useMaskEditor();
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const touchedRef = useRef(new Set()); // 本次编辑会话中动过的切片号
  const spaceHeld = useSpaceHold(editing && tool !== 'pan'); // 按住空格临时切换为平移

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
    fetchVolumeSlice(sampleId, n, viewing ?? '')
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
  }, [sampleId, n, viewing, runId]);

  // 预取下一层，保证播放流畅
  useEffect(() => {
    if (!sampleId) return;
    const next = n >= nSlices ? 1 : n + 1;
    const cache = cacheRef.current;
    if (!cache.has(next)) {
      fetchVolumeSlice(sampleId, next, viewing ?? '')
        .then(data => cache.set(next, data))
        .catch(() => {});
    }
  }, [sampleId, n, nSlices, viewing, runId]);

  // 编辑态：当前切片的工作掩膜不存在时，从展示版本的标注切片初始化
  const sliceKey = String(n);

  /** 加载某切片的工作掩膜（已存在则跳过）；退出重进/放弃修改后也走这里重新加载 */
  const ensureSliceMask = useCallback(
    k => {
      const key = String(k);
      if (editor.getMask(key)) return;
      const fallbackUrl = sampleId ? `/data/samples/${sampleId}/lab/${String(k).padStart(3, '0')}.png` : null;
      const url = cacheRef.current.get(k)?.label ?? fallbackUrl;
      loadMaskFromUrl(url, imgDims.w, imgDims.h).then(data => {
        // 加载期间可能已切换切片/退出编辑：仅在该切片仍缺掩膜时写入
        if (!editor.getMask(key)) {
          editor.setMask(key, data);
          editor.markClean(); // 初始加载不算修改
        }
      });
    },
    [editor, sampleId, imgDims.w, imgDims.h],
  );

  useEffect(() => {
    if (editing) ensureSliceMask(n);
  }, [editing, n, slice, ensureSliceMask]);

  const currentMask = editor.getMask(sliceKey);
  const sliceReady = editing && Boolean(currentMask);

  /** 进入 / 退出编辑 */
  const startEditing = () => {
    setSaveError(null);
    touchedRef.current.clear();
    editor.reset(imgDims.w, imgDims.h);
    setEditing(true); // 掩膜由上方 effect 按需加载
  };

  const stopEditing = () => {
    if (editor.dirty && !window.confirm('有未保存的修改，确定放弃并退出编辑？')) return;
    setEditing(false);
    editor.reset(0, 0);
    touchedRef.current.clear();
  };

  /** 保存：仅提交本次动过的切片（清空的切片传 null = 回退该切片为 GT） */
  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const slices = {};
      for (const k of touchedRef.current) slices[k] = editor.exportMask(String(k));
      if (Object.keys(slices).length === 0) {
        setSaveError('尚未编辑任何切片');
        return;
      }
      await saveAnnotation(sampleId, 'faz3d', { slices });
      editor.markClean();
      touchedRef.current.clear();
      onSaved?.();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // FAZ 标注叠加：非编辑态且推理后显示（青色着色）
  const labelOverlays =
    !editing && slice?.label && result
      ? [{ key: 'label', src: slice.label, color: LABEL_COLOR, visible: showLabel, opacity }]
      : [];

  const paintEntries = currentMask
    ? [{ key: sliceKey, data: currentMask, color: LABEL_COLOR }]
    : [];

  const metrics = result?.metrics ?? [];

  const disabledReason = !user
    ? '请先在左下角登录或注册，即可编辑标注'
    : viewing && viewing !== user.username
      ? `正在查看 ${viewing} 的版本（只读），切换版本后可编辑`
      : !result
        ? '请先运行推理，加载标注后再编辑'
        : null;

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
          paintMode={editing && tool !== 'pan' && !spaceHeld}
          persistKey={task ? `${task.id}-${sampleId}` : undefined}
          stageExtra={
            editing && (
              <PaintLayer
                dims={imgDims}
                entries={paintEntries}
                version={editor.version}
                opacity={opacity}
                editing={sliceReady && !spaceHeld}
                tool={tool}
                brushSize={brushSize}
                activeKey={sliceKey}
                editor={editor}
                onFirstChange={() => touchedRef.current.add(n)}
                cursorColor={LABEL_COLOR}
                onUndo={() => editor.undo()}
                onRedo={() => editor.redo()}
                onBrushSizeChange={setBrushSize}
              />
            )
          }
          hudExtra={minimap}
          hint={
            editing
              ? sliceReady
                ? `编辑第 ${n} 张切片（滚轮缩放 · 空格/右键拖动平移 · [ ] 调笔刷；切到其他切片会保留此切片的修改）`
                : '正在加载当前切片标注…'
              : !result
                ? '尚未运行推理 — FAZ 标注与体积指标将在推理后显示'
                : undefined
          }
          emptyText={!sampleId ? '暂无样本' : loadFailed && !slice ? '切片加载失败或后端未就绪' : '切片加载中…'}
          onBaseLoad={setDims}
        />
      </div>

      {/* 右：控制 / 指标侧栏 */}
      <aside className="space-y-4">
        <SampleInfoCard sample={sample} />
        <InferenceCard onRun={onRun} running={running} disabled={!sampleId} error={runError} result={result} />

        <AnnotationCard
          user={user}
          editing={editing}
          onToggleEditing={() => (editing ? stopEditing() : startEditing())}
          tool={tool}
          onToolChange={setTool}
          brushSize={brushSize}
          onBrushSizeChange={setBrushSize}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          onUndo={() => editor.undo()}
          onRedo={() => editor.redo()}
          dirty={editor.dirty}
          saving={saving}
          onSave={handleSave}
          onDiscard={() => {
            touchedRef.current.clear();
            editor.reset(imgDims.w, imgDims.h);
            ensureSliceMask(n); // 放弃全部修改并重新加载当前切片
          }}
          onResetToGt={onDeleteVersion}
          myVersion={myVersion}
          viewing={viewing ?? ''}
          annotators={annotators}
          onViewChange={onViewChange}
          targetLabel={sliceReady ? `正在编辑第 ${n} / ${nSlices} 张切片` : null}
          extraDisabledReason={disabledReason}
          error={saveError}
        />

        <div className="card space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">切片浏览</h3>
            <button
              type="button"
              onClick={() => setPlaying(prev => !prev)}
              disabled={!sampleId || editing}
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
          {!editing && (
            <>
              <ClassChips
                classes={[{ key: 'label', name: 'FAZ 标注', color: LABEL_COLOR }]}
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
            </>
          )}
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
