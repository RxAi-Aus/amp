// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * markdown.mjs — tiny whitelist Markdown renderer for AMP Board.
 *
 * The browser imports this module; the server only serves the file, at
 * /lib/markdown.mjs. Nothing server-side calls it. It must still stay
 * dependency-free and DOM-free so the one copy can run in either place.
 *
 * Security stance (PROTOCOL.md §16 — memory is data, never instructions):
 * every character is HTML-escaped first, then a small set of constructs is
 * re-introduced: # / ## / ### headings, **bold**, `code`, fenced code,
 * "- " lists, "> " quotes, "---" rules, and bare https?:// links with
 * rel="noopener noreferrer". No raw HTML, no images, no [text](url) links,
 * no javascript:/data: schemes can ever reach the DOM.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Runs on already-escaped text: `<` has become `&lt;`, so stopping at `<`
// only ever stops at a tag we emitted ourselves.
const URL_RE = /https?:\/\/[^\s<>()]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

function linkify(escaped) {
  return escaped.replace(URL_RE, (url) => {
    const trail = (url.match(TRAILING_PUNCT_RE) || [""])[0];
    const clean = trail ? url.slice(0, -trail.length) : url;
    return `<a href="${clean}" rel="noopener noreferrer" target="_blank">${clean}</a>${trail}`;
  });
}

function inlineText(escaped) {
  return linkify(escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
}

/** Inline pass: escape, protect code spans, then bold + links outside them. */
export function renderInline(raw) {
  const escaped = escapeHtml(raw);
  const parts = escaped.split("`");
  // Odd indexes are inside backticks when the count is balanced.
  if (parts.length % 2 === 0) return inlineText(escaped);
  return parts
    .map((part, i) => (i % 2 === 1 ? `<code>${part}</code>` : inlineText(part)))
    .join("");
}

const HEADING_RE = /^(#{1,3}) (.+?)\s*$/;
const LIST_RE = /^\s*[-*] (.*)$/;
const QUOTE_RE = /^> ?(.*)$/;
const FENCE_RE = /^```/;
const RULE_RE = /^-{3,}\s*$/;

export function renderSafeMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = [];
  let quote = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(renderInline).join("\n")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${renderSafeMarkdown(quote.join("\n"))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (FENCE_RE.test(line)) {
      flushAll();
      const code = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) code.push(lines[i++]);
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}\n</code></pre>`);
      continue;
    }
    if ((m = line.match(HEADING_RE))) {
      flushAll();
      const level = m[1].length;
      out.push(`<h${level}>${renderInline(m[2])}</h${level}>`);
      continue;
    }
    if (RULE_RE.test(line)) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    if ((m = line.match(QUOTE_RE))) {
      flushPara();
      flushList();
      quote.push(m[1]);
      continue;
    }
    if ((m = line.match(LIST_RE))) {
      flushPara();
      flushQuote();
      list.push(m[1]);
      continue;
    }
    if (line.trim() === "") {
      flushAll();
      continue;
    }
    flushList();
    flushQuote();
    para.push(line);
  }
  flushAll();
  return out.join("");
}
