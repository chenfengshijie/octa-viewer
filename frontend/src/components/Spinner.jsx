import { Loader2 } from 'lucide-react';

/**
 * 通用加载图标（旋转圆环）。
 * @param {{className?: string}} props
 */
export default function Spinner({ className = 'h-4 w-4' }) {
  return <Loader2 className={`animate-spin ${className}`} aria-label="加载中" />;
}
