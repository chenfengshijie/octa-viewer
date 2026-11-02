/**
 * 类别开关 chips：色点 + 名称，点击切换显隐。
 * @param {{
 *   classes: Array<{key: string, name: string, color: string}>,
 *   active: Record<string, boolean>,      // 未命中默认视为开启
 *   onToggle: (key: string) => void,
 * }} props
 */
export default function ClassChips({ classes, active, onToggle }) {
  if (!classes?.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {classes.map(cls => {
        const on = active[cls.key] !== false;
        return (
          <button
            key={cls.key}
            type="button"
            onClick={() => onToggle(cls.key)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              on
                ? 'border-slate-300 bg-white text-slate-700 shadow-sm hover:border-slate-400'
                : 'border-slate-200 bg-slate-100 text-slate-400'
            }`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: cls.color, opacity: on ? 1 : 0.3 }} />
            {cls.name}
          </button>
        );
      })}
    </div>
  );
}
