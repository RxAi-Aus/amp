/* amp-analytics.js — cookie consent (Google Consent Mode v2) and event tracking
 * for amp.rxai.com.au. Loaded with `defer` on every page after the page's own
 * script has applied the language, so `body[data-lang]` is already set.
 *
 * Consent: the head sets every consent type to "denied" before gtag.js loads
 * and restores a stored "granted" choice synchronously. This file shows the
 * banner when no choice is stored, and updates consent on Accept. Until then
 * GA4 runs cookieless (consent-mode pings, modelled reports); after Accept it
 * sets its cookies. The choice lives in localStorage under "amp-consent" — a
 * strictly necessary preference, so it needs no consent itself.
 *
 * Events (all sent through gtag, so they respect consent state):
 *   github_click | protocol_click | readme_click | benchmark_click | home_click
 *   | outbound_click            — what people leave the page for
 *   command_copy                — an install command was copied (the real
 *                                 "conversion" of a developer landing page)
 *   language_switch             — a language button was used
 *   section_view                — a section heading scrolled into view, once
 *   consent_update              — accept / essential-only
 * User property: site_language. Nothing here identifies a person.
 */
(function () {
  "use strict";
  var KEY = "amp-consent";
  var LANGS = ["en", "zh-Hant", "ja", "ko", "es"];
  var TEXT = {
    en: { msg: "We use Google Analytics to see which pages and links help. Cookies are set only if you accept.", accept: "Accept", decline: "Essential only", more: "How Google uses this data", settings: "Cookie settings" },
    "zh-Hant": { msg: "我們用 Google Analytics 了解哪些頁面和連結有幫助；只有在你接受後才會設定 Cookie。", accept: "接受", decline: "只用必要的", more: "Google 如何使用這些資料", settings: "Cookie 設定" },
    ja: { msg: "どのページやリンクが役立っているかを知るために Google Analytics を使っています。Cookie は同意された場合にのみ設定されます。", accept: "同意する", decline: "必要なもののみ", more: "Google のデータ利用について", settings: "Cookie 設定" },
    ko: { msg: "어떤 페이지와 링크가 도움이 되는지 알기 위해 Google Analytics를 사용합니다. 쿠키는 동의한 경우에만 설정됩니다.", accept: "동의", decline: "필수만", more: "Google의 데이터 사용 방식", settings: "쿠키 설정" },
    es: { msg: "Usamos Google Analytics para saber qué páginas y enlaces ayudan. Solo se instalan cookies si aceptas.", accept: "Aceptar", decline: "Solo esenciales", more: "Cómo usa Google estos datos", settings: "Ajustes de cookies" }
  };
  var MORE_URL = "https://policies.google.com/technologies/partner-sites";

  function gtagSafe() {
    if (typeof window.gtag === "function") window.gtag.apply(null, arguments);
  }
  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function store(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* private mode: banner shows again next visit */ }
  }
  function currentLang() {
    var l = document.body.getAttribute("data-lang") || document.documentElement.getAttribute("lang") || "en";
    return LANGS.indexOf(l) === -1 ? "en" : l;
  }
  // Only the languages this page actually carries get a span; the page's own
  // CSS (.t hidden unless body[data-lang] matches) then shows the right one.
  function pageLangs() {
    var out = [];
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i] === "en" || document.querySelector('.t[lang="' + LANGS[i] + '"]')) out.push(LANGS[i]);
    }
    return out;
  }
  function spans(field, tag) {
    var langs = pageLangs();
    var html = "";
    for (var i = 0; i < langs.length; i++) {
      html += "<" + (tag || "span") + ' class="t" lang="' + langs[i] + '">' + TEXT[langs[i]][field] + "</" + (tag || "span") + ">";
    }
    return html;
  }

  // ---- consent banner ---------------------------------------------------
  var css =
    ".amp-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:60;max-width:680px;margin:0 auto;" +
    "background:var(--paper,#fff);color:var(--ink,#1a2334);border:1px solid var(--line,#d9e0ea);border-radius:12px;" +
    "box-shadow:0 12px 32px rgba(0,0,0,.14);padding:14px 16px;font-size:14px;line-height:1.5;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}" +
    ".amp-consent[hidden]{display:none}" +
    ".amp-consent p{margin:0;flex:1 1 320px}" +
    ".amp-consent a{color:var(--ref,#2f5fa8)}" +
    ".amp-consent .amp-consent-actions{display:flex;gap:8px;flex-wrap:wrap}" +
    ".amp-consent button{font:inherit;font-size:13.5px;min-height:44px;padding:8px 16px;border-radius:999px;cursor:pointer;" +
    "border:1px solid var(--line,#d9e0ea);background:var(--panel,#f0f3f8);color:var(--ink,#1a2334)}" +
    ".amp-consent button.primary{background:var(--accent,#8b5a0e);border-color:var(--accent,#8b5a0e);color:#fff;font-weight:700}" +
    ".amp-consent button:focus-visible{outline:2px solid var(--accent,#8b5a0e);outline-offset:2px}" +
    "@media (max-width:640px){.amp-consent{left:8px;right:8px;bottom:8px;padding:12px 14px}}";

  function injectStyle() {
    var s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  var banner = null;
  function buildBanner() {
    if (banner) return banner;
    banner = document.createElement("div");
    banner.className = "amp-consent";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-live", "polite");
    banner.setAttribute("aria-label", "Cookie consent");
    banner.innerHTML =
      "<p>" + spans("msg") + ' <a href="' + MORE_URL + '" target="_blank" rel="noopener">' + spans("more") + "</a></p>" +
      '<div class="amp-consent-actions">' +
      '<button type="button" class="primary" data-consent="granted">' + spans("accept") + "</button>" +
      '<button type="button" data-consent="denied">' + spans("decline") + "</button>" +
      "</div>";
    banner.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-consent]");
      if (!b) return;
      decide(b.getAttribute("data-consent"));
    });
    document.body.appendChild(banner);
    return banner;
  }
  function showBanner() { buildBanner().hidden = false; }
  function hideBanner() { if (banner) banner.hidden = true; }
  function decide(choice) {
    store(choice);
    gtagSafe("consent", "update", { analytics_storage: choice });
    gtagSafe("event", "consent_update", { consent_choice: choice, page_language: currentLang() });
    hideBanner();
  }
  // A "Cookie settings" link in the footer reopens the banner so a choice can
  // be changed; the CSS shows the span for the active language.
  function addFooterLink() {
    var p = document.querySelector("footer p:last-of-type");
    if (!p) return;
    var a = document.createElement("a");
    a.href = "#";
    a.className = "amp-consent-open";
    a.innerHTML = spans("settings");
    a.addEventListener("click", function (e) { e.preventDefault(); showBanner(); });
    p.appendChild(document.createTextNode(" · "));
    p.appendChild(a);
  }

  // ---- events ---------------------------------------------------------
  function trimText(s, n) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, n || 80); }

  function classifyLink(a) {
    var href = a.getAttribute("href") || "";
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return null; }
    if (url.origin === location.origin) {
      if (href.indexOf("#") === 0) return null; // in-page anchor
      var p = url.pathname.replace(/\/index\.html$/, "/");
      if (/benchmark\.html$/.test(p)) return { name: "benchmark_click", params: { link_path: p } };
      if (p === "/") return { name: "home_click", params: { link_path: p } };
      return null;
    }
    if (url.hostname === "github.com" && /^\/RxAi-Aus\/amp/i.test(url.pathname)) {
      if (/PROTOCOL\.md/i.test(url.pathname)) return { name: "protocol_click", params: { link_path: url.pathname } };
      if (/README|#readme/i.test(url.pathname + url.hash)) return { name: "readme_click", params: { link_path: url.pathname + url.hash } };
      return { name: "github_click", params: { link_path: url.pathname + url.hash } };
    }
    return { name: "outbound_click", params: { link_domain: url.hostname, link_path: url.pathname } };
  }

  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]");
    if (!a || a.classList.contains("amp-consent-open")) return;
    var c = classifyLink(a);
    if (!c) return;
    c.params.link_url = a.href;
    c.params.link_text = trimText(a.textContent, 80);
    c.params.page_language = currentLang();
    gtagSafe("event", c.name, c.params);
  }, true);

  // Copying an install command is the strongest intent signal this page has.
  document.addEventListener("copy", function () {
    var sel = window.getSelection && window.getSelection();
    var text = sel ? trimText(sel.toString(), 120) : "";
    if (!text) return;
    var node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    var inCode = node && node.closest && node.closest("pre, code, .trigger, .cmd");
    if (!inCode && !/^(npm|npx|git|node|cd|cp)\b/.test(text)) return;
    gtagSafe("event", "command_copy", { command: text, page_language: currentLang() });
  });

  document.addEventListener("click", function (e) {
    var b = e.target.closest(".langbar button[data-set]");
    if (!b) return;
    var l = b.getAttribute("data-set");
    gtagSafe("event", "language_switch", { language: l, previous_language: currentLang() });
    gtagSafe("set", "user_properties", { site_language: l });
  }, true);

  function observeSections() {
    var labels = document.querySelectorAll(".sec-head .mono-label");
    if (!labels.length || !("IntersectionObserver" in window)) return;
    var seen = {};
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        var name = trimText(entries[i].target.textContent.replace(/ /g, " "), 40);
        if (seen[name]) continue;
        seen[name] = true;
        gtagSafe("event", "section_view", { section: name, page_language: currentLang() });
        io.unobserve(entries[i].target);
      }
    }, { threshold: 0.5 });
    for (var j = 0; j < labels.length; j++) io.observe(labels[j]);
  }

  // ---- boot -----------------------------------------------------------
  function boot() {
    injectStyle();
    gtagSafe("set", "user_properties", { site_language: currentLang() });
    addFooterLink();
    if (stored() !== "granted" && stored() !== "denied") showBanner();
    observeSections();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
