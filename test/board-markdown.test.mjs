// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// AMP Board — board/lib/markdown.mjs: whitelist renderer shared by server and
// browser. Memory is data (PROTOCOL.md §16): nothing in an issue body may
// become live HTML.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { escapeHtml, renderSafeMarkdown } from "../board/lib/markdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("escapeHtml neutralises every HTML-significant character", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(null), "");
});

test("raw HTML and script tags are rendered inert", () => {
  const html = renderSafeMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("javascript: and data: hrefs never become links", () => {
  const html = renderSafeMarkdown("[click](javascript:alert(1)) javascript:alert(2) data:text/html,hi");
  assert.doesNotMatch(html, /href="javascript/);
  assert.doesNotMatch(html, /href="data/);
  assert.doesNotMatch(html, /<a /);
});

test("https URLs become safe external links", () => {
  const html = renderSafeMarkdown("see https://github.com/example-org/agent-memory/issues/337 now");
  assert.match(html, /<a href="https:\/\/github\.com\/example-org\/agent-memory\/issues\/337" rel="noopener noreferrer" target="_blank">https:\/\/github\.com\/example-org\/agent-memory\/issues\/337<\/a>/);
  const tricky = renderSafeMarkdown('https://x.test/a"onmouseover="alert(1)');
  assert.doesNotMatch(tricky, /onmouseover="alert/);
  // The URL ends at "(" so the quote stays an escaped entity inside the href.
  assert.match(tricky, /href="https:\/\/x\.test\/a&quot;onmouseover=&quot;alert" rel=/);
});

test("markdown link and image syntax stays literal text (no autolinks, no images)", () => {
  const html = renderSafeMarkdown("![alt](https://x.test/i.png) and [t](https://x.test/p)");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /!\[alt\]\(<a href="https:\/\/x\.test\/i\.png"/);
});

test("block elements: headings, lists, quotes, fenced code, paragraphs", () => {
  const src = [
    "# Title",
    "## Sub",
    "### Third",
    "#### Not a heading",
    "",
    "Para with **bold** and `code <b>`.",
    "",
    "- one",
    "- two <i>",
    "",
    "> quoted **x**",
    "",
    "```js",
    "const a = '<b>';",
    "```",
    "tail",
  ].join("\n");
  const html = renderSafeMarkdown(src);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Sub<\/h2>/);
  assert.match(html, /<h3>Third<\/h3>/);
  assert.match(html, /<p>#### Not a heading<\/p>/);
  assert.match(html, /<p>Para with <strong>bold<\/strong> and <code>code &lt;b&gt;<\/code>\.<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li>two &lt;i&gt;<\/li><\/ul>/);
  assert.match(html, /<blockquote><p>quoted <strong>x<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<pre><code>const a = &#39;&lt;b&gt;&#39;;\n<\/code><\/pre>/);
  assert.match(html, /<p>tail<\/p>/);
});

test("inline code is not processed for bold or links", () => {
  const html = renderSafeMarkdown("`**not bold** https://x.test`");
  assert.equal(html, "<p><code>**not bold** https://x.test</code></p>");
});

test("checkbox bullets and metadata bullets render as list items", () => {
  const html = renderSafeMarkdown("- [x] Acknowledge only\n- **From:** codex");
  assert.match(html, /<li>\[x\] Acknowledge only<\/li>/);
  assert.match(html, /<li><strong>From:<\/strong> codex<\/li>/);
});

test("a real OKF body renders without leaking tags", () => {
  const raw = readFileSync(path.join(here, "fixtures/board/clone/okf/Sample/content-pipeline/issue-337.md"), "utf8");
  const html = renderSafeMarkdown(raw);
  assert.doesNotMatch(html, /<(script|img|iframe|style|object|embed)/i);
  assert.match(html, /<h2>Message<\/h2>/);
});

test("markdown.mjs has no Node imports so the browser can load it verbatim", () => {
  const src = readFileSync(path.join(here, "../board/lib/markdown.mjs"), "utf8");
  assert.doesNotMatch(src, /from "node:/);
  assert.doesNotMatch(src, /require\(/);
});
