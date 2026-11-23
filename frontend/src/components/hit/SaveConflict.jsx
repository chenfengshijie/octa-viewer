import { versionName } from './api.js';

export default function SaveConflict({ conflict, onKeep }) {
  if (!conflict) return null;
  const draft = conflict.draft ? 'data:image/png;base64,' + conflict.draft : null;
  return (
    <section className="space-y-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <h3 className="font-semibold">另一处已更新当前版本</h3>
      <p>其他窗口的版本 · {versionName(conflict.head)}</p>
      <div className="grid grid-cols-2 gap-2">
        <figure>
          <img
            className="aspect-square w-full bg-black"
            src={conflict.currentMask}
            alt="其他窗口保存的掩膜"
          />
          <figcaption>当前个人掩膜</figcaption>
        </figure>
        <figure>
          {draft ? (
            <img className="aspect-square w-full bg-black" src={draft} alt="本次编辑的掩膜" />
          ) : (
            <div className="aspect-square w-full bg-black" role="img" aria-label="空掩膜" />
          )}
          <figcaption>本次保存的草稿</figcaption>
        </figure>
      </div>
      <button className="rounded border bg-white px-3 py-2" onClick={onKeep}>
        保留本地编辑，继续保存为新版
      </button>
      <p>确认后点击保存，两个版本都可从历史中查阅。</p>
    </section>
  );
}
