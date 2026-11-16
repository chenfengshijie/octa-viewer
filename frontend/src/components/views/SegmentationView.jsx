import { useEffect, useRef, useState } from 'react';
import { saveAnnotation } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import AnnotationCard from '../annotation/AnnotationCard.jsx';
import CanvasToolbar from '../annotation/CanvasToolbar.jsx';
import PaintLayer from '../annotation/PaintLayer.jsx';
import { loadMaskFromUrl, useMaskEditor } from '../annotation/useMaskEditor.js';
import useSpaceHold from '../annotation/useSpaceHold.js';
import useMediaQuery, { useCoarsePointer } from '../../hooks/useMediaQuery.js';
import ClassChips from '../ClassChips.jsx';
import ImageViewer from '../ImageViewer.jsx';
import InferenceCard from '../InferenceCard.jsx';
import MetricCard from '../MetricCard.jsx';
import SampleInfoCard from '../SampleInfoCard.jsx';
import Slider from '../Slider.jsx';

const DEFAULT_OPACITY = 0.7;
const DEFAULT_BRUSH = 16;

/**
 * 分割类任务共用视图（vessel / faz）：输入 en-face 投影图，
 * 推理后叠加掩膜层，支持类别开关 + 全局不透明度 + 量化指标。
 * 登录用户可进入画笔编辑模式：按类别绘制/擦除掩膜，保存为自己的标注版本
 * （首次保存自动从 GT fork，见后端 annotations.py）。
 * 编辑态视觉分层：当前画笔类别全量不透明度 + 外缘描边，其余类别按 DIM_RATIO 弱化；
 * 同时左列变为左右分屏，右侧为 OCT 结构投影（proj_oct.png）只读镜像面板，
 * 实时同步主视图缩放平移并叠加当前类别掩膜，便于与真实结构对照。
 *
 * @param {{
 *   task: {id: string, name: string, classes?: Array<{key: string, name: string, color: string}>},
 *   sampleId: string,
 *   sample: object|null,
 *   result: object|null,  // POST /api/infer 结果
 *   running: boolean,
 *   runId: number,        // 每次推理自增，用于复位内部状态
 *   runError: string|null,
 *   onRun: () => void,
 *   user: object|null,          // 当前登录用户
 *   viewing: string,            // 当前查看版本：'' = 原始 GT，否则用户名
 *   annotators: Array,          // 标注版本列表
 *   myVersion: boolean,         // 我是否有已保存的版本
 *   onViewChange: (name: string) => void,
 *   onSaved: () => void,        // 保存成功后由 Task 刷新版本并重新推理
 *   onDeleteVersion: () => void, // 删除我的版本（恢复原始 GT），由 Task 实现并刷新
 * }} props
 */
export default function SegmentationView({
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
  const [active, setActive] = useState({}); // 类别 key → 是否显示（未命中默认开启）
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [dims, setDims] = useState(null); // 底图原始像素尺寸（= 掩膜逻辑坐标）
  const [mainView, setMainView] = useState(null); // 主视图当前缩放平移（编辑态对照面板同步用）

  // ---- 标注编辑状态 ----
  const editor = useMaskEditor();
  const [editing, setEditing] = useState(false);
  const [initing, setIniting] = useState(false); // 进入编辑时加载掩膜中
  const [tool, setTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);
  const [paintClass, setPaintClass] = useState(null); // 画笔目标类别
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const spaceHeld = useSpaceHold(editing && tool !== 'pan'); // 按住空格临时切换为平移
  const coarse = useCoarsePointer(); // 触屏设备：悬浮工具栏 + 触屏版提示文案
  const wideSplit = useMediaQuery('(min-width: 1024px)'); // ≥lg 才能并排双视图（OCTA|OCT 分屏）
  const [pane, setPane] = useState('octa'); // 窄屏编辑态单视图切换：octa = 标注主视图，oct = 结构对照
  const viewerAreaRef = useRef(null); // 进入编辑时滚动到可视区（工具栏贴着画布底，不能在折叠线以下）

  // 触屏进入编辑：任务头卡 + 模型卡把画布顶到折叠线以下，自动滚过去让画布 + 悬浮工具栏同屏
  useEffect(() => {
    if (editing && coarse) viewerAreaRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [editing, coarse]);

  // 每次重新推理后复位开关与透明度
  useEffect(() => {
    setActive({});
    setOpacity(DEFAULT_OPACITY);
  }, [runId]);

  const overlayDefs = result?.overlays ?? [];
  // 推理结果携带类别定义时优先使用，否则回退到任务自带定义
  const chips = overlayDefs.length
    ? overlayDefs.map(o => ({ key: o.key, name: o.name, color: o.color }))
    : task.classes ?? [];
  const classDefs = task.classes ?? chips; // 编辑时按任务的完整类别集合初始化（含被清空的类）
  const metrics = result?.metrics ?? [];

  // 非编辑态：远程掩膜 URL 叠加层；编辑态：工作掩膜由 PaintLayer 渲染
  const overlays = overlayDefs.map(o => ({
    key: o.key,
    src: o.mask_url,
    color: o.color,
    visible: active[o.key] !== false,
    opacity,
  }));

  const imgDims = dims ?? { w: 400, h: 400 };
  const paintEntries = classDefs
    .filter(c => editor.getMask(c.key))
    .map(c => ({ key: c.key, data: editor.getMask(c.key), color: c.color }));

  // 对照面板 entry：仅当前画笔类别（与主视图当前类别同款渲染：全量 alpha + 描边）
  const refDef = editing && paintClass ? classDefs.find(c => c.key === paintClass) : null;
  const refData = refDef ? editor.getMask(refDef.key) : null;
  const refEntry = refDef && refData ? { key: refDef.key, data: refData, color: refDef.color } : null;

  /** 进入编辑：按当前展示版本的掩膜初始化工作掩膜 */
  const startEditing = async () => {
    setEditing(true);
    setIniting(true);
    setSaveError(null);
    editor.reset(imgDims.w, imgDims.h);
    await Promise.all(
      classDefs.map(async c => {
        const def = overlayDefs.find(o => o.key === c.key);
        editor.setMask(c.key, await loadMaskFromUrl(def?.mask_url, imgDims.w, imgDims.h));
      }),
    );
    editor.markClean(); // 初始加载不算修改
    setPaintClass(prev => prev ?? classDefs[0]?.key ?? null);
    setIniting(false);
  };

  /** 退出编辑：有未保存更改时确认放弃 */
  const stopEditing = () => {
    if (editor.dirty && !window.confirm('有未保存的修改，确定放弃并退出编辑？')) return;
    setEditing(false);
    editor.reset(0, 0);
  };

  /** 保存：全类别导出为 base64 PNG（清空的类别传 null = 删除该类掩膜） */
  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const masks = {};
      for (const c of classDefs) masks[c.key] = editor.exportMask(c.key);
      await saveAnnotation(sampleId, task.id, { masks });
      editor.markClean();
      onSaved?.();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  /** 选择画笔类别时自动点亮其可见性，保证画了就能看到 */
  const selectPaintClass = key => {
    setPaintClass(key);
    setActive(prev => ({ ...prev, [key]: true }));
  };

  const disabledReason = !user
    ? '请先登录或注册，即可编辑标注'
    : viewing && viewing !== user.username
      ? `正在查看 ${viewing} 的版本（只读），切换版本后可编辑`
      : !result
        ? '请先运行推理，加载标注后再编辑'
        : null;

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* 左：影像查看器（黑底）。宽屏编辑态为左右分屏（OCTA 主视图 + OCT 同步对照）；
          窄屏只显示当前 pane，顶部悬浮切换按钮 */}
      <div
        ref={viewerAreaRef}
        className={
          editing
            ? 'relative grid h-viewer min-h-[420px] grid-cols-1 grid-rows-[minmax(0,1fr)] gap-3 scroll-mt-14 lg:grid-cols-2'
            : 'relative h-viewer min-h-[420px] scroll-mt-14'
        }
      >
        <div className={editing && !wideSplit && pane === 'oct' ? 'hidden' : 'h-full'}>
          <ImageViewer
            baseSrc={sampleId ? `/data/samples/${sampleId}/proj_octa.png` : null}
            overlays={editing ? [] : overlays}
            loading={running}
            paintMode={editing && tool !== 'pan' && !spaceHeld}
            persistKey={task ? `${task.id}-${sampleId}` : undefined}
            onViewChange={setMainView}
            stageExtra={
              editing && (
                <PaintLayer
                  dims={imgDims}
                  entries={paintEntries}
                  version={editor.version}
                  opacity={opacity}
                  editing={!initing && !spaceHeld}
                  tool={tool}
                  brushSize={brushSize}
                  activeKey={paintClass}
                  editor={editor}
                  showOutline
                  cursorColor={classDefs.find(c => c.key === paintClass)?.color}
                  onUndo={() => editor.undo()}
                  onRedo={() => editor.redo()}
                  onBrushSizeChange={setBrushSize}
                />
              )
            }
            hint={
              editing
                ? initing
                  ? '正在加载掩膜…'
                  : coarse
                    ? `画笔编辑中：${classDefs.find(c => c.key === paintClass)?.name ?? '-'}（单指/笔绘制 · 双指平移 · 捏合缩放）`
                    : `画笔编辑中：${classDefs.find(c => c.key === paintClass)?.name ?? '-'}（滚轮缩放 · 空格/右键拖动平移 · [ ] 调笔刷）`
                : result
                  ? overlayDefs.length
                    ? undefined
                    : '推理完成，但未返回叠加层'
                  : sampleId
                    ? '尚未运行推理 — 结果叠加层将显示在此'
                    : undefined
            }
            emptyText={sampleId ? '影像加载失败或后端未就绪' : '暂无样本'}
            onBaseLoad={setDims}
          />
        </div>

        {/* 右半：OCT 结构投影对照，完全镜像主视图缩放平移，只叠加当前画笔类别 */}
        {editing && mainView && (
          <div className={editing && !wideSplit && pane === 'octa' ? 'hidden' : 'h-full'}>
            <ImageViewer
              baseSrc={`/data/samples/${sampleId}/proj_oct.png`}
              mirror
              viewOverride={mainView}
              hint="OCT 结构投影 · 与左侧标注同步对照"
              stageExtra={
                refEntry && (
                  /* proj_oct.png 与 proj_octa.png 同源自同一 体数据，尺寸一致，掩膜逻辑坐标可直接复用 */
                  <PaintLayer
                    dims={imgDims}
                    entries={[refEntry]}
                    version={editor.version}
                    opacity={opacity}
                    editing={false}
                    tool="pan"
                    brushSize={brushSize}
                    activeKey={refEntry.key}
                    showOutline
                  />
                )
              }
            />
          </div>
        )}

        {/* 窄屏编辑态：OCTA / OCT 单视图切换（宽屏保持左右分屏，不显示）。
            top-16 让开左上角的缩放 HUD（390px 窄屏两者会重叠） */}
        {editing && !wideSplit && (
          <div className="absolute left-1/2 top-16 z-20 flex -translate-x-1/2 rounded-xl border border-white/10 bg-black/60 p-1 backdrop-blur-sm">
            {[
              ['octa', 'OCTA 标注'],
              ['oct', 'OCT 对照'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPane(key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  pane === key ? 'bg-white/90 text-slate-900' : 'text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* 触屏悬浮标注工具栏：撤销/工具/笔刷/类别/保存（触屏设备没有键盘快捷键，
            右侧栏在画布视口之外，必须把高频操作放到手边） */}
        <CanvasToolbar
          visible={editing && coarse && !initing}
          tool={tool}
          onToolChange={setTool}
          brushSize={brushSize}
          onBrushSizeChange={setBrushSize}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          onUndo={() => editor.undo()}
          onRedo={() => editor.redo()}
          classes={classDefs.length > 1 ? classDefs : null}
          activeClass={paintClass}
          onClassChange={selectPaintClass}
          dirty={editor.dirty}
          saving={saving}
          onSave={handleSave}
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
          onDiscard={() => startEditing()} // 重新从当前版本加载，即放弃修改
          onResetToGt={onDeleteVersion}
          myVersion={myVersion}
          viewing={viewing ?? ''}
          annotators={annotators}
          onViewChange={onViewChange}
          targetLabel={
            editing
              ? `画笔类别：${classDefs.find(c => c.key === paintClass)?.name ?? '-'} · 底图 ${imgDims.w}×${imgDims.h}`
              : null
          }
          extraDisabledReason={disabledReason}
          error={saveError}
        />

        {/* 画笔目标类别选择（编辑态，多类别任务） */}
        {editing && !initing && classDefs.length > 1 && (
          <div className="card space-y-2.5 p-4">
            <h3 className="text-sm font-semibold text-slate-700">画笔类别</h3>
            <div className="flex flex-wrap gap-1.5">
              {classDefs.map(c => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => selectPaintClass(c.key)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                    paintClass === c.key
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.color }} />
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {chips.length > 0 && (
          <div className="card space-y-3.5 p-4">
            <h3 className="text-sm font-semibold text-slate-700">叠加图层</h3>
            <ClassChips
              classes={chips}
              active={active}
              onToggle={key => setActive(prev => ({ ...prev, [key]: prev[key] === false }))}
            />
            <Slider
              label={editing ? '当前类别不透明度' : '掩膜不透明度'}
              min={0}
              max={100}
              value={Math.round(opacity * 100)}
              onChange={value => setOpacity(value / 100)}
              format={value => `${value}%`}
            />
          </div>
        )}

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
