// 图片插入弹层（ui 层）：本地上传（点击/拖拽）+ URL + 实时预览。替代「只能填 URL」的简陋输入。
// 亮色主题（--rte-* 变量）、Promise 返回所选图片 src（data URL 或外链），取消返回 null。
// 分层：纯 DOM 控件，不依赖 model。
import { icon } from './icons';

/** 图片弹层句柄：弹出并解析为图片 src（取消返回 null）；销毁（移除 body 门户节点）。 @internal */
export interface ImageDialog { open(): Promise<string | null>; destroy(): void; }

/**
 * 创建挂到 document.body 的单例图片插入弹层。
 * @internal
 */
export function createImageDialog(): ImageDialog {
  const scrim = document.createElement('div');
  scrim.className = 'fixed inset-0 bg-[var(--rte-scrim)] hidden items-center justify-center z-[70]';
  const card = document.createElement('div');
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', '插入图片');
  card.className = 'w-[min(460px,92vw)] bg-[var(--rte-overlay-bg)] border border-[var(--rte-overlay-border)] '
    + 'rounded-[10px] shadow-[var(--rte-shadow)] flex flex-col overflow-hidden font-sans';
  const titleEl = document.createElement('div');
  titleEl.className = 'px-4 pt-4 pb-1 text-[14px] font-medium text-[var(--rte-text)]';
  titleEl.textContent = '插入图片';
  const body = document.createElement('div'); body.className = 'px-4 py-2 flex flex-col gap-2.5';

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.className = 'hidden';

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'w-full rounded-lg border-2 border-dashed border-[var(--rte-overlay-border)] bg-[var(--rte-canvas)] '
    + 'px-4 py-6 text-[13px] text-[var(--rte-muted)] cursor-pointer flex flex-col items-center gap-1.5 '
    + 'hover:border-[var(--rte-accent)] hover:text-[var(--rte-chrome-fg)] transition-colors';
  drop.innerHTML = icon('image', 26) + '<span>拖拽图片到此，或<span class="text-[var(--rte-accent)]"> 点击选择文件</span></span>';

  const urlInput = document.createElement('input');
  urlInput.type = 'text'; urlInput.placeholder = '或粘贴图片链接 https://…'; urlInput.spellcheck = false;
  urlInput.setAttribute('aria-label', '图片链接');
  urlInput.className = 'h-[34px] px-2.5 rounded-md border border-[var(--rte-overlay-border)] bg-[var(--rte-canvas)] '
    + 'text-[var(--rte-text)] text-[13px] outline-none appearance-none focus:border-[var(--rte-accent)]';

  const preview = document.createElement('div');
  preview.className = 'hidden rounded-md border border-[var(--rte-overlay-border)] bg-[var(--rte-code-bg)] p-2 items-center justify-center';
  const previewImg = document.createElement('img');
  previewImg.alt = '预览'; previewImg.className = 'max-h-[140px] max-w-full object-contain rounded';
  preview.appendChild(previewImg);

  body.append(drop, urlInput, preview, fileInput);

  const footer = document.createElement('div'); footer.className = 'px-4 py-3 flex justify-end gap-2';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button'; cancelBtn.textContent = '取消';
  cancelBtn.className = 'px-3 py-1.5 rounded-md border border-[var(--rte-overlay-border)] bg-transparent '
    + 'text-[var(--rte-chrome-fg)] text-[13px] cursor-pointer appearance-none hover:bg-[var(--rte-chrome-hover)]';
  const insertBtn = document.createElement('button');
  insertBtn.type = 'button'; insertBtn.textContent = '插入';
  insertBtn.className = 'px-3.5 py-1.5 rounded-md border-0 bg-[var(--rte-accent)] text-white text-[13px] cursor-pointer '
    + 'appearance-none hover:opacity-90 disabled:opacity-40 disabled:cursor-default';
  footer.append(cancelBtn, insertBtn);

  card.append(titleEl, body, footer);
  scrim.appendChild(card);
  document.body.appendChild(scrim);

  let resolver: ((v: string | null) => void) | null = null;
  let src = '';

  const setSrc = (s: string): void => {
    src = s;
    insertBtn.disabled = !s;
    if (s) { previewImg.src = s; preview.classList.remove('hidden'); preview.classList.add('flex'); }
    else { preview.classList.add('hidden'); preview.classList.remove('flex'); }
  };
  previewImg.onerror = (): void => { preview.classList.add('hidden'); preview.classList.remove('flex'); }; // 外链加载失败不挡插入

  const readFile = (file: File | undefined): void => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => { urlInput.value = ''; setSrc(String(reader.result)); };
    reader.readAsDataURL(file);
  };

  const close = (v: string | null): void => {
    if (!resolver) return;
    const r = resolver; resolver = null;
    scrim.classList.add('hidden'); scrim.classList.remove('flex');
    r(v);
  };

  drop.onclick = (e) => { e.preventDefault(); fileInput.click(); };
  fileInput.onchange = () => readFile(fileInput.files?.[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('border-[var(--rte-accent)]'); };
  drop.ondragleave = () => drop.classList.remove('border-[var(--rte-accent)]');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('border-[var(--rte-accent)]'); readFile(e.dataTransfer?.files?.[0]); };
  urlInput.oninput = () => setSrc(urlInput.value.trim());
  urlInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && src) { e.preventDefault(); close(src); }
    else if (e.key === 'Escape') { e.preventDefault(); close(null); }
  };
  cancelBtn.onclick = (e) => { e.preventDefault(); close(null); };
  insertBtn.onclick = (e) => { e.preventDefault(); if (src) close(src); };
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(null); });

  return {
    open(): Promise<string | null> {
      if (resolver) close(null);
      return new Promise<string | null>((resolve) => {
        resolver = resolve;
        fileInput.value = ''; urlInput.value = ''; previewImg.removeAttribute('src'); setSrc('');
        scrim.classList.remove('hidden'); scrim.classList.add('flex');
        requestAnimationFrame(() => urlInput.focus());
      });
    },
    destroy() {
      close(null); // 解决可能挂起的 open（避免悬空 Promise）
      scrim.remove();
    },
  };
}
