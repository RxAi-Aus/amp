#!/usr/bin/env node
/**
 * build-site.mjs: writes the published site in docs/ (amp.rxai.com.au) from
 * the sources in site/.
 *
 * A source page carries every language it is translated into, each string as
 * a `.t` element with a `lang` attribute. The site serves one URL per language
 * (/, /zh-hant/, /ja/, /ko/, /es/) so a search engine can index each language
 * and a text extractor reads one language instead of five run together. For
 * each language a page has, the build:
 *   - drops every `.t` element in another language
 *   - sets <html lang>, <body data-lang>, the title, description and Open Graph
 *     text from the page's `page-i18n` JSON block, then removes the block
 *   - points canonical and og:url at the page's own URL and lists every
 *     language version as a reciprocal hreflang alternate, English as x-default
 *   - localises the JSON-LD page node (url, @id, inLanguage, name) and the
 *     breadcrumbs
 *   - writes the language links at <!-- build:langs -->, plus a script that
 *     remembers the choice; the English page, which is also the x-default,
 *     sends a visitor who chose another language (or whose browser asks for
 *     one the page has) to that version
 *   - rewrites relative links for the page's folder: a link to another page
 *     goes to that page in the same language when it exists, else to English
 *   - adds a speculation-rules prefetch, so moving between pages starts warm
 * and writes sitemap.xml with the alternates.
 *
 * docs/*.html and docs/sitemap.xml are output: edit site/, then run
 * `npm run site:build`. test/site.test.mjs fails when they disagree.
 * CNAME, robots.txt, llms.txt and assets/ in docs/ are hand-maintained.
 *
 * Zero dependencies. `--check` compares instead of writing (exit 1 on drift).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SITE_DIR = join(ROOT, "site");
export const OUT_DIR = join(ROOT, "docs");
export const ORIGIN = "https://amp.rxai.com.au";

export const LANGS = {
  en: { dir: "", label: "EN", locale: "en_AU" },
  "zh-Hant": { dir: "zh-hant/", label: "繁中", locale: "zh_TW" },
  ja: { dir: "ja/", label: "日本語", locale: "ja_JP" },
  ko: { dir: "ko/", label: "한국어", locale: "ko_KR" },
  es: { dir: "es/", label: "Español", locale: "es_ES" },
};

// `path` is the page's URL path under a language folder ("" is the folder's
// index). `modified` feeds the sitemap's <lastmod>.
export const PAGES = [
  { src: "index.html", path: "", langs: ["en", "zh-Hant", "ja", "ko", "es"], modified: "2026-09-24" },
  { src: "benchmark.html", path: "benchmark.html", langs: ["en", "zh-Hant"], modified: "2026-09-24" },
  { src: "quickstart.html", path: "quickstart.html", langs: ["en", "zh-Hant"], modified: "2026-09-24" },
  { src: "compare.html", path: "compare.html", langs: ["en", "zh-Hant"], modified: "2026-09-24" },
  { src: "404.html", path: "404.html", langs: ["en"], noindex: true },
];

export const pageUrl = (page, lang) => `${ORIGIN}/${LANGS[lang].dir}${page.path}`;
export const outFile = (page, lang) => `${LANGS[lang].dir}${page.path || "index.html"}`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function replaceOnce(html, re, fn, what) {
  const hits = html.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (!hits || hits.length !== 1) throw new Error(`${what}: expected one match, found ${hits ? hits.length : 0}`);
  return html.replace(re, fn);
}

// ---- markup vs code ----------------------------------------------------
// Edits must never reach into <script>/<style> bodies (a script may build
// `.t` spans in a string), but a script's own src attribute is markup.
function mapMarkup(html, fn) {
  const re = /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi;
  let out = "";
  let i = 0;
  let m;
  while ((m = re.exec(html))) {
    out += fn(html.slice(i, m.index)) + fn(m[1]) + m[3] + m[4];
    i = re.lastIndex;
  }
  return out + fn(html.slice(i));
}

// ---- one language per page --------------------------------------------
const attrOf = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};

function closeOf(markup, name, from) {
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(markup))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return re.lastIndex;
  }
  throw new Error(`unclosed <${name}> at offset ${from}`);
}

export function keepLanguage(markup, lang) {
  const open = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let out = "";
  let i = 0;
  let m;
  while ((m = open.exec(markup))) {
    const [tag, name, attrs] = m;
    const cls = attrOf(attrs, "class");
    const l = attrOf(attrs, "lang");
    if (cls === null || !cls.split(/\s+/).includes("t") || l === null || l === lang) continue;
    let a = m.index;
    let b = closeOf(markup, name, m.index + tag.length);
    // An element that sat on its own line takes the line with it.
    const lineStart = markup.lastIndexOf("\n", a - 1) + 1;
    const nl = markup.indexOf("\n", b);
    if (nl !== -1 && /^[ \t]*$/.test(markup.slice(lineStart, a)) && /^[ \t]*$/.test(markup.slice(b, nl))) {
      a = lineStart;
      b = nl + 1;
    }
    out += markup.slice(i, a);
    i = b;
    open.lastIndex = b;
  }
  return out + markup.slice(i);
}

// ---- links --------------------------------------------------------------
// Relative path from the folder of a page in `fromLang` to a root path.
function relFrom(fromLang, rootPath) {
  const dir = LANGS[fromLang].dir;
  if (!dir) return rootPath || "./";
  if (rootPath.startsWith(dir)) return rootPath.slice(dir.length) || "./";
  return "../" + rootPath;
}

function pageFor(path) {
  if (path === "" || path === "./" || path === "index.html") return PAGES.find((p) => p.path === "");
  return PAGES.find((p) => p.path === path && p.path !== "");
}

export function relink(url, lang) {
  if (url === "" || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return url;
  const [, path, rest] = url.match(/^([^?#]*)(.*)$/);
  const target = pageFor(path);
  if (target) {
    const tl = target.langs.includes(lang) ? lang : "en";
    return relFrom(lang, LANGS[tl].dir + target.path) + rest;
  }
  return (LANGS[lang].dir ? "../" : "") + url;
}

function relinkAttrs(markup, lang) {
  return markup
    .replace(/(\s(?:href|src))="([^"]*)"/g, (_, a, v) => `${a}="${relink(v, lang)}"`)
    .replace(/(\s(?:srcset|imagesrcset))="([^"]*)"/g, (_, a, v) =>
      `${a}="${v.split(",").map((s) => {
        const parts = s.trim().split(/\s+/);
        parts[0] = relink(parts[0], lang);
        return parts.join(" ");
      }).join(", ")}"`);
}

// ---- head ---------------------------------------------------------------
function readI18n(html, src) {
  const m = html.match(/[ \t]*<script type="application\/json" id="page-i18n">([\s\S]*?)<\/script>\n?/);
  if (!m) throw new Error(`${src}: no page-i18n block`);
  return { html: html.replace(m[0], ""), i18n: JSON.parse(m[1]) };
}

function langSwitchScripts(page) {
  const alt = {};
  for (const l of page.langs) if (l !== "en") alt[l] = LANGS[l].dir + page.path;
  const redirect = `<script>
  // English is also the x-default. A visitor who chose another language before,
  // or whose browser asks for one this page has, goes to that version; a
  // visitor on a language URL stays where the link sent them.
  (function () {
    var alt = ${JSON.stringify(alt)};
    var l = null;
    try { l = localStorage.getItem("amp-lang"); } catch (e) {}
    if (!l) { var n = (navigator.language || "").toLowerCase(); l = n.indexOf("zh") === 0 ? "zh-Hant" : n.slice(0, 2); }
    if (alt[l]) location.replace(alt[l] + location.search + location.hash);
  })();
</script>`;
  const remember = `<script>
  // Remember a language picked here, so the English page can send a returning
  // visitor straight to it.
  (function () {
    function keep(e) {
      var a = e.target.closest(".langbar a[hreflang]");
      if (a) try { localStorage.setItem("amp-lang", a.getAttribute("hreflang")); } catch (err) {}
    }
    document.addEventListener("click", keep);
    document.addEventListener("auxclick", keep);
  })();
</script>`;
  return { redirect, remember };
}

function localiseHead(html, page, lang, i18n) {
  const t = i18n[lang] || {};
  const url = pageUrl(page, lang);
  html = replaceOnce(html, /<html lang="[^"]*">/, `<html lang="${lang}">`, "html lang");
  html = replaceOnce(html, /<body data-lang="[^"]*"/, `<body data-lang="${lang}"`, "body data-lang");
  if (t.title) {
    html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${esc(t.title)}</title>`, "title");
    html = replaceOnce(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(t.ogTitle || t.title)}">`, "og:title");
  }
  if (t.description) {
    html = replaceOnce(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(t.description)}">`, "description");
  }
  if (t.ogDescription) {
    html = replaceOnce(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(t.ogDescription)}">`, "og:description");
  }
  if (page.noindex) return html;

  html = replaceOnce(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`, "og:url");
  const locales = [`<meta property="og:locale" content="${LANGS[lang].locale}">`]
    .concat(page.langs.filter((l) => l !== lang).map((l) => `<meta property="og:locale:alternate" content="${LANGS[l].locale}">`));
  html = replaceOnce(html, /(<meta property="og:type" content="[^"]*">\n)/, (m) => m + locales.join("\n") + "\n", "og:type");
  const alternates = page.langs.length < 2 ? [] : page.langs
    .map((l) => `<link rel="alternate" hreflang="${l}" href="${pageUrl(page, l)}">`)
    .concat(`<link rel="alternate" hreflang="x-default" href="${pageUrl(page, "en")}">`);
  html = replaceOnce(html, /<link rel="canonical" href="[^"]*">\n/,
    [`<link rel="canonical" href="${url}">`, ...alternates].join("\n") + "\n", "canonical");
  return html;
}

function localiseLd(html, page, lang, i18n) {
  const t = (i18n[lang] || {}).ld || {};
  const enUrl = pageUrl(page, "en");
  const url = pageUrl(page, lang);
  const swap = (v) => (typeof v === "string" && v.startsWith(enUrl) && (v.length === enUrl.length || v[enUrl.length] === "#")
    ? url + v.slice(enUrl.length) : v);
  return html.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/, (all, a, body, c) => {
    const data = JSON.parse(body);
    for (const node of data["@graph"] || [data]) {
      if (["WebPage", "TechArticle", "Article", "CollectionPage", "HowTo"].includes(node["@type"])) {
        for (const k of ["@id", "url", "mainEntityOfPage"]) if (k in node) node[k] = swap(node[k]);
        if ("inLanguage" in node) node.inLanguage = lang;
        for (const k of ["name", "headline", "description"]) if (t[k] && k in node) node[k] = t[k];
      }
      if (node["@type"] === "BreadcrumbList") {
        node.itemListElement.forEach((item, i) => {
          const target = PAGES.find((p) => pageUrl(p, "en") === item.item);
          if (target && target.langs.includes(lang)) item.item = pageUrl(target, lang);
          if (t.crumbs && t.crumbs[i]) item.name = t.crumbs[i];
        });
      }
    }
    return `${a}\n${JSON.stringify(data, null, 2)}\n${c}`;
  });
}

// ---- one page, one language ------------------------------------------------
export function renderPage(source, page, lang) {
  const { html: withoutI18n, i18n } = readI18n(source, page.src);
  let html = mapMarkup(withoutI18n, (s) => relinkAttrs(keepLanguage(s, lang), lang));
  html = localiseHead(html, page, lang, i18n);
  html = localiseLd(html, page, lang, i18n);

  if (html.includes("<!-- build:langs -->")) {
    const links = page.langs.length < 2 ? [] : page.langs.map((l) =>
      `<a class="lang" href="${relFrom(lang, LANGS[l].dir + page.path)}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="page"' : ""}>${LANGS[l].label}</a>`);
    html = html.replace(/([ \t]*)<!-- build:langs -->\n?/, (m, indent) => links.map((x) => indent + x + "\n").join(""));
  }
  if (page.langs.length > 1) {
    const { redirect, remember } = langSwitchScripts(page);
    if (lang === "en") html = replaceOnce(html, /(<meta name="viewport"[^>]*>\n)/, (m) => m + redirect + "\n", "viewport");
    html = replaceOnce(html, /\n<\/body>/, `\n${remember}\n</body>`, "</body>");
  }
  if (!page.noindex) {
    html = replaceOnce(html, /\n<\/body>/,
      `\n<script type="speculationrules">\n{"prefetch": [{"where": {"href_matches": "/*"}, "eagerness": "moderate"}]}\n</script>\n</body>`, "</body>");
  }
  return html;
}

export function sitemap() {
  const rows = [];
  for (const page of PAGES) {
    if (page.noindex) continue;
    for (const lang of page.langs) {
      const alts = page.langs.length < 2 ? [] : page.langs
        .map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${pageUrl(page, l)}"/>`)
        .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${pageUrl(page, "en")}"/>`);
      rows.push(["  <url>", `    <loc>${pageUrl(page, lang)}</loc>`, `    <lastmod>${page.modified}</lastmod>`, ...alts, "  </url>"].join("\n"));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${rows.join("\n")}
</urlset>
`;
}

/** Every output file, as a Map of docs-relative path → content. */
export function buildSite(siteDir = SITE_DIR) {
  const out = new Map();
  for (const page of PAGES) {
    const source = readFileSync(join(siteDir, page.src), "utf8");
    for (const lang of page.langs) out.set(outFile(page, lang), renderPage(source, page, lang));
  }
  out.set("sitemap.xml", sitemap());
  return out;
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const check = process.argv.includes("--check");
  const files = buildSite();
  const drift = [];
  for (const [rel, content] of files) {
    const target = join(OUT_DIR, rel);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === content) continue;
    drift.push(rel);
    if (!check) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  if (check) {
    if (drift.length) {
      console.error(`docs/ is out of date with site/ (run npm run site:build): ${drift.join(", ")}`);
      process.exit(1);
    }
    console.log(`docs/ matches site/ (${files.size} files).`);
  } else {
    console.log(drift.length ? `wrote ${drift.join(", ")}` : `docs/ already up to date (${files.size} files).`);
  }
}
