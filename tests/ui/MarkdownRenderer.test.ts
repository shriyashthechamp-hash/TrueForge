import { describe, it, expect } from 'vitest';
import { renderMarkdown, escapeHtml, sanitizeUrl } from '../../src/ui/markdownRenderer.js';

describe('MarkdownRenderer — Paper Protocol Engine', () => {
  it('escapes raw HTML characters to prevent XSS injection', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
    expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
  });

  it('sanitizes unsafe link protocols', () => {
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
    expect(sanitizeUrl('http://localhost:8790')).toBe('http://localhost:8790');
    expect(sanitizeUrl('file:///path/to/file')).toBe('file:///path/to/file');
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
    expect(sanitizeUrl('data:text/html;base64,PHNjcmlwdD5...')).toBe('#');
  });

  it('renders H1, H2, H3, H4 headings with proper hierarchy classes', () => {
    const md = '# Architecture Overview\n\n## Component Hierarchy\n\n### Execution Engine';
    const html = renderMarkdown(md);
    expect(html).toContain('<h1 class="heading-h1">Architecture Overview</h1>');
    expect(html).toContain('<h2 class="heading-h2">Component Hierarchy</h2>');
    expect(html).toContain('<h3 class="heading-h3">Execution Engine</h3>');
  });

  it('renders inline formatting (bold, italic, strikethrough, inline code)', () => {
    const md = 'This is **bold**, *italic*, ~~strikethrough~~, and `inlineCode`';
    const html = renderMarkdown(md);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<del>strikethrough</del>');
    expect(html).toContain('<code class="inline-code">inlineCode</code>');
  });

  it('renders fenced code blocks with language tag and copy button', () => {
    const md = '```typescript\nconst sentinel = new SentinelAgent();\nsentinel.start();\n```';
    const html = renderMarkdown(md);
    expect(html).toContain('<div class="code-block-wrapper">');
    expect(html).toContain('<span class="code-lang-tag">TYPESCRIPT</span>');
    expect(html).toContain('<button class="copy-code-btn" type="button"');
    expect(html).toContain('const sentinel = new SentinelAgent();');
  });

  it('handles streaming incomplete code fences gracefully', () => {
    const md = '```python\ndef detect_shake():\n    return True';
    const html = renderMarkdown(md, { isStreaming: true });
    expect(html).toContain('streaming-code');
    expect(html).toContain('PYTHON • GENERATING');
    expect(html).toContain('def detect_shake():');
  });

  it('renders markdown tables into structured HTML tables', () => {
    const md = `
| File | Action | Status |
| --- | --- | --- |
| src/helpers.py | Modify | Verified |
| tests/test_cli.py | Add | Passed |
`;
    const html = renderMarkdown(md);
    expect(html).toContain('<table class="bauhaus-table">');
    expect(html).toContain('<th>File</th>');
    expect(html).toContain('<th>Action</th>');
    expect(html).toContain('<th>Status</th>');
    expect(html).toContain('<td>src/helpers.py</td>');
    expect(html).toContain('<td>Verified</td>');
  });

  it('renders blockquotes with Bauhaus accent', () => {
    const md = '> Understand first. Plan intelligently. Change precisely. Prove everything.';
    const html = renderMarkdown(md);
    expect(html).toContain('<blockquote class="bauhaus-quote">');
    expect(html).toContain('Understand first. Plan intelligently.');
  });

  it('renders unordered, ordered, nested, and task lists', () => {
    const md = `
- Item 1
  - Nested A
  - Nested B
- Item 2

1. First step
2. Second step

- [x] Completed task
- [ ] Pending verification
`;
    const html = renderMarkdown(md);
    expect(html).toContain('<ul class="bauhaus-ul">');
    expect(html).toContain('<li>Item 1</li>');
    expect(html).toContain('<ul class="bauhaus-ul-nested">');
    expect(html).toContain('<li>Nested A</li>');
    expect(html).toContain('<ol class="bauhaus-ol">');
    expect(html).toContain('<li>First step</li>');
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('checked');
  });

  it('renders horizontal rules', () => {
    const md = 'Section 1\n\n---\n\nSection 2';
    const html = renderMarkdown(md);
    expect(html).toContain('<hr class="bauhaus-divider"/>');
  });

  it('preserves Unicode and emojis accurately', () => {
    const md = '🛡️ **FORGE//SENTINEL** — ⚡ High Performance • 🚀 Real-time 漢';
    const html = renderMarkdown(md);
    expect(html).toContain('🛡️');
    expect(html).toContain('⚡');
    expect(html).toContain('🚀');
    expect(html).toContain('漢');
  });

  it('handles malformed markdown gracefully without throwing', () => {
    const malformed = '### [Unclosed link(http://bad.com\n**Unclosed bold\n```\nUnclosed code';
    expect(() => renderMarkdown(malformed)).not.toThrow();
    const html = renderMarkdown(malformed);
    expect(typeof html).toBe('string');
  });
});
