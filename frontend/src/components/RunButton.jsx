import { Play } from 'lucide-react';
import Spinner from './Spinner.jsx';

/**
 * 「运行推理」按钮：运行中显示转圈并禁用。
 * @param {{onClick: () => void, loading?: boolean, disabled?: boolean, children?: string}} props
 */
export default function RunButton({ onClick, loading = false, disabled = false, children = '运行推理' }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || loading} className="btn-primary w-full">
      {loading ? (
        <>
          <Spinner /> 推理中…
        </>
      ) : (
        <>
          <Play className="h-4 w-4" /> {children}
        </>
      )}
    </button>
  );
}
