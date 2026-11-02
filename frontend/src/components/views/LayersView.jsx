import { useEffect, useRef, useState } from 'react';
import { fetchBoundaryCurves } from '../../api.js';
import ImageViewer from '../ImageViewer.jsx';
import InferenceCard from '../InferenceCard.jsx';
import SampleInfoCard from '../SampleInfoCard.jsx';
import Slider from '../Slider.jsx';

const DEFAULT_Y = 159; // 默认停在中央凹附近（B-scan 160）
const QUICK_JUMPS = [0, 79, 159, 239, 319, 399]; // 快捷切片位置（y 行号）

// 曲线缓存：拖动滑块来回浏览时不重复请求
const curveCache = new Map();

/**
 * 分层任务视图：滑块 y 直接决定显示的 B-scan（第 y+1 张，即体数据在行 y 的切面）
 * 与叠加的 6 条边界曲线（GT_Layers 在该行的深度值），图像与标注严格一一对应。
 * 曲线画在与影像对齐的 canvas 上（逻辑坐标 = 影像原始像素坐标，x→列，points[i]→深度行）。
 *
 * @param {{
 *   sampleId: string,
 *   sample: object|null,
 *   result: object|null,  // 推理结果
 *   running: boolean,
 *   runId: number,
 *   runError: string|null,
 *   onRun: () => void,
 * }} props
 */
export default function LayersView({ sampleId, sample, result, running, runId, runError, onRun }) {
  const [y, setY] = useState(DEFAULT_Y);
  const [curves, setCurves] = useState(null);
  const [dims, setDims] = useState(null); // B-scan 原始像素尺寸（canvas 逻辑坐标）
  const canvasRef = useRef(null);

  const sliceNo = String(y + 1).padStart(3, '0');
  const bscanUrl = sampleId ? `/data/samples/${sampleId}/vol/${sliceNo}.jpg` : null;

  // 换样本或重新推理后复位浏览状态
  useEffect(() => {
    setY(DEFAULT_Y);
    setCurves(null);
    setDims(null);
  }, [sampleId, runId]);

  // 拉取当前行 y 的边界曲线（带缓存；abort 语义：仅采纳最新一次请求）
  useEffect(() => {
    if (!sampleId || !result) return undefined;
    const cacheKey = `${sampleId}:${y}`;
    if (curveCache.has(cacheKey)) {
      setCurves(curveCache.get(cacheKey));
      return undefined;
    }
    let alive = true;
    fetchBoundaryCurves(sampleId, y)
      .then(data => {
        const next = Array.isArray(data?.curves) ? data.curves : [];
        curveCache.set(cacheKey, next);
        if (alive) setCurves(next);
      })
      .catch(() => {
        /* 曲线加载失败时保留上一次结果 */
      });
    return () => {
      alive = false;
    };
  }, [sampleId, y, result, runId]);

  // 将边界曲线绘制到与影像对齐的 canvas（x→列，points[i]→深度行）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims) return;
    const dpr = 2; // 2 倍采样保证曲线在高倍缩放下仍较清晰
    canvas.width = dims.w * dpr;
    canvas.height = dims.h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dims.w, dims.h);
    if (!curves) return;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.95;
    for (const curve of curves) {
      const points = curve.points ?? [];
      if (points.length < 2) continue;
      ctx.strokeStyle = curve.color;
      ctx.beginPath();
      const stepX = dims.w / (points.length - 1);
      points.forEach((row, i) => {
        const px = i * stepX;
        const py = Math.min(dims.h, Math.max(0, row));
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }, [curves, dims]);

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* 左：查看器 + 快捷切片缩略图行 */}
      <div>
        <div className="h-[58vh] min-h-[400px]">
          <ImageViewer
            baseSrc={bscanUrl}
            loading={running}
            stageExtra={bscanUrl && <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />}
            hint={
              result
                ? `当前叠加的是第 ${y + 1} 张 B-scan（体数据行 y=${y}）上的 6 条边界`
                : '尚未运行推理 — 运行后可浏览任意 B-scan 并叠加对应边界曲线'
            }
            emptyText={!sampleId ? '暂无样本' : 'B-scan 加载失败或后端未就绪'}
            onBaseLoad={setDims}
          />
        </div>
        {result && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {QUICK_JUMPS.map(jumpY => {
              const n = jumpY + 1;
              return (
                <button
                  key={jumpY}
                  type="button"
                  onClick={() => setY(jumpY)}
                  title={`跳到 B-scan ${n}`}
                  className={`relative h-16 w-11 shrink-0 overflow-hidden rounded-lg border-2 bg-[#0b0f14] transition ${
                    jumpY === y ? 'border-blue-500' : 'border-transparent opacity-50 hover:opacity-90'
                  }`}
                >
                  <img
                    src={`/data/samples/${sampleId}/vol/${String(n).padStart(3, '0')}.jpg`}
                    alt={`B-scan ${n}`}
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[10px] leading-4 tabular-nums text-slate-200">
                    {n}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 右：控制侧栏（layers 无掩膜透明度条） */}
      <aside className="space-y-4">
        <SampleInfoCard sample={sample} />
        <InferenceCard onRun={onRun} running={running} disabled={!sampleId} error={runError} result={result} />

        <div className="card space-y-4 p-4">
          <h3 className="text-sm font-semibold text-slate-700">边界浏览</h3>
          <Slider
            label="B-scan 切片"
            min={0}
            max={399}
            value={y}
            onChange={setY}
            disabled={!result}
            format={value => `第 ${value + 1} 张 / 400`}
          />
          {curves?.length > 0 && (
            <ul className="space-y-1.5 border-t border-slate-100 pt-3">
              {curves.map(curve => (
                <li key={curve.key} className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: curve.color }} />
                  {curve.name}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs leading-relaxed text-slate-400">
            图像与标注一一对应：显示的是体数据在行 y={y}
            处的切面（第 {y + 1} 张 B-scan），曲线为 6 条层边界在这一行的深度位置。
          </p>
        </div>
      </aside>
    </div>
  );
}
