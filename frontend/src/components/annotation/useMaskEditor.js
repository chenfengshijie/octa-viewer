import { useCallback, useEffect, useRef, useState } from 'react';

const UNDO_LIMIT = 20;

/**
 * 画笔式掩膜编辑器（SegmentationView / Faz3dView 共用）。
 *
 * 工作掩膜以 key（vessel/faz 的类别 key，或 faz3d 的切片号）索引，每个是
 * Uint8Array（255=前景，0=背景），存于 ref 中以避免大数组反复触发渲染；
 * 任何修改通过递增 version 通知 PaintLayer 重绘，dirty 以 cleanVersion 基线判断。
 */
export function useMaskEditor() {
  const masksRef = useRef({}); // key -> Uint8Array
  const dimsRef = useRef({ w: 0, h: 0 });
  const undoRef = useRef([]); // [{key, data}]（笔画开始前的快照）
  const redoRef = useRef([]);
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [stacks, setStacks] = useState({ undo: 0, redo: 0 });
  // 版本的同步镜像 + 干净基线：setMask/markClean 在同一宏任务内连续调用时也能取到准确值
  const versionRef = useRef(0);
  const cleanVersionRef = useRef(0);

  const bump = useCallback(() => {
    versionRef.current += 1;
    setVersion(versionRef.current);
  }, []);

  /** undo/redo 回退掩膜内容时同步回退版本号（回到该操作前的版本），使「撤销到干净状态」能正确清除 dirty */
  const setVersionTo = useCallback(v => {
    versionRef.current = v;
    setVersion(v);
  }, []);

  const syncStacks = useCallback(
    () => setStacks({ undo: undoRef.current.length, redo: redoRef.current.length }),
    [],
  );

  // 版本变化后校正 dirty（覆盖初始化加载等非用户编辑造成的版本自增）
  useEffect(() => {
    setDirty(versionRef.current !== cleanVersionRef.current);
  }, [version]);

  /** 清空全部工作掩膜与撤销栈（进入/退出编辑、切换切片集时调用） */
  const reset = useCallback((w, h) => {
    masksRef.current = {};
    undoRef.current = [];
    redoRef.current = [];
    dimsRef.current = { w, h };
    versionRef.current = 0;
    cleanVersionRef.current = 0;
    setVersion(0);
    setDirty(false);
    syncStacks();
  }, [syncStacks]);

  /** 设置（复制）某个 key 的工作掩膜 */
  const setMask = useCallback((key, data) => {
    masksRef.current[key] = Uint8Array.from(data);
    bump();
  }, [bump]);

  const getMask = useCallback(key => masksRef.current[key] ?? null, []);

  /** 笔画开始：压入当前快照（连同当时版本号）供撤销；同时清空重做栈 */
  const beginStroke = useCallback(key => {
    const cur = masksRef.current[key];
    if (!cur) return;
    undoRef.current.push({ key, data: Uint8Array.from(cur), versionBefore: versionRef.current });
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
    redoRef.current = [];
    syncStacks();
  }, [syncStacks]);

  /**
   * 从 (x0,y0) 到 (x1,y1) 以半径 radius 盖圆形笔刷（erase=true 时擦除）。
   * 坐标为影像像素坐标；起终点相同（first point）时只盖一个圆。
   */
  const stroke = useCallback((key, x0, y0, x1, y1, radius, erase) => {
    const mask = masksRef.current[key];
    const { w, h } = dimsRef.current;
    if (!mask || !w) return;
    const value = erase ? 0 : 255;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      stampCircle(mask, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, value);
    }
    bump();
  }, [bump]);

  const undo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    redoRef.current.push({ key: entry.key, data: Uint8Array.from(masksRef.current[entry.key]), versionBefore: versionRef.current });
    masksRef.current[entry.key] = entry.data;
    syncStacks();
    setVersionTo(entry.versionBefore);
  }, [setVersionTo, syncStacks]);

  const redo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    undoRef.current.push({ key: entry.key, data: Uint8Array.from(masksRef.current[entry.key]), versionBefore: versionRef.current });
    masksRef.current[entry.key] = entry.data;
    syncStacks();
    setVersionTo(entry.versionBefore);
  }, [setVersionTo, syncStacks]);

  // version 的同步镜像已在上方维护；markClean 以当前准确版本为干净基线
  const markClean = useCallback(() => {
    cleanVersionRef.current = versionRef.current;
    setDirty(false);
  }, []);

  /** 导出某个 key 的掩膜为 base64 PNG（白前景黑背景）；全空时返回 null */
  const exportMask = useCallback(
    key => exportMaskPng(masksRef.current[key], dimsRef.current),
    [],
  );

  return {
    masksRef,
    version,
    dirty,
    canUndo: stacks.undo > 0,
    canRedo: stacks.redo > 0,
    reset,
    setMask,
    getMask,
    beginStroke,
    stroke,
    undo,
    redo,
    markClean,
    exportMask,
  };
}

// ---------------------------------------------------------------- 工具函数
function stampCircle(mask, w, h, cx, cy, r, value) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) mask[y * w + x] = value;
    }
  }
}

/** 从掩膜 PNG 静态 URL 加载为 Uint8Array（255/0）；失败或缺失返回全 0 掩膜 */
export async function loadMaskFromUrl(url, w, h, strict = false) {
  const data = new Uint8Array(w * h);
  if (!url) return data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('掩膜读取失败');
    const bitmap = await createImageBitmap(await res.blob());
    if (strict && (bitmap.width !== w || bitmap.height !== h)) {
      bitmap.close?.();
      throw new Error('掩膜与投影尺寸不一致');
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < w * h; i++) {
      if ((px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3 > 127) data[i] = 255;
    }
  } catch (err) {
    if (strict) throw err;
  }
  return data;
}

/** Uint8Array 掩膜 -> base64 PNG（白前景黑背景）；数据缺失或全空返回 null */
export function exportMaskPng(data, { w, h }) {
  if (!data || !w) return null;
  let any = false;
  for (let i = 0; i < data.length; i++) {
    if (data[i]) {
      any = true;
      break;
    }
  }
  if (!any) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const on = data[i] ? 255 : 0;
    img.data[i * 4] = on;
    img.data[i * 4 + 1] = on;
    img.data[i * 4 + 2] = on;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
