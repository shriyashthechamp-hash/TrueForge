/**
 * FORGE//SENTINEL — Paper Protocol Markdown Rendering Engine
 * 
 * Lightweight, high-performance, zero-dependency Markdown parser & sanitizer
 * specifically tailored for AI assistant streaming, code blocks with copy actions,
 * structured tables, nested lists, and Bauhaus visual design.
 */

export interface MarkdownOptions {
  isStreaming?: boolean;
}

/**
 * Escapes characters that are sensitive in HTML context.
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitizes URLs to prevent javascript: or data: XSS vectors in markdown links.
 */
export function sanitizeUrl(url: string): string {
  if (!url) return '#';
  const trimmed = url.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('file://') ||
    trimmed.startsWith('vscode://')
  ) {
    return escapeHtml(trimmed);
  }
  return '#';
}

/**
 * Renders a Markdown string into clean, secure, semantic HTML.
 */
export function renderMarkdown(rawMarkdown: string, options: MarkdownOptions = {}): string {
  if (!rawMarkdown) return '';

  const { isStreaming = false } = options;
  let text = rawMarkdown.replace(/\r\n/g, '\n');

  // Placeholders for code blocks and inline code to prevent nested parsing
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Fenced Code Blocks (```lang ... ``` or streaming unclosed ```lang ...)
  text = text.replace(/```([a-zA-Z0-9_+#.-]*)\n([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
    const isUnclosed = isStreaming && !match.endsWith('```');
    const cleanLang = (lang || 'code').trim().toLowerCase();
    const displayLang = cleanLang ? cleanLang.toUpperCase() : 'CODE';
    const escapedCode = escapeHtml(code.endsWith('\n') ? code.slice(0, -1) : code);

    const blockHtml = 
      `<div class="code-block-wrapper${isUnclosed ? ' streaming-code' : ''}">` +
        `<div class="code-block-header">` +
          `<span class="code-lang-tag">${displayLang}${isUnclosed ? ' • GENERATING' : ''}</span>` +
          `<button class="copy-code-btn" type="button" data-code="${escapeHtml(code)}">Copy</button>` +
        `</div>` +
        `<pre class="code-pre"><code class="code-content language-${cleanLang}">${escapedCode}</code></pre>` +
      `</div>`;

    codeBlocks.push(blockHtml);
    return `\n\n%%CODEBLOCK_${codeBlocks.length - 1}%%\n\n`;
  });

  // 2. Inline Code (`code`)
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const escaped = escapeHtml(code);
    inlineCodes.push(`<code class="inline-code">${escaped}</code>`);
    return `%%INLINECODE_${inlineCodes.length - 1}%%`;
  });

  // 3. Horizontal Rules
  text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="bauhaus-divider"/>');

  // 4. Tables
  text = text.replace(/(?:^|\n)((?:\|[^\n]+\|(?:\r?\n|$))+)/g, (match) => {
    const lines = match
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length < 2) return match;
    if (!/^\|[- :|]+\|$/.test(lines[1])) return match;

    const headers = lines[0]
      .split('|')
      .slice(1, -1)
      .map((h) => `<th>${parseInline(h.trim())}</th>`)
      .join('');

    const bodyRows = lines
      .slice(2)
      .map((row) => {
        const cells = row
          .split('|')
          .slice(1, -1)
          .map((c) => `<td>${parseInline(c.trim())}</td>`)
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');

    return (
      `\n\n<div class="table-container">` +
      `<table class="bauhaus-table">` +
      `<thead><tr>${headers}</tr></thead>` +
      `<tbody>${bodyRows}</tbody>` +
      `</table>` +
      `</div>\n\n`
    );
  });

  // 5. Blockquotes
  text = text.replace(/(?:^|\n)(?:>[\t ]?.*(?:\n>[\t ]?.*)*)/g, (match) => {
    const content = match
      .trim()
      .split('\n')
      .map((line) => line.replace(/^>[\t ]?/, ''))
      .join('\n');
    return `\n\n<blockquote class="bauhaus-quote">${parseInline(content)}</blockquote>\n\n`;
  });

  // 6. Split into structural blocks separated by blank lines
  const blocks = text.split(/\n{2,}/);
  const renderedBlocks: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Check placeholders or pre-rendered elements
    if (
      trimmed.startsWith('%%CODEBLOCK_') ||
      trimmed.startsWith('<div class="table-container">') ||
      trimmed.startsWith('<blockquote') ||
      trimmed.startsWith('<hr class="bauhaus-divider"/>')
    ) {
      renderedBlocks.push(trimmed);
      continue;
    }

    // Headings (# H1 to ###### H6)
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = parseInline(headingMatch[2].trim());
      renderedBlocks.push(`<h${level} class="heading-h${level}">${content}</h${level}>`);
      continue;
    }

    // Lists (Ordered, Unordered, Task lists, Nested)
    const isList = /^(?:[-*+]|\d+\.)\s+/.test(trimmed);
    if (isList) {
      renderedBlocks.push(parseListBlock(trimmed));
      continue;
    }

    // Paragraph
    const paragraphLines = trimmed.split('\n').map((l) => parseInline(l)).join('<br/>');
    renderedBlocks.push(`<p class="message-paragraph">${paragraphLines}</p>`);
  }

  let finalHtml = renderedBlocks.join('\n');

  // Restore Inline Code
  finalHtml = finalHtml.replace(/%%INLINECODE_(\d+)%%/g, (_match, idx) => {
    return inlineCodes[Number(idx)] || '';
  });

  // Restore Fenced Code Blocks
  finalHtml = finalHtml.replace(/%%CODEBLOCK_(\d+)%%/g, (_match, idx) => {
    return codeBlocks[Number(idx)] || '';
  });

  return finalHtml;
}

/**
 * Parses inline formatting: bold, italic, strikethrough, links, emojis.
 */
function parseInline(text: string): string {
  let res = text;

  // Strikethrough ~~text~~
  res = res.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Bold & Italic ***text*** or ___text___
  res = res.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  res = res.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');

  // Bold **text** or __text__
  res = res.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  res = res.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic *text* or _text_
  res = res.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  res = res.replace(/\b_([^_]+)_\b/g, '<em>$1</em>');

  // Links [text](url)
  res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    const safeUrl = sanitizeUrl(url);
    return `<a href="${safeUrl}" class="bauhaus-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  return res;
}

/**
 * Parses markdown list blocks with nesting and task list checkboxes.
 */
function parseListBlock(listText: string): string {
  const lines = listText.split('\n');
  const isOrdered = /^\s*\d+\.\s+/.test(lines[0]);
  const tag = isOrdered ? 'ol' : 'ul';
  const listClass = isOrdered ? 'bauhaus-ol' : 'bauhaus-ul';

  let html = `<${tag} class="${listClass}">`;
  let inNested = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isIndented = /^(\s{2,}|\t+)/.test(line);

    if (isIndented) {
      if (!inNested) {
        html += `<ul class="bauhaus-ul-nested">`;
        inNested = true;
      }
      const itemContent = line.replace(/^\s*[-*+]?\s*/, '').replace(/^\s*\d+\.\s*/, '');
      html += `<li>${parseListItemContent(itemContent)}</li>`;
    } else {
      if (inNested) {
        html += `</ul>`;
        inNested = false;
      }
      const itemContent = line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+\.\s+/, '');
      html += `<li>${parseListItemContent(itemContent)}</li>`;
    }
  }

  if (inNested) {
    html += `</ul>`;
  }

  html += `</${tag}>`;
  return html;
}

function parseListItemContent(content: string): string {
  // Check for task lists [ ] or [x]
  const taskMatch = content.match(/^\[([ xX])\]\s+(.*)$/);
  if (taskMatch) {
    const isChecked = taskMatch[1].toLowerCase() === 'x';
    return (
      `<label class="task-list-item">` +
      `<input type="checkbox" disabled ${isChecked ? 'checked' : ''} class="task-checkbox"/> ` +
      `<span>${parseInline(taskMatch[2])}</span>` +
      `</label>`
    );
  }
  return parseInline(content);
}
