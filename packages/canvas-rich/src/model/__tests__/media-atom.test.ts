import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, para, text } from '../schema';
import { isAtom } from '../block-specs';
import { toHtml, toMarkdown } from '../export';

// 集群A：媒体对象原子块（音频 / 视频 / 内嵌网页(iframe) / 附件）的插入与导出映射。

const docOf = (...blocks: Doc['blocks']): Doc => ({ blocks });

describe('RichDoc.insertAudio', () => {
  it('在光标块后插入 audio 原子块，带 src + 稳定 id，光标落其上', () => {
    const rd = new RichDoc(docOf(para([text('p0')]), para([text('p1')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertAudio('https://x/a.mp3');
    expect(rd.doc.blocks).toHaveLength(3);
    const a = rd.doc.blocks[1];
    expect(a.type).toBe('audio');
    expect(isAtom(a.type)).toBe(true);
    expect(a.attrs.src).toBe('https://x/a.mp3');
    expect(typeof a.attrs.id).toBe('string'); // 覆盖层缓存键
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
  });

  it('插入进撤销栈，undo 移除音频', () => {
    const rd = new RichDoc(docOf(para([text('a')])));
    rd.insertAudio('u');
    expect(rd.doc.blocks).toHaveLength(2);
    rd.undo();
    expect(rd.doc.blocks).toHaveLength(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
  });
});

describe('RichDoc.insertVideo', () => {
  it('插入 video 原子块，带 src + 默认宽高（可缩放）+ 稳定 id', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertVideo('https://x/v.mp4');
    const v = rd.doc.blocks[1];
    expect(v.type).toBe('video');
    expect(isAtom(v.type)).toBe(true);
    expect(v.attrs.src).toBe('https://x/v.mp4');
    expect(typeof v.attrs.width).toBe('number');
    expect(typeof v.attrs.height).toBe('number');
    expect(typeof v.attrs.id).toBe('string');
  });
});

describe('RichDoc.insertIframe', () => {
  it('插入 iframe 原子块，带 src + 默认宽高 + 稳定 id', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertIframe('https://example.com');
    const f = rd.doc.blocks[1];
    expect(f.type).toBe('iframe');
    expect(isAtom(f.type)).toBe(true);
    expect(f.attrs.src).toBe('https://example.com');
    expect(typeof f.attrs.width).toBe('number');
    expect(typeof f.attrs.height).toBe('number');
    expect(typeof f.attrs.id).toBe('string');
  });
});

describe('RichDoc.insertAttachment', () => {
  it('插入 attachment 原子块，带 src + 文件名 + 稳定 id', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertAttachment('https://x/file.pdf', 'file.pdf');
    const at = rd.doc.blocks[1];
    expect(at.type).toBe('attachment');
    expect(isAtom(at.type)).toBe(true);
    expect(at.attrs.src).toBe('https://x/file.pdf');
    expect(at.attrs.name).toBe('file.pdf');
    expect(typeof at.attrs.id).toBe('string');
  });

  it('省略文件名时 attrs.name 不写入（undefined）', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertAttachment('https://x/file.bin');
    const at = rd.doc.blocks[1];
    expect(at.attrs.src).toBe('https://x/file.bin');
    expect(at.attrs.name).toBeUndefined();
  });
});

describe('export: 媒体原子块 → HTML', () => {
  it('audio → <audio controls src>', () => {
    const html = toHtml(docOf(para([text('')]), { type: 'audio', attrs: { src: 'a.mp3' }, inlines: [text('')] }));
    expect(html).toContain('<audio controls src="a.mp3"></audio>');
  });

  it('video → <video controls src + width/height>', () => {
    const html = toHtml(
      docOf({ type: 'video', attrs: { src: 'v.mp4', width: 480, height: 270 }, inlines: [text('')] }),
    );
    expect(html).toContain('<video controls src="v.mp4" width="480" height="270"></video>');
  });

  it('iframe → <iframe src sandbox + width/height>（sandbox 不含 allow-same-origin，防同源逃逸组合）', () => {
    const html = toHtml(
      docOf({ type: 'iframe', attrs: { src: 'https://e.com', width: 480, height: 270 }, inlines: [text('')] }),
    );
    expect(html).toContain(
      '<iframe src="https://e.com" width="480" height="270" sandbox="allow-scripts allow-popups"></iframe>',
    );
    expect(html).not.toContain('allow-same-origin');
  });

  it('attachment → <a href download> 带文件名', () => {
    const html = toHtml(docOf({ type: 'attachment', attrs: { src: 'f.pdf', name: '报告.pdf' }, inlines: [text('')] }));
    expect(html).toContain('<a href="f.pdf" download="报告.pdf">报告.pdf</a>');
  });

  it('attachment 无文件名时回退用 src 作为文件名与链接文本', () => {
    const html = toHtml(docOf({ type: 'attachment', attrs: { src: 'data.bin' }, inlines: [text('')] }));
    expect(html).toContain('<a href="data.bin" download="data.bin">data.bin</a>');
  });

  it('属性中的引号/尖括号被转义（防注入）', () => {
    const html = toHtml(docOf({ type: 'iframe', attrs: { src: 'a"><script>' }, inlines: [text('')] }));
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('export: 媒体原子块 → Markdown（兜底为链接）', () => {
  it('audio/video/iframe 兜底为带类型标签的链接', () => {
    const md = toMarkdown(
      docOf(
        { type: 'audio', attrs: { src: 'a.mp3' }, inlines: [text('')] },
        { type: 'video', attrs: { src: 'v.mp4' }, inlines: [text('')] },
        { type: 'iframe', attrs: { src: 'https://e.com' }, inlines: [text('')] },
      ),
    );
    expect(md).toContain('[音频](a.mp3)');
    expect(md).toContain('[视频](v.mp4)');
    expect(md).toContain('[内嵌网页](https://e.com)');
  });

  it('attachment 兜底为链接（文本取文件名，缺省回退 src）', () => {
    const md = toMarkdown(
      docOf(
        { type: 'attachment', attrs: { src: 'f.pdf', name: '报告.pdf' }, inlines: [text('')] },
        { type: 'attachment', attrs: { src: 'data.bin' }, inlines: [text('')] },
      ),
    );
    expect(md).toContain('[报告.pdf](f.pdf)');
    expect(md).toContain('[data.bin](data.bin)');
  });
});
