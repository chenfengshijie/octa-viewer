import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, PanelLeftClose, Search } from 'lucide-react';

/** 病变类型分组顺序（OCTA-500 标签体系），未知类型排在最后 */
const GROUP_ORDER = ['NORMAL', 'DR', 'CNV', 'OTHERS'];
const GROUP_LABELS = { NORMAL: '正常', DR: 'DR', CNV: 'CNV', OTHERS: '其他' };

/**
 * 左侧样本浏览器：按病变类型分组 + 搜索过滤 + 分组可折叠，替代原顶栏下拉选择器。
 * 样本较多时靠滚动 + 搜索 + 按组折叠灵活定位；激活样本高亮并自动滚动到可见区域。
 *
 * @param {{
 *   samples: Array<{id: string, disease: string, sex: string, eye: string, age: number}>,
 *   value: string,            // 当前激活样本 id
 *   onChange: (id: string) => void,
 *   onCollapse: () => void,   // 收起整个面板（由父级渲染展开按钮）
 * }} props
 */
export default function SampleSidebar({ samples, value, onChange, onCollapse }) {
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState({}); // disease → 是否折叠

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = samples.filter(
      s =>
        !q ||
        String(s.id).toLowerCase().includes(q) ||
        String(s.disease ?? '').toLowerCase().includes(q),
    );
    const sorted = [...filtered].sort((a, b) =>
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
    );
    const byKey = new Map();
    for (const sample of sorted) {
      const key = sample.disease ?? 'OTHERS';
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(sample);
    }
    // 固定顺序的组在前，其余（未知类型）按出现顺序排后
    const ordered = [
      ...GROUP_ORDER.filter(key => byKey.has(key)).map(key => [key, byKey.get(key)]),
      ...[...byKey.keys()].filter(key => !GROUP_ORDER.includes(key)).map(key => [key, byKey.get(key)]),
    ];
    return ordered.map(([disease, list]) => ({ disease, list }));
  }, [samples, query]);

  return (
    <div className="card flex max-h-full flex-col p-3">
      {/* 头部：标题 + 总数 + 收起 */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">
          样本
          <span className="ml-1.5 text-xs font-normal tabular-nums text-slate-400">{samples.length}</span>
        </h3>
        <button
          type="button"
          onClick={onCollapse}
          title="收起样本列表"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      {/* 搜索：按 ID / 病变类型过滤 */}
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索 ID / 病变类型"
          className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
        />
      </div>

      {/* 分组列表 */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pt-2 xl:pr-1">
        {samples.length === 0 ? (
          <p className="px-1 py-8 text-center text-xs text-slate-400">暂无样本</p>
        ) : groups.length === 0 ? (
          <p className="px-1 py-8 text-center text-xs text-slate-400">无匹配样本</p>
        ) : (
          groups.map(({ disease, list }) => {
            const open = !folded[disease];
            return (
              <div key={disease}>
                <button
                  type="button"
                  onClick={() => setFolded(prev => ({ ...prev, [disease]: !prev[disease] }))}
                  className="flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  <span>{disease}</span>
                  {GROUP_LABELS[disease] && (
                    <span className="text-[10px] font-normal text-slate-400">{GROUP_LABELS[disease]}</span>
                  )}
                  <span className="ml-auto text-[10px] font-normal tabular-nums text-slate-400">{list.length}</span>
                </button>
                {open && (
                  <div className="mt-0.5 space-y-0.5">
                    {list.map(sample => (
                      <SampleRow
                        key={sample.id}
                        sample={sample}
                        active={sample.id === value}
                        onClick={() => sample.id !== value && onChange(sample.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** 单个样本行：激活高亮 + 自动滚动到可见区域 */
function SampleRow({ sample, active, onClick }) {
  const ref = useRef(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={`${sample.id} · ${sample.disease} · ${sample.sex} · ${sample.eye} · ${sample.age}岁`}
      className={`w-full rounded-lg px-2.5 py-1.5 text-left transition ${
        active ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-slate-50'
      }`}
    >
      <p className={`text-xs font-semibold tabular-nums ${active ? 'text-blue-700' : 'text-slate-700'}`}>
        {sample.id}
      </p>
      <p className={`text-[11px] ${active ? 'text-blue-600/80' : 'text-slate-400'}`}>
        {sample.sex} · {sample.eye} · {sample.age}岁
      </p>
    </button>
  );
}
