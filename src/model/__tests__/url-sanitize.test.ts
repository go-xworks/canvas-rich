import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, para, text, block } from '../schema';

// 集群2 安全回归：模型层写 attrs.src 的统一入口（insert* / updateAtomAttrs）
// 必须经协议白名单过滤——非法 URL 降级为空串（操作本身仍成立，不渲染危险源）。
// 第二道防线在 ui/overlays 写 DOM 前（见 shared/__tests__/url.test.ts 的白名单细则）。

const docOf = (...blocks: Doc['blocks']): Doc => ({ blocks });
const XSS = 'javascript:alert(1)';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('insert*：src 经白名单过滤', () => {
  it('合法 https URL 原样写入（image/audio/video/iframe/attachment/signature）', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertImage('https://e.com/a.png');
    rd.insertAudio('https://e.com/a.mp3');
    rd.insertVideo('https://e.com/v.mp4');
    rd.insertIframe('https://e.com');
    rd.insertAttachment('https://e.com/f.pdf', 'f.pdf');
    rd.insertSignature(PNG); // data:image 对 signature 合法
    const srcs = rd.doc.blocks.slice(1).map((b) => b.attrs.src);
    expect(srcs).toEqual([
      'https://e.com/a.png',
      'https://e.com/a.mp3',
      'https://e.com/v.mp4',
      'https://e.com',
      'https://e.com/f.pdf',
      PNG,
    ]);
  });

  it('javascript: 一律降级为空串（块仍插入，结构不变）', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertImage(XSS);
    rd.insertAudio(XSS);
    rd.insertVideo(XSS);
    rd.insertIframe(XSS);
    rd.insertAttachment(XSS, 'f.pdf');
    rd.insertSignature(XSS);
    expect(rd.doc.blocks).toHaveLength(7);
    for (const b of rd.doc.blocks.slice(1)) expect(b.attrs.src).toBe('');
  });

  it('iframe 拒绝 data:（仅 http/https）；image 拒绝非 image 的 data:', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertIframe('data:text/html,<script>x</script>');
    rd.insertImage('data:text/html,<script>x</script>');
    expect(rd.doc.blocks[1].attrs.src).toBe('');
    expect(rd.doc.blocks[2].attrs.src).toBe('');
  });
});

describe('updateAtomAttrs：partial.src 按块类型过滤', () => {
  it('iframe 双击再编辑写入 javascript: → 降级空串，其余字段照常合并', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertIframe('https://old.com');
    rd.updateAtomAttrs(1, { src: XSS, width: 320 });
    expect(rd.doc.blocks[1].attrs.src).toBe('');
    expect(rd.doc.blocks[1].attrs.width).toBe(320);
  });

  it('合法 src 正常更新；undo 还原旧值', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertVideo('https://a/old.mp4');
    rd.updateAtomAttrs(1, { src: 'https://a/new.mp4' });
    expect(rd.doc.blocks[1].attrs.src).toBe('https://a/new.mp4');
    rd.undo();
    expect(rd.doc.blocks[1].attrs.src).toBe('https://a/old.mp4');
  });

  it('不带 src 的 partial（如公式 latex / 印章 text）不受过滤影响', () => {
    const rd = new RichDoc(docOf(para([text('x')]), block('formula', [text('')], { latex: 'a' })));
    rd.updateAtomAttrs(1, { latex: 'E=mc^2' });
    expect(rd.doc.blocks[1].attrs.latex).toBe('E=mc^2');
  });

  it('非媒体类原子块（formula）误传 src 时原样合并（其覆盖层不渲染 src，不在白名单管辖）', () => {
    const rd = new RichDoc(docOf(para([text('x')]), block('formula', [text('')], { latex: 'a' })));
    rd.updateAtomAttrs(1, { src: 'whatever' });
    expect(rd.doc.blocks[1].attrs.src).toBe('whatever');
  });
});
