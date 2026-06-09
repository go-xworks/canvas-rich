import katex from 'katex';
import { Block, genBlockId } from '../model/schema';
import { OverlayBox } from '../text/doc-layout';

// 原子块 DOM 覆盖层管理：图片 / 公式(KaTeX) / 表格(可编辑)。
// 按「稳定 block id」缓存 DOM（不是对象身份）——undo(cloneDoc 换对象) 后同 id 复用同一 DOM，
// 不丢表格编辑态、不闪烁。事件闭包引用 entry.blk（每帧更新为当前块），避免写入陈旧对象。
// 分层：ui（呈现层，桥接 text/docLayout 的 OverlayBox 与原子块 DOM）。

/**
 * 覆盖层向装配层回调的句柄：表格编辑、测量高度、单元格聚焦/失焦。
 * @public
 */
export interface OverlayCallbacks {
  onTableEdit(block: Block): void;
  onMeasured(blockIndex: number, hLogical: number): void;
  onCellFocus(): void;
  onCellBlur(): void;
  /** 缩放手柄提交：图片新显示尺寸（CSS px），进撤销栈。 */
  onImageResize(blockIndex: number, widthCss: number, heightCss: number): void;
  /** 拖动重排：move 阶段更新落点指示，drop 阶段提交移动。 */
  onBlockMove(blockIndex: number, clientY: number, phase: 'move' | 'drop'): void;
}

interface Entry { el: HTMLElement; kind: string; content: string; blk: Block; blockIndex: number }

/**
 * 覆盖层管理器句柄：按帧将原子块 DOM 与布局盒同步对齐。
 * @public
 */
export interface OverlayManager {
  sync(doc: { blocks: Block[] }, overlays: OverlayBox[], scrollY: number, dpr: number, selectedBlock: number): void;
}

const CSS = `
.rte-ovl{position:absolute;border-radius:6px;box-sizing:border-box}
.rte-ovl img{width:100%;height:100%;object-fit:contain;border-radius:6px;background:var(--rte-code-bg);display:block}
.rte-formula{display:flex;align-items:center;justify-content:center;color:var(--rte-text);overflow:hidden;pointer-events:none}
.rte-formula .katex{font-size:1.3em}
.rte-formula.err{color:#dc2626;font:13px ui-monospace,monospace}
.rte-table{border-collapse:collapse;table-layout:fixed;width:100%;pointer-events:auto;background:var(--rte-overlay-bg);border-radius:6px;overflow:hidden}
.rte-table td{border:1px solid var(--rte-overlay-border);padding:5px 8px;color:var(--rte-text);font:14px system-ui,sans-serif;vertical-align:top;min-width:40px;outline:none}
.rte-table td:focus{box-shadow:inset 0 0 0 2px var(--rte-accent)}
.rte-resize{position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;border-radius:3px;background:var(--rte-accent);border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3);cursor:nwse-resize;pointer-events:auto;display:none}
.rte-ovl.rte-img-sel{cursor:move}
`;

/**
 * 创建覆盖层管理器：注入样式与定位层，按稳定 block id 缓存/复用原子块 DOM。
 * @public
 */
export function createOverlayManager(host: HTMLElement, cb: OverlayCallbacks): OverlayManager {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
  host.appendChild(layer);
  const map = new Map<string, Entry>();

  function build(kind: string, entry: Entry): HTMLElement {
    if (kind === 'image') {
      const wrap = document.createElement('div'); wrap.className = 'rte-ovl';
      const img = document.createElement('img'); img.draggable = false; wrap.appendChild(img);
      const handle = document.createElement('div'); handle.className = 'rte-resize'; wrap.appendChild(handle);

      // 缩放：拖右下手柄改宽（锁定宽高比、左上锚定），松手提交模型（进撤销栈）
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { handle.setPointerCapture(e.pointerId); } catch { /* 合成事件/无效指针 */ }
        const rect = wrap.getBoundingClientRect();
        const left = rect.left;
        const aspect = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : (rect.width / rect.height) || 2;
        const maxW = layer.getBoundingClientRect().right - left - 6;
        const onMove = (ev: PointerEvent) => {
          const w = Math.max(40, Math.min(maxW, ev.clientX - left));
          wrap.style.width = w + 'px'; wrap.style.height = (w / aspect) + 'px';
        };
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp);
          cb.onImageResize(entry.blockIndex, parseFloat(wrap.style.width), parseFloat(wrap.style.height));
        };
        handle.addEventListener('pointermove', onMove); handle.addEventListener('pointerup', onUp);
      });

      // 拖动重排：在图片本体按下并拖动 → 移到落点（仅选中态；阈值 5px 才算拖动）
      wrap.addEventListener('pointerdown', (e) => {
        if (e.target === handle || wrap.style.pointerEvents !== 'auto') return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY; let moving = false;
        const onMove = (ev: PointerEvent) => {
          if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          if (!moving) { moving = true; wrap.style.opacity = '0.5'; }
          cb.onBlockMove(entry.blockIndex, ev.clientY, 'move');
        };
        const onUp = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
          wrap.style.opacity = '';
          if (moving) cb.onBlockMove(entry.blockIndex, ev.clientY, 'drop');
        };
        window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
      });
      return wrap;
    }
    if (kind === 'formula') {
      const el = document.createElement('div'); el.className = 'rte-ovl rte-formula'; return el;
    }
    // table
    const wrap = document.createElement('div'); wrap.className = 'rte-ovl'; wrap.style.pointerEvents = 'auto';
    const t = document.createElement('table'); t.className = 'rte-table'; wrap.appendChild(t);
    wrap.addEventListener('focusin', () => cb.onCellFocus());
    wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget as Node)) cb.onCellBlur(); });
    return wrap;
  }

  function renderTable(entry: Entry) {
    const rows = entry.blk.attrs.rows ?? [];
    const sig = JSON.stringify(rows.map((r) => r.length));
    const table = entry.el.querySelector('table')!;
    if (entry.content === sig && table.rows.length === rows.length) return; // 结构未变：保留编辑态
    entry.content = sig;
    table.innerHTML = '';
    rows.forEach((row, r) => {
      const tr = table.insertRow();
      row.forEach((cell, c) => {
        const td = tr.insertCell();
        td.contentEditable = 'true'; td.spellcheck = false; td.textContent = cell;
        td.addEventListener('input', () => { (entry.blk.attrs.rows as string[][])[r][c] = td.textContent ?? ''; cb.onTableEdit(entry.blk); });
        td.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); focusCell(table, r, c + (e.shiftKey ? -1 : 1)); } });
      });
    });
  }
  function focusCell(table: HTMLTableElement, r: number, c: number) {
    const flat: HTMLElement[] = [];
    for (const row of Array.from(table.rows)) for (const cell of Array.from(row.cells)) flat.push(cell as HTMLElement);
    const cols = table.rows[0]?.cells.length ?? 1;
    flat[Math.max(0, Math.min(flat.length - 1, r * cols + c))]?.focus();
  }

  return {
    sync(doc, boxes, scrollY, dpr, selectedBlock) {
      const seen = new Set<string>();
      for (const box of boxes) {
        const blk = doc.blocks[box.block]; if (!blk) continue;
        const id = blk.attrs.id ?? (blk.attrs.id = genBlockId());
        seen.add(id);
        let entry = map.get(id);
        if (!entry || entry.kind !== box.kind) {
          if (entry) entry.el.remove();
          entry = { el: null as unknown as HTMLElement, kind: box.kind, content: '', blk, blockIndex: box.block };
          entry.el = build(box.kind, entry);
          layer.appendChild(entry.el); map.set(id, entry);
        }
        entry.blk = blk; entry.blockIndex = box.block; // 关键：闭包引用最新块与当前索引（undo/移动后变化）
        // 内容
        if (box.kind === 'image') {
          const img = entry.el.querySelector('img')!; const src = blk.attrs.src ?? '';
          if (entry.content !== src) { img.src = src; entry.content = src; }
        } else if (box.kind === 'formula') {
          const tex = blk.attrs.latex ?? '';
          if (entry.content !== tex) {
            entry.content = tex; entry.el.classList.remove('err');
            try { entry.el.innerHTML = katex.renderToString(tex, { throwOnError: false, displayMode: true, output: 'html', trust: false }); }
            catch { entry.el.classList.add('err'); entry.el.textContent = tex; }
          }
        } else renderTable(entry);
        // 定位
        const s = entry.el.style;
        s.left = (box.x / dpr) + 'px'; s.top = ((box.y - scrollY) / dpr) + 'px'; s.width = (box.w / dpr) + 'px';
        s.height = box.kind === 'image' ? (box.h / dpr) + 'px' : 'auto';
        s.display = '';
        s.outline = box.block === selectedBlock ? '2px solid var(--rte-accent)' : '';
        s.outlineOffset = '2px';
        if (box.kind === 'image') {
          // 选中态：开启指针交互（缩放手柄 + 拖动重排）；非选中态保持点击穿透到 canvas（用于选中/光标）
          const sel = box.block === selectedBlock;
          s.pointerEvents = sel ? 'auto' : 'none';
          entry.el.classList.toggle('rte-img-sel', sel);
          const handle = entry.el.querySelector('.rte-resize') as HTMLElement | null;
          if (handle) handle.style.display = sel ? 'block' : 'none';
        } else { const hL = entry.el.offsetHeight; if (hL > 0) cb.onMeasured(box.block, hL); }
      }
      for (const [id, entry] of map) if (!seen.has(id)) { entry.el.remove(); map.delete(id); }
    },
  };
}
