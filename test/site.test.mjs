// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
//
// The published site in docs/ is built from site/ by scripts/build-site.mjs,
// one URL per language. These tests fail when someone edits docs/ by hand or
// forgets `npm run site:build`, and they pin the promises the per-language
// split exists for: one language per page, reciprocal hreflang, and relative
// links that land on a file that exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { buildSite, keepLanguage, relink, LANGS, PAGES, pageUrl, outFile } from "../scripts/build-site.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(repoRoot, "docs");
const hasSite = existsSync(join(repoRoot, "site", "index.html"));
const built = hasSite ? buildSite() : new Map();
const pagesOnly = [...built].filter(([rel]) => rel.endsWith(".html"));

test("docs/ matches a fresh build of site/", { skip: !hasSite && "no site/ in this checkout" }, () => {
  const stale = [];
  for (const [rel, content] of built) {
    const file = join(docs, rel);
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) stale.push(rel);
  }
  assert.deepEqual(stale, [], "run npm run site:build and commit docs/");
});

test("each built page carries only its own language", { skip: !hasSite }, () => {
  for (const page of PAGES) {
    for (const lang of page.langs) {
      const html = built.get(outFile(page, lang));
      const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
      const foreign = [...markup.matchAll(/<[a-z][\w-]*\b[^>]*\sclass="(?:[^"]*\s)?t(?:\s[^"]*)?"[^>]*>/gi)]
        .map((m) => m[0].match(/\slang="([^"]*)"/))
        .filter((m) => m && m[1] !== lang);
      assert.equal(foreign.length, 0, `${outFile(page, lang)} still has ${foreign.length} other-language .t elements`);
      assert.match(html, new RegExp(`<html lang="${lang}">`));
      assert.match(html, new RegExp(`<body data-lang="${lang}"`));
      assert.ok(!html.includes('id="page-i18n"'), "the i18n block is build input, not output");
    }
  }
});

test("hreflang alternates are reciprocal, with English as x-default", { skip: !hasSite }, () => {
  for (const page of PAGES.filter((p) => !p.noindex)) {
    for (const lang of page.langs) {
      const html = built.get(outFile(page, lang));
      assert.match(html, new RegExp(`<link rel="canonical" href="${pageUrl(page, lang)}">`));
      const alts = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => `${m[1]} ${m[2]}`);
      if (page.langs.length < 2) {
        assert.deepEqual(alts, []);
        continue;
      }
      const want = page.langs.map((l) => `${l} ${pageUrl(page, l)}`).concat(`x-default ${pageUrl(page, "en")}`);
      assert.deepEqual(alts, want, outFile(page, lang));
    }
  }
});

test("every relative link and asset in a built page resolves to a file", { skip: !hasSite }, () => {
  const missing = [];
  for (const [rel, html] of pagesOnly) {
    if (rel === "404.html") continue; // served at any depth, so it links root-relative only
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.slice(0, m.indexOf(">") + 1));
    const urls = [...markup.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1])
      .concat([...markup.matchAll(/\s(?:srcset|imagesrcset)="([^"]*)"/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+/)[0])));
    for (const url of urls) {
      if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) continue;
      let target = normalize(join(dirname(rel), url.replace(/[?#].*$/, "")));
      if (url.replace(/[?#].*$/, "").endsWith("/") || target === ".") target = join(target, "index.html");
      if (!built.has(target) && !existsSync(join(docs, target))) missing.push(`${rel} → ${url}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the sitemap lists every indexable language version with its alternates", { skip: !hasSite }, () => {
  const xml = built.get("sitemap.xml");
  for (const page of PAGES) {
    for (const lang of page.langs) {
      const listed = xml.includes(`<loc>${pageUrl(page, lang)}</loc>`);
      assert.equal(listed, !page.noindex, pageUrl(page, lang));
    }
  }
  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
});

test("keepLanguage drops nested other-language elements whole, and their line", () => {
  const src = [
    "<p>",
    '  <span class="t" lang="en">Hi <span class="x">there</span></span>',
    '  <span class="t" lang="ja">こんにちは <span class="x">!</span></span>',
    '</p><b class="note t" lang="ja">x</b><b class="t" lang="en">y</b>',
  ].join("\n");
  assert.equal(keepLanguage(src, "en"), [
    "<p>",
    '  <span class="t" lang="en">Hi <span class="x">there</span></span>',
    '</p><b class="t" lang="en">y</b>',
  ].join("\n"));
});

test("relink sends a page link to the same language when it exists, else English", () => {
  assert.equal(relink("benchmark.html", "en"), "benchmark.html");
  assert.equal(relink("benchmark.html", "zh-Hant"), "benchmark.html");
  assert.equal(relink("benchmark.html#run", "ja"), "../benchmark.html#run");
  assert.equal(relink("index.html", "zh-Hant"), "./");
  assert.equal(relink("index.html", "en"), "./");
  assert.equal(relink("assets/x.webp", "ko"), "../assets/x.webp");
  assert.equal(relink("https://github.com/RxAi-Aus/amp", "ko"), "https://github.com/RxAi-Aus/amp");
  assert.equal(relink("#top", "es"), "#top");
  assert.equal(Object.keys(LANGS)[0], "en");
});
