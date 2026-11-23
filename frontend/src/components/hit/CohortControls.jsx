export function CohortControls({ authors, selection, onChange }) {
  const { author, reference_author: reference } = selection;
  function changeAuthor(value) {
    onChange({ author: value, reference_author: !value || reference === value ? '' : reference });
  }
  return (
    <div className="grid gap-3 text-sm md:grid-cols-2">
      <label>
        比较对象
        <select
          className="select-input block"
          value={author}
          onChange={(e) => changeAuthor(e.target.value)}
        >
          <option value="">每批次最近保存的修订</option>
          {authors.map((row) => (
            <option key={row.username} value={row.username}>
              {row.username}（{row.batches} 个批次）
            </option>
          ))}
        </select>
      </label>
      <label>
        参照
        <select
          className="select-input block"
          disabled={!author}
          value={reference}
          onChange={(e) => onChange({ ...selection, reference_author: e.target.value })}
        >
          <option value="">同批次原始预测</option>
          {authors
            .filter((row) => row.username !== author)
            .map((row) => (
              <option key={row.username} value={row.username}>
                {row.username} 的最近修订
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}

export function DistributionTable({ data }) {
  return (
    <details className="rounded border p-3 text-sm">
      <summary>查看分布与像素计数</summary>
      <table className="my-3 w-full text-left">
        <caption className="sr-only">已纳入批次的重合指标分布</caption>
        <thead>
          <tr>
            {['指标', '最低', '中位数', '最高'].map((name) => (
              <th key={name}>{name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {['dice', 'iou'].map((key) => (
            <tr key={key}>
              <th>{key === 'dice' ? 'Dice' : 'IoU'}</th>
              {['min', 'median', 'max'].map((stat) => (
                <td key={stat}>{data.distribution[key][stat]?.toFixed(4) ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid gap-2 sm:grid-cols-3">
        {[
          ['共有前景', data.totals.shared],
          ['新增像素', data.totals.added],
          ['擦除像素', data.totals.erased],
          ['参照前景', data.totals.reference_pixels],
          ['目标前景', data.totals.target_pixels],
          ['纳入病例', data.cases],
        ].map(([name, value]) => (
          <div className="rounded bg-slate-50 p-2" key={name}>
            <dt>{name}</dt>
            <dd className="font-mono">{value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
