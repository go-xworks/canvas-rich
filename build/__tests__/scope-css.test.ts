import { describe, it, expect } from 'vitest';
import type { Selector } from 'lightningcss';
import { scopeSelector, scopeCss, SCOPE_CLASS } from '../scope-css.ts';

// 作用域化纯逻辑单测（node 环境）：验证「给定选择器/CSS 串 → 作用域前缀后串」的各特例，
// 覆盖 :root / html[attr]（方案B）/ @media / @layer / @keyframes / @property 边界。
// 这是 dev（vite 全局 utility）测不到的作用域正确性回归（dev 不作用域化，仅 build 产 scoped CSS）。

describe('scopeSelector（AST 级）', () => {
  it('普通选择器前置 .canvas-rich 后代组合', () => {
    const sel: Selector = [{ type: 'class', name: 'flex' }];
    expect(scopeSelector(sel)).toEqual([
      { type: 'class', name: SCOPE_CLASS },
      { type: 'combinator', value: 'descendant' },
      { type: 'class', name: 'flex' },
    ]);
  });

  it(':root 映射为 .canvas-rich（无后代组合，挂作用域元素自身）', () => {
    const sel: Selector = [{ type: 'pseudo-class', kind: 'root' }];
    expect(scopeSelector(sel)).toEqual([{ type: 'class', name: SCOPE_CLASS }]);
  });

  it('html / body 类型选择器映射为 .canvas-rich', () => {
    expect(scopeSelector([{ type: 'type', name: 'html' }])).toEqual([{ type: 'class', name: SCOPE_CLASS }]);
    expect(scopeSelector([{ type: 'type', name: 'body' }])).toEqual([{ type: 'class', name: SCOPE_CLASS }]);
  });

  it('html[attr]（root-like + 属性）方案B 映射为 [attr] .canvas-rich', () => {
    // 属性组件用 lightningcss 实际 AST 形状（含 namespace/caseSensitivity）；scopeSelector 原样透传它。
    const attr: Selector[number] = {
      type: 'attribute',
      namespace: null,
      name: 'data-theme',
      operation: { operator: 'equal', value: 'dark', caseSensitivity: 'case-sensitive' },
    };
    const sel: Selector = [{ type: 'type', name: 'html' }, attr];
    expect(scopeSelector(sel)).toEqual([
      attr,
      { type: 'combinator', value: 'descendant' },
      { type: 'class', name: SCOPE_CLASS },
    ]);
  });

  it('自定义 scopeClass 生效', () => {
    const sel: Selector = [{ type: 'class', name: 'flex' }];
    const out = scopeSelector(sel, 'my-scope');
    expect(out[0]).toEqual({ type: 'class', name: 'my-scope' });
  });

  it('嵌套 & 选择器原样返回（不再前缀，避免双层 .canvas-rich）', () => {
    const sel: Selector = [{ type: 'nesting' }, { type: 'pseudo-class', kind: 'hover' }];
    // 不可变成 [.canvas-rich, ' ', &, :hover]——那样要求两层 .canvas-rich 祖先，永不命中。
    expect(scopeSelector(sel)).toEqual([{ type: 'nesting' }, { type: 'pseudo-class', kind: 'hover' }]);
  });
});

describe('scopeCss（CSS 串级）', () => {
  it(':root 与 html[data-theme] 双特例（方案B：运行时改 html 仍生效）', () => {
    const out = scopeCss(":root{--x:1}html[data-theme='dark']{--x:2}", { minify: true });
    expect(out).toContain('.canvas-rich{--x:1}');
    expect(out).toContain('[data-theme=dark] .canvas-rich{--x:2}');
    // 不应残留裸 :root / 裸 html[ 选择器
    expect(out).not.toContain(':root');
    expect(out).not.toMatch(/(^|})html\[/);
  });

  it('普通 utility 前置 .canvas-rich，不输出裸 .flex{', () => {
    const out = scopeCss('.flex{display:flex}.hidden{display:none}', { minify: true });
    expect(out).toContain('.canvas-rich .flex{');
    expect(out).toContain('.canvas-rich .hidden{');
    // 裸 .flex{（前面不是 .canvas-rich 空格）不应出现
    expect(out).not.toMatch(/[^ ]\.flex\{/);
  });

  it('@media / @layer 内部规则被前缀，at-rule 名/条件不动', () => {
    const out = scopeCss('@media (min-width:40rem){.px-2{padding:8px}}@layer utilities{.hidden{display:none}}', {
      minify: true,
    });
    expect(out).toContain('.canvas-rich .px-2{');
    expect(out).toContain('@layer utilities{');
    expect(out).toContain('.canvas-rich .hidden{');
  });

  it('@keyframes 帧选择器不被前缀（0%/to 保持原样）', () => {
    const out = scopeCss('@keyframes spin{0%{opacity:0}to{opacity:1}}', { minify: true });
    expect(out).toContain('@keyframes spin{');
    expect(out).toContain('0%{');
    expect(out).toContain('to{');
    // 帧不应被加 .canvas-rich 前缀
    expect(out).not.toContain('.canvas-rich 0%');
    expect(out).not.toContain('.canvas-rich{opacity'); // 帧不会变成作用域规则
  });

  it('@property 无选择器，原样保留不被前缀', () => {
    const out = scopeCss("@property --foo{syntax:'<color>';inherits:false;initial-value:red}", { minify: true });
    expect(out).toContain('@property --foo{');
    expect(out).not.toContain('.canvas-rich');
  });

  it('@font-face 无选择器，原样保留不被前缀（头注点名特例）', () => {
    const out = scopeCss('@font-face{font-family:x;src:url(a)}', { minify: true });
    expect(out).toContain('@font-face{');
    expect(out).not.toContain('.canvas-rich');
  });

  it('@supports 内部规则被前缀，条件不动（头注点名特例）', () => {
    const out = scopeCss('@supports (display:grid){.grid{display:grid}}', { minify: true });
    // 条件原样保留
    expect(out).toContain('@supports (display:grid){');
    // 内部样式规则正常作用域化
    expect(out).toContain('.canvas-rich .grid{');
    // 裸 .grid{（前面不是 .canvas-rich 空格）不应出现
    expect(out).not.toMatch(/[^ ]\.grid\{/);
  });

  it('复合/组合选择器逐条前缀（.a:hover,.b>.c）', () => {
    const out = scopeCss('.a:hover,.b>.c{color:red}', { minify: true });
    expect(out).toContain('.canvas-rich .a:hover');
    expect(out).toContain('.canvas-rich .b>.c');
  });

  it('minify:false 保留可读格式但仍作用域化', () => {
    const out = scopeCss('.flex{display:flex}', { minify: false });
    expect(out).toContain('.canvas-rich .flex');
  });

  it('变体嵌套块（hover/last/placeholder）外层前缀、内层 & 不双重前缀', () => {
    // tailwind v4 把 hover:/last:/placeholder: 等编成 .x{&:hover{…}} 嵌套形态。
    const out = scopeCss('.hover\\:bg{&:hover{background:red}}.last\\:b{&:last-child{border:0}}', {
      minify: true,
    });
    // 外层规则正常作用域化
    expect(out).toContain('.canvas-rich .hover\\:bg{');
    expect(out).toContain('.canvas-rich .last\\:b{');
    // 内层 & 必须保持裸 &，绝不出现 ".canvas-rich &"（双层祖先 → 运行时永不命中）
    expect(out).not.toContain('.canvas-rich &');
    expect(out).toContain('&:hover{');
    expect(out).toContain('&:last-child{');
  });
});
