// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// AMP Board client. Plain DOM, no framework. Every column re-renders with
// replaceChildren from the in-memory state; text goes in as text nodes —
// the only innerHTML is the whitelist markdown renderer for OKF bodies.

import { renderSafeMarkdown } from "/lib/markdown.mjs";

const TYPE_ORDER = ["intent", "facts", "pattern", "invalidation", "discovery", "events", "lifefact"];
const WAITING = ["queued", "running", "blocked", "failed"];
const FINISHED = ["finished", "reviewing"];
const LOG_LINES = 8;
const API_TIMEOUT_MS = 20000;

const state = {
  config: null,
  projects: [],
  selectedRegion: null,
  issues: null,
  selectedIssue: null,
  tasks: [],
  logs: new Map(), // runId → { offset, text, done }
  rejecting: new Set(),
  busy: new Set(),
  openLogs: new Map(), // taskId → runId of the log the user opened
  // Card-local input the user has typed but not yet submitted. Columns are
  // rebuilt wholesale on every server event, so anything living only in the
  // DOM is destroyed by an unrelated agent's state change. These two maps are
  // what make a re-render non-destructive.
  drafts: new Map(), //         taskId → in-progress rejection note
  agentPicks: new Map(), // `taskId:field` → agent chosen but not yet assigned
};

const $ = (id) => document.getElementById(id);

// Guards against a double-click or a held Enter creating the same task twice.
let addingTask = false;

/** Drop card-local input once a task is gone or has moved on. */
function forgetTask(id) {
  state.drafts.delete(id);
  state.agentPicks.delete(`${id}:assignee`);
  state.agentPicks.delete(`${id}:reviewer`);
  state.rejecting.delete(id);
  state.openLogs.delete(id);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function ago(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 36) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function fmtUtc(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// A pill is a label, not an announcement. Marking every one of them a live
// region made a screen reader read the whole board on every event; status
// changes are announced once, through #live-status, by upsertTask.
function pill(status, { spinning = false, small = false, label = null } = {}) {
  return h("span", { class: `pill st-${status}${spinning ? " is-spinning" : ""}${small ? " sm" : ""}` }, label ?? status);
}

function announce(message) {
  const el = $("live-status");
  if (el) el.textContent = message;
}

function chip(text, attrs = {}) {
  return h("span", { class: "chip", ...attrs }, text);
}

/** An interactive chip is a real button, so Enter and Space work for free. */
function chipButton(text, { title = null, onclick = null } = {}) {
  return h("button", { type: "button", class: "chip is-link", title, onclick }, text);
}

// ---------------------------------------------------------------------------
// Focus preservation across re-renders
//
// Every column is rebuilt with replaceChildren, which destroys the focused
// element and drops focus to <body>. Containers that get rebuilt tag
// themselves with data-focus-key; focus is restored to the same control in
// the same container, but only when that container is genuinely unchanged —
// a key encodes the task's status, so a card that actually moved on does not
// steal focus back.
// ---------------------------------------------------------------------------

const FOCUSABLE = "button, select, textarea, input, a[href], [tabindex]";

function captureFocus() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const host = el.closest("[data-focus-key]");
  if (!host) return null;
  const index = [...host.querySelectorAll(FOCUSABLE)].indexOf(el);
  if (index < 0) return null;
  const isText = typeof el.selectionStart === "number";
  return {
    key: host.dataset.focusKey,
    index,
    start: isText ? el.selectionStart : null,
    end: isText ? el.selectionEnd : null,
    scrollTop: el.scrollTop || 0,
  };
}

function restoreFocus(snap) {
  if (!snap) return;
  const host = [...document.querySelectorAll("[data-focus-key]")].find((e) => e.dataset.focusKey === snap.key);
  if (!host) return;
  const el = [...host.querySelectorAll(FOCUSABLE)][snap.index];
  if (!el) return;
  el.focus({ preventScroll: true });
  if (snap.start !== null && typeof el.setSelectionRange === "function") {
    try {
      el.setSelectionRange(snap.start, snap.end);
    } catch {
      /* control does not support a selection range */
    }
  }
  if (snap.scrollTop) el.scrollTop = snap.scrollTop;
}

let toastTimer = null;
function toast(message, { error = false, ms = 4000 } = {}) {
  const el = $("toast");
  clearTimeout(toastTimer);
  // Unhide first: text written into a display:none live region is announced
  // unreliably, so the content goes in once the region is actually present.
  el.className = `toast${error ? " is-error" : ""}`;
  el.hidden = false;
  el.replaceChildren(
    h("span", { class: "toast-msg" }, message),
    // Errors stay until dismissed. A failure that scrolls past in four
    // seconds is a failure the user never got to read.
    error ? h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss", onclick: () => (el.hidden = true) }, "×") : null,
  );
  if (!error) toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(method, route, body) {
  // Without a deadline a hung request leaves the card busy forever, with no
  // way back except a reload.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(route, {
      method,
      signal: ctrl.signal,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`The board server did not answer within ${API_TIMEOUT_MS / 1000}s. It may have stopped.`);
    throw new Error(`Cannot reach the board server. ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error((json && json.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function act(key, fn) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  renderTasks();
  try {
    await fn();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    state.busy.delete(key);
    renderTasks();
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadConfig() {
  state.config = await api("GET", "/api/config");
  renderHeader();
}

async function loadProjects() {
  const { projects } = await api("GET", "/api/projects");
  state.projects = projects;
  if (!state.selectedRegion || !projects.some((p) => p.region === state.selectedRegion)) {
    const remembered = safeGet("amp-board:region");
    const pick = projects.find((p) => p.region === remembered) || projects[0];
    state.selectedRegion = pick ? pick.region : null;
  }
  renderProjects();
}

async function loadIssues() {
  if (!state.selectedRegion) {
    state.issues = null;
    renderIssues();
    return;
  }
  const region = state.selectedRegion;
  try {
    const data = await api("GET", `/api/projects/${encodeURIComponent(region)}/issues`);
    if (state.selectedRegion !== region) return;
    state.issues = data;
  } catch (err) {
    state.issues = null;
    toast(err.message, { error: true });
  }
  renderIssues();
}

async function loadTasks() {
  const { tasks } = await api("GET", "/api/tasks");
  state.tasks = tasks;
  renderTasks();
  renderProjects();
}

async function selectIssue(n) {
  if (state.selectedIssue && state.selectedIssue.n === n) return;
  state.selectedIssue = { n, loading: true };
  renderIssues();
  renderDetail();
  try {
    const { issue } = await api("GET", `/api/issues/${n}`);
    state.selectedIssue = issue;
  } catch (err) {
    state.selectedIssue = { n, error: err.message };
  }
  renderIssues();
  renderDetail();
}

function selectRegion(region) {
  if (region === state.selectedRegion) return;
  state.selectedRegion = region;
  state.selectedIssue = null;
  safeSet("amp-board:region", region);
  renderProjects();
  renderDetail();
  renderTasks();
  loadIssues();
}

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function agentOptions(select, { selected = null, includeEmpty = false } = {}) {
  const agents = state.config ? state.config.agents : [];
  select.replaceChildren(
    ...(includeEmpty ? [h("option", { value: "" }, "unassigned")] : []),
    ...agents.map((a) =>
      h("option", { value: a.name, disabled: !a.available, selected: a.name === selected }, a.available ? a.name : `${a.name} (not available)`),
    ),
  );
  if (!includeEmpty && !selected) {
    const def = state.config && state.config.settings.defaultAgent;
    const usable = agents.find((a) => a.name === def && a.available) || agents.find((a) => a.available);
    if (usable) select.value = usable.name;
  }
}

function renderHeader() {
  const c = state.config;
  if (!c) return;
  $("clone-path").textContent = c.clone;
  $("clone-path").title = c.repoSlug ? `${c.repoSlug} · ${c.clone}` : c.clone;
  $("last-compiled").textContent = `Last compiled ${fmtUtc(c.lastCompiled)}`;
  const refresh = $("refresh-btn");
  if (c.gitClean === false) {
    refresh.disabled = true;
    refresh.title = "worktree dirty, pull skipped";
  } else if (c.gitError) {
    refresh.disabled = true;
    refresh.title = c.gitError;
  } else {
    refresh.disabled = false;
    refresh.title = "git pull --ff-only, then rescan";
  }
  $("agent-legend").replaceChildren(
    ...c.agents
      .filter((a) => a.name !== "fake" || a.available)
      .map((a) =>
        h(
          "li",
          { class: `${a.available ? "" : "is-off"}${a.name === "fake" ? " is-dev" : ""}`, title: a.available ? `${a.name} · ${a.bin}` : a.verified ? `${a.name}: ${a.bin} not on PATH` : `${a.name}: adapter not verified yet` },
          a.name,
        ),
      ),
  );
  agentOptions($("add-task-agent"));
}

// ---------------------------------------------------------------------------
// Column 1 — projects
// ---------------------------------------------------------------------------

function renderProjects() {
  const focus = captureFocus();
  const list = $("projects-list");
  $("count-projects").textContent = state.projects.length;
  if (!state.projects.length) {
    list.replaceChildren(h("div", { class: "empty" }, h("strong", {}, "No REGION files found"), "Run the index compiler in the memory clone, then Refresh."));
    return;
  }
  list.replaceChildren(
    ...state.projects.map((p) => {
      const badges = [];
      const t = p.tasks || {};
      const waiting = (t.queued || 0) + (t.blocked || 0) + (t.failed || 0);
      if (waiting) badges.push(pill("queued", { small: true, label: `${waiting} waiting` }));
      if (t.running) badges.push(pill("running", { small: true, spinning: true, label: `${t.running} running` }));
      if (t.blocked) badges.push(pill("blocked", { small: true, label: `${t.blocked} blocked` }));
      if (t.failed) badges.push(pill("failed", { small: true, label: `${t.failed} failed` }));
      const review = (t.finished || 0) + (t.reviewing || 0);
      if (review) badges.push(pill("reviewing", { small: true, spinning: Boolean(t.reviewing), label: `${review} review` }));
      if (t.approval) badges.push(pill("approval", { small: true, label: `${t.approval} approval` }));
      const selected = p.region === state.selectedRegion;
      // The row used to be a div with tabindex whose keydown handler called
      // preventDefault() without checking the target, which cancelled the
      // nested gear button's own activation on Space. The two controls are
      // now siblings: a real button for selection, a real button for
      // settings, neither inside the other.
      const select = h(
        "button",
        {
          type: "button",
          class: "project-main",
          "aria-current": selected ? "true" : null,
          onclick: () => selectRegion(p.region),
        },
        h("span", { class: "name" }, p.region),
        h(
          "span",
          { class: "counts" },
          h("b", {}, p.activeCount),
          " active · ",
          h("b", {}, p.archivedCount),
          " archived",
          p.unindexedCount ? [" · ", h("b", {}, p.unindexedCount), " new"] : null,
        ),
        p.workdir ? h("span", { class: "wd", title: p.workdir }, p.workdir) : null,
        h("span", { class: "badges" }, ...badges),
      );
      // The same gear the top bar uses, from the one <symbol> that defines it.
      const gearSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      gearSvg.setAttribute("width", "14");
      gearSvg.setAttribute("height", "14");
      gearSvg.setAttribute("aria-hidden", "true");
      gearSvg.setAttribute("focusable", "false");
      const gearUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
      gearUse.setAttribute("href", "#icon-gear");
      gearSvg.append(gearUse);
      const gear = h(
        "button",
        {
          type: "button",
          class: "gear",
          "aria-label": `Settings for ${p.region}`,
          title: "Project settings",
          onclick: () => openProjectDialog(p),
        },
        gearSvg,
      );
      return h(
        "div",
        {
          class: `project${selected ? " is-selected" : ""}`,
          role: "listitem",
          dataset: { focusKey: `project:${p.region}` },
        },
        select,
        gear,
      );
    }),
  );
  restoreFocus(focus);
}

// ---------------------------------------------------------------------------
// Column 2 — issues + detail
// ---------------------------------------------------------------------------

function issueRow(row, { archived = false } = {}) {
  const selected = state.selectedIssue && state.selectedIssue.n === row.n;
  return h(
    "button",
    {
      type: "button",
      class: `issue-row${selected ? " is-selected" : ""}${archived ? " is-archived" : ""}`,
      // A single-selection list, not a toggle. aria-pressed made every
      // unselected row announce itself as "not pressed" while scanning.
      "aria-current": selected ? "true" : null,
      onclick: () => selectIssue(row.n),
    },
    h("span", { class: "n" }, `#${row.n}`),
    !archived ? h("span", { class: "w", title: `weight ${row.weight}` }, h("i", { style: `width:${Math.round(Math.min(1, row.weight) * 100)}%` })) : null,
    h("span", { class: "title" }, row.title),
    h(
      "span",
      { class: "meta" },
      !archived ? h("span", { title: "confidence weight" }, row.weight.toFixed(2)) : h("span", {}, "archived"),
      // The count used to read as a speech-balloon emoji, which a screen
      // reader announced as "speech balloon" and which was a third icon
      // vocabulary beside the board's SVG and its text glyph. The number keeps
      // the density; the word is there for anything that reads the page aloud.
      !archived
        ? h(
            "span",
            { title: `${row.comments} ${row.comments === 1 ? "comment" : "comments"}, updated ${row.updated}` },
            String(row.comments),
            h("span", { class: "sr-only" }, ` ${row.comments === 1 ? "comment" : "comments"}`),
            ` · ${row.updated}`,
          )
        : null,
    ),
  );
}

function renderIssues() {
  const list = $("issues-list");
  const head = $("h-issues");
  const data = state.issues;
  if (!state.selectedRegion) {
    head.textContent = "Memory issues";
    $("count-issues").textContent = "0";
    list.replaceChildren(h("div", { class: "empty" }, h("strong", {}, "Select a project"), "Its memory issues appear here, grouped by place and type."));
    return;
  }
  head.textContent = `Memory issues · ${state.selectedRegion}`;
  if (!data) {
    $("count-issues").textContent = "0";
    list.replaceChildren(h("div", { class: "empty" }, "Loading…"));
    return;
  }
  $("count-issues").textContent = data.activeCount;
  const parts = [];

  const unindexed = h(
    "details",
    { class: "strip", open: data.unindexed.length > 0 && data.unindexed.length <= 5 },
    h("summary", {}, "New / unindexed", h("span", { class: "count" }, `(${data.unindexed.length})`)),
    data.unindexed.length
      ? data.unindexed.map((r) =>
          h(
            "div",
            { class: "unindexed-row" },
            h("span", { class: "n" }, `#${r.n}`),
            h("span", {}, h("span", { class: `tag ty-${r.type}` }, r.type), " ", h("span", { class: "mono" }, r.place)),
            h("span", { class: "from" }, `${r.from} · ${r.posted.slice(0, 10)}`),
          ),
        )
      : h("div", { class: "empty" }, "Nothing posted since the last compile."),
  );
  parts.push(unindexed);

  if (!data.places.length) {
    parts.push(h("div", { class: "empty" }, h("strong", {}, "No indexed issues yet"), "Agents store memory here via the rxai-amp skill."));
  }
  for (const place of data.places) {
    const rowsCount = place.types.reduce((n, t) => n + t.rows.length, 0);
    parts.push(
      h(
        "details",
        { class: "place", open: true },
        h("summary", { class: "place-head" }, h("span", { class: "place-name" }, place.place), h("span", { class: "count" }, rowsCount || (place.archived.length ? `${place.archived.length} archived` : "0"))),
        ...place.types
          .slice()
          .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
          .map((t) => h("div", {}, h("div", { class: "type-head" }, h("span", { class: `tag ty-${t.type}` }, t.type), `${t.rows.length}`), ...t.rows.map((r) => issueRow(r)))),
      ),
    );
  }
  if (data.archived.length) {
    parts.push(
      h(
        "details",
        { class: "strip" },
        h("summary", {}, "Archived", h("span", { class: "count" }, `(${data.archived.length})`)),
        ...data.archived.map((a) => issueRow({ n: a.n, title: `${a.title} · ${a.place}`, weight: 0, comments: 0, updated: "" }, { archived: true })),
      ),
    );
  }
  list.replaceChildren(...parts);
}

function renderDetail() {
  const pane = $("issue-detail");
  const sel = state.selectedIssue;
  if (!sel) {
    pane.replaceChildren(h("div", { class: "empty" }, h("strong", {}, "No issue selected"), "Pick a row above to read its OKF body and comments."));
    return;
  }
  if (sel.loading) {
    pane.replaceChildren(h("div", { class: "empty" }, `Loading #${sel.n}…`));
    return;
  }
  if (sel.error) {
    pane.replaceChildren(h("div", { class: "empty" }, h("strong", {}, `#${sel.n} is not compiled locally`), sel.error));
    return;
  }
  const fm = sel.frontmatter || {};
  const meta = sel.meta || {};
  const kv = [
    ["issue", `#${sel.n}`],
    ["from", meta.from || fm.amp_from || "—"],
    ["to", meta.to || "—"],
    ["region", sel.region],
    ["place", sel.place],
    ["type", fm.type || meta.type || "—"],
    ["posted", meta.posted || fm.timestamp || "—"],
    ["weight", fm.amp_weight !== undefined ? String(fm.amp_weight) : "—"],
    ["outcome", fm.amp_outcome || "—"],
  ];
  const sections = (sel.sections || []).filter((s) => s.name !== "Metadata");
  // Memory is untrusted input. A body that defeats the renderer (deeply
  // nested quotes overflow its recursion) must cost one section, not the
  // whole pane. Each section is rendered on its own so one failure is
  // contained and visible instead of silently truncating what follows.
  const md = h("div", { class: "md" });
  // The pane's own title is an h3, so a section name is an h4 and a body's
  // headings sit below that. They used to be emitted as h2 with the body's
  // own h1 nested underneath, which put the outline in the wrong order.
  md.innerHTML = sections
    .map((s) => `<h4>${escapeText(s.name)}</h4>${safeBody(s.body, s.name)}`)
    .join("");
  const comments = sel.comments || [];
  const commentEls = comments.map((c) => {
    const body = h("div", { class: "md" });
    body.innerHTML = safeBody(c.body, `comment by ${c.author}`);
    return h(
      "article",
      { class: "comment" },
      h("div", { class: "comment-head" }, h("b", {}, c.author), c.outcome ? h("span", { class: `outcome ${c.outcome}` }, c.outcome) : null, h("time", { datetime: c.at }, c.at)),
      body,
    );
  });
  pane.replaceChildren(
    h(
      "div",
      { class: "detail-inner" },
      h("div", { class: "detail-head" }, h("span", { class: "n" }, `#${sel.n}`), h("h3", {}, fm.title || "(untitled)")),
      h("dl", { class: "kv" }, ...kv.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
      fm.resource ? h("p", { class: "hint" }, h("a", { class: "resource-link", href: fm.resource, target: "_blank", rel: "noopener noreferrer" }, "Open on GitHub")) : null,
      md,
      h("div", { class: "comments" }, h("h4", {}, `Comments (${comments.length})`), comments.length ? commentEls : h("p", { class: "hint" }, "No comments yet.")),
      h("div", { class: "actions", style: "margin-top:12px" }, h("button", { type: "button", class: "btn btn-sm", onclick: () => prefillTask(sel) }, "Create task from this issue")),
    ),
  );
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Re-level a rendered block's headings so its shallowest one lands on `base`
 * and the rest keep their relative depth. A fixed offset does not work here:
 * memory bodies start at whatever level their author chose, so an offset that
 * suits one block skips a level in the next. The renderer's output is fully
 * escaped and the only tags in it are ones it emitted, so rewriting heading
 * tags can never touch author content.
 */
function levelHeadings(html, base) {
  const seen = [...html.matchAll(/<h([123])>/g)].map((m) => Number(m[1]));
  if (!seen.length) return html;
  const shallowest = Math.min(...seen);
  return html.replace(/<(\/?)h([123])>/g, (_, slash, level) => `<${slash}h${Math.min(6, base + Number(level) - shallowest)}>`);
}

/** Render one block of memory markdown, degrading to a notice on failure. */
function safeBody(source, label) {
  try {
    // Every block sits under an h4, so its own headings begin at h5.
    return levelHeadings(renderSafeMarkdown(source), 5);
  } catch {
    return `<p class="hint">This ${escapeText(label)} could not be rendered. The stored text is malformed.</p>`;
  }
}

// The form starts collapsed so the Waiting column opens on the work rather
// than on an empty form. The choice is remembered, and anything that needs
// the form opens it.
function setAddOpen(open) {
  const form = $("add-task");
  form.classList.toggle("is-collapsed", !open);
  $("add-toggle").setAttribute("aria-expanded", String(open));
  safeSet("amp-board:add-open", open ? "1" : "0");
}

$("add-toggle").addEventListener("click", () => setAddOpen($("add-task").classList.contains("is-collapsed")));
setAddOpen(safeGet("amp-board:add-open") === "1");

// The description is the agent's whole brief, and the browser truncates it at
// the limit without saying so. The count appears once it is close enough to
// matter, rather than sitting there counting from zero.
(function wireDescriptionCount() {
  const ta = $("add-task").elements.description;
  const out = $("desc-count");
  const max = Number(ta.getAttribute("maxlength"));
  const update = () => {
    const left = max - ta.value.length;
    const near = ta.value.length >= max * 0.8;
    out.hidden = !near;
    if (near) out.textContent = left === 0 ? "Character limit reached." : `${left} characters left.`;
  };
  ta.addEventListener("input", update);
  $("add-task").addEventListener("reset", () => setTimeout(update, 0));
  update();
})();

function prefillTask(issue) {
  const form = $("add-task");
  setAddOpen(true);
  form.elements.linkedIssue.value = issue.n;
  if (!form.elements.title.value) form.elements.title.value = (issue.frontmatter && issue.frontmatter.title) || "";
  form.elements.title.focus();
  // Focusing a prefilled input scrolls it to the end. Show the start of the
  // title instead, which is the part worth reading before editing.
  form.elements.title.setSelectionRange(0, 0);
  form.elements.title.scrollLeft = 0;
}

// ---------------------------------------------------------------------------
// Columns 3–5 — tasks
// ---------------------------------------------------------------------------

function regionTasks() {
  return state.tasks.filter((t) => t.region === state.selectedRegion).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function openRun(task) {
  return task.runs.find((r) => r.endedAt === null) || null;
}

function lastRun(task, role) {
  return task.runs.filter((r) => !role || r.role === role).at(-1) || null;
}

function logView(runId) {
  const entry = state.logs.get(runId) || { text: "" };
  const lines = entry.text.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - LOG_LINES - 1));
  const pre = h(
    "pre",
    // Focusable so it can be scrolled by keyboard, and named as a region so
    // it lands as something rather than as a bare stop in the tab order.
    { class: "log", role: "region", tabindex: "0", "aria-label": "Agent log tail" },
    ...tail.map((line, i) => [line.startsWith("[err]") ? h("span", { class: "err" }, line) : line, i < tail.length - 1 ? "\n" : null]),
  );
  requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
  ensureLog(runId);
  return pre;
}

const logFetches = new Set();
async function ensureLog(runId) {
  const entry = state.logs.get(runId);
  if (entry && (entry.done || entry.primed)) return;
  await pullLog(runId);
}

async function pullLog(runId) {
  if (logFetches.has(runId)) return;
  logFetches.add(runId);
  try {
    const entry = state.logs.get(runId) || { offset: 0, text: "", done: false };
    const data = await api("GET", `/api/runs/${runId}/log?offset=${entry.offset}`);
    const next = { offset: data.next, text: (entry.text + data.chunk).slice(-16384), done: data.done, primed: true };
    state.logs.set(runId, next);
    if (data.chunk) renderLogs(runId);
  } catch {
    /* log not there yet */
  } finally {
    logFetches.delete(runId);
  }
}

function renderLogs(runId) {
  for (const pre of document.querySelectorAll(`[data-log="${runId}"] pre.log`)) {
    const fresh = logView(runId);
    pre.replaceWith(fresh);
  }
}

function historyBlock(task) {
  if (!task.history.length) return null;
  return h(
    "details",
    { class: "history" },
    h("summary", {}, `History (${task.history.length})`),
    h(
      "ul",
      {},
      ...task.history
        .slice()
        .reverse()
        .map((e) =>
          h(
            "li",
            {},
            h("time", { datetime: e.at, title: e.at }, ago(e.at)),
            h("span", {}, e.from ? `${e.from} ` : "", h("span", { class: "arrow" }, "→ "), e.to, " ", h("span", { class: "hint" }, `· ${e.actor}`)),
            e.note ? h("span", { class: "hnote" }, e.note) : null,
          ),
        ),
    ),
  );
}

function agentSelect(task, field) {
  const key = `${task.id}:${field}`;
  const sel = h("select", {
    class: "select",
    "aria-label": field === "assignee" ? "Agent" : "Reviewer",
    // Remember the choice. Without this a re-render silently reset the
    // select to the default agent, so an Assign pressed afterwards ran the
    // task on an agent the user had not picked.
    onchange: (e) => state.agentPicks.set(key, e.target.value),
  });
  const picked = state.agentPicks.get(key);
  agentOptions(sel, { selected: picked || task[field], includeEmpty: false });
  if (picked && [...sel.options].some((o) => o.value === picked)) sel.value = picked;
  return sel;
}

function taskCard(task) {
  const status = task.status;
  const busy = state.busy.has(task.id);
  const run = openRun(task);
  const worker = lastRun(task, "worker");
  const reviewer = lastRun(task, "reviewer");
  const chips = [];
  if (status === "finished" || status === "reviewing" || status === "approval") {
    if (task.assignee) chips.push(chip(task.assignee, { title: "worker agent" }));
  } else if (task.assignee) chips.push(chip(task.assignee, { title: "assigned agent" }));
  if (task.linkedIssue) chips.push(chipButton(`#${task.linkedIssue}`, { title: "Open linked issue", onclick: () => selectIssue(task.linkedIssue) }));
  if (task.result && task.result.issue) chips.push(chipButton(`posted #${task.result.issue}`, { title: "Open posted issue", onclick: () => selectIssue(task.result.issue) }));
  if (task.reviewer && (status === "reviewing" || status === "approval" || status === "done")) chips.push(chip(`review: ${task.reviewer}`));

  const body = [];
  const actions = [];
  const dataAttrs = {};

  if (status === "queued") {
    if (task.rejection) body.push(h("div", { class: "note rejection" }, h("b", {}, "Rejected: "), task.rejection));
    if (task.description) body.push(h("p", { class: "desc", title: task.description }, task.description));
    if (task.pendingRun) body.push(h("div", { class: "note pending" }, `Waiting for a free slot (concurrency ${state.config ? state.config.settings.concurrency : "?"}) — starts automatically.`));
    const sel = agentSelect(task, "assignee");
    actions.push(
      sel,
      h("button", { type: "button", class: `btn btn-sm btn-primary${busy ? " is-busy" : ""}`, disabled: busy || Boolean(task.pendingRun), onclick: () => assign(task, sel.value) }, "Assign"),
      h("button", { type: "button", class: "btn btn-sm", disabled: busy, "aria-label": `Delete task ${task.title}`, onclick: () => remove(task) }, "Delete"),
    );
  } else if (status === "running") {
    dataAttrs.log = run ? run.runId : "";
    body.push(run ? logView(run.runId) : null);
    actions.push(h("button", { type: "button", class: `btn btn-sm btn-danger${busy ? " is-busy" : ""}`, disabled: busy, onclick: () => post(task, "cancel") }, "Cancel"));
  } else if (status === "blocked") {
    body.push(h("div", { class: "note blocked" }, h("b", {}, "Blocked: "), (task.result && (task.result.notes || task.result.summary)) || "The agent reported it is blocked but gave no reason."));
    actions.push(h("button", { type: "button", class: `btn btn-sm btn-primary${busy ? " is-busy" : ""}`, disabled: busy, onclick: () => post(task, "retry") }, "Retry"));
    actions.push(h("button", { type: "button", class: "btn btn-sm", disabled: busy, "aria-label": `Delete task ${task.title}`, onclick: () => remove(task) }, "Delete"));
  } else if (status === "failed") {
    body.push(h("div", { class: "note failed" }, (worker && worker.error) || "The run failed without reporting an error."));
    if (worker) actions.push(h("button", { type: "button", class: "btn btn-sm", onclick: () => toggleLog(task.id, worker.runId) }, state.openLogs.get(task.id) === worker.runId ? "Hide log" : "Show log"));
    actions.push(h("button", { type: "button", class: `btn btn-sm btn-primary${busy ? " is-busy" : ""}`, disabled: busy, onclick: () => post(task, "retry") }, "Retry"));
    actions.push(h("button", { type: "button", class: "btn btn-sm", disabled: busy, "aria-label": `Delete task ${task.title}`, onclick: () => remove(task) }, "Delete"));
  } else if (status === "finished") {
    body.push(h("div", { class: "note summary" }, h("b", {}, "Worker summary: "), (task.result && task.result.summary) || "The agent finished without writing a summary."));
    if (task.result && task.result.notes && task.result.notes !== "no result JSON") body.push(h("p", { class: "hint" }, task.result.notes));
    if (task.result && task.result.notes === "no result JSON") body.push(h("p", { class: "hint" }, "Agent exited 0 without a JSON trailer; summary is the log tail."));
    if (task.pendingRun) body.push(h("div", { class: "note pending" }, "Review queued — waiting for a free slot."));
    const sel = agentSelect(task, "reviewer");
    actions.push(
      sel,
      h("button", { type: "button", class: `btn btn-sm btn-primary${busy ? " is-busy" : ""}`, disabled: busy || Boolean(task.pendingRun), onclick: () => review(task, sel.value) }, "Review"),
    );
    if (worker) actions.push(h("button", { type: "button", class: "btn btn-sm", onclick: () => toggleLog(task.id, worker.runId) }, state.openLogs.get(task.id) === worker.runId ? "Hide log" : "Show log"));
  } else if (status === "reviewing") {
    dataAttrs.log = run ? run.runId : "";
    body.push(h("div", { class: "note summary" }, h("b", {}, "Worker summary: "), (task.result && task.result.summary) || "The agent finished without writing a summary."));
    body.push(run ? logView(run.runId) : null);
    actions.push(h("button", { type: "button", class: `btn btn-sm btn-danger${busy ? " is-busy" : ""}`, disabled: busy, onclick: () => post(task, "cancel") }, "Cancel review"));
  } else if (status === "approval") {
    body.push(h("div", { class: "note summary" }, h("b", {}, "Worker summary: "), (task.result && task.result.summary) || "The agent finished without writing a summary."));
    // The verdict leads the reviewer's note, so it is read where the decision
    // is actually made rather than colouring the card as though it were done.
    const verdict = task.review && task.review.verdict === "reject" ? "requested changes" : "approved";
    body.push(
      h(
        "div",
        { class: "note review" },
        h("b", {}, `${task.reviewer || "The reviewer"} ${verdict}: `),
        (task.review && task.review.notes) || "no notes given.",
      ),
    );
    if (state.rejecting.has(task.id)) {
      // The note is mirrored into state on every keystroke. It used to live
      // only in this textarea, so any unrelated task event emptied it while
      // the form stayed open — the user's words vanished without a trace.
      const ta = h("textarea", {
        class: "select",
        placeholder: "What must change before this is accepted?",
        "aria-label": "Rejection note",
        oninput: (e) => state.drafts.set(task.id, e.target.value),
      });
      ta.value = state.drafts.get(task.id) || "";
      body.push(
        h(
          "div",
          { class: "reject-form" },
          ta,
          h(
            "div",
            { class: "actions" },
            h("button", { type: "button", class: `btn btn-sm btn-danger${busy ? " is-busy" : ""}`, disabled: busy, onclick: () => post(task, "reject", { note: ta.value }) }, "Confirm reject"),
            h("button", { type: "button", class: "btn btn-sm", onclick: () => { state.rejecting.delete(task.id); state.drafts.delete(task.id); renderTasks(); } }, "Cancel"),
          ),
        ),
      );
    } else {
      actions.push(
        h("button", { type: "button", class: `btn btn-sm btn-primary${busy ? " is-busy" : ""}`, disabled: busy, onclick: () => post(task, "approve") }, "Approve"),
        h("button", { type: "button", class: "btn btn-sm btn-danger", disabled: busy, onclick: () => { state.rejecting.add(task.id); renderTasks(); } }, "Reject…"),
      );
    }
    if (reviewer) actions.push(h("button", { type: "button", class: "btn btn-sm", onclick: () => toggleLog(task.id, reviewer.runId) }, state.openLogs.get(task.id) === reviewer.runId ? "Hide log" : "Show log"));
  }

  // The pill reports the task's own state, not the reviewer's verdict. Wearing
  // the verdict's colour, a card waiting on the user showed a green "approved"
  // pill — the board's completion colour on the one card that is not finished.
  // The verdict is evidence, and it reads in the reviewer's note below.
  const headPill =
    status === "approval"
      ? pill("approval", { label: "your decision" })
      : pill(status, { spinning: status === "running" || status === "reviewing" });

  // The focus key carries the status, so focus is restored only while the
  // card is genuinely the same card. A task that actually moved on gives
  // focus up rather than grabbing it back onto a different control.
  dataAttrs.focusKey = `task:${task.id}:${status}`;
  const card = h(
    "article",
    { class: `task st-${status}`, dataset: dataAttrs, "aria-label": `${task.title} — ${status}` },
    h("div", { class: "task-head" }, h("div", { class: "title" }, task.title), headPill),
    h("div", { class: "task-chips" }, ...chips, h("span", { class: "when", title: task.createdAt }, ago(task.createdAt))),
    h("div", { class: "task-body" }, ...body),
    h("div", { class: "task-actions" }, ...actions),
    historyBlock(task),
  );
  if (state.openLogs.has(task.id)) {
    const runId = state.openLogs.get(task.id);
    card.dataset.log = runId;
    card.querySelector(".task-body").append(logView(runId));
  }
  return card;
}

function toggleLog(taskId, runId) {
  if (state.openLogs.get(taskId) === runId) state.openLogs.delete(taskId);
  else state.openLogs.set(taskId, runId);
  renderTasks();
}

function renderTasks() {
  const focus = captureFocus();
  const tasks = regionTasks();
  const waiting = tasks.filter((t) => WAITING.includes(t.status));
  const finished = tasks.filter((t) => FINISHED.includes(t.status));
  const approval = tasks.filter((t) => t.status === "approval");
  const done = tasks.filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  $("count-waiting").textContent = waiting.length;
  $("count-finished").textContent = finished.length;
  $("count-approval").textContent = approval.length + (done.length ? ` · ${done.length} done` : "");

  const region = state.selectedRegion;
  $("waiting-list").replaceChildren(
    ...(waiting.length
      ? waiting.map(taskCard)
      : [h("div", { class: "empty" }, h("strong", {}, "No tasks yet"), region ? "Create one above — it waits here until you assign an agent." : "Select a project first.")]),
  );
  $("finished-list").replaceChildren(
    ...(finished.length ? finished.map(taskCard) : [h("div", { class: "empty" }, h("strong", {}, "Nothing to review"), "Finished worker runs land here for a reviewer agent.")]),
  );
  $("approval-list").replaceChildren(
    ...(approval.length ? approval.map(taskCard) : [h("div", { class: "empty" }, h("strong", {}, "Nothing awaiting approval"), "Reviewed tasks wait here for your decision.")]),
    ...(done.length
      ? [h(
          "details",
          { class: "done-strip" },
          h("summary", {}, `Done (${done.length})`),
          ...done.map((t) => h("div", { class: "done-row" }, h("span", { class: "title", title: t.title }, t.title), h("span", { class: "meta" }, `${t.assignee || "?"} · ${ago(t.updatedAt)}`))),
        )]
      : []),
  );
  const form = $("add-task");
  if (!addingTask) form.querySelectorAll("button, input, select, textarea").forEach((el) => (el.disabled = !region));
  restoreFocus(focus);
}

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

function upsertTask(task) {
  const idx = state.tasks.findIndex((t) => t.id === task.id);
  const prev = idx > -1 ? state.tasks[idx] : null;
  if (task.deleted) {
    if (idx > -1) state.tasks.splice(idx, 1);
    forgetTask(task.id);
    return;
  }
  if (idx > -1) state.tasks[idx] = task;
  else state.tasks.push(task);
  if (prev && prev.status !== task.status) {
    // The card has genuinely moved on, so anything typed against its old
    // state is stale. Announce the move once, in one live region, instead of
    // re-announcing every pill on the board.
    forgetTask(task.id);
    if (task.region === state.selectedRegion) announce(`${task.title} is now ${task.status}`);
  }
}

async function assign(task, agent) {
  await act(task.id, async () => {
    const { task: updated, pending } = await api("POST", `/api/tasks/${task.id}/assign`, { agent });
    upsertTask(updated);
    if (pending) toast("Concurrency is full — the run starts when a slot frees.");
  });
  refreshProjects();
}

async function review(task, agent) {
  await act(task.id, async () => {
    const { task: updated, pending } = await api("POST", `/api/tasks/${task.id}/review`, { agent });
    upsertTask(updated);
    if (pending) toast("Concurrency is full — the review starts when a slot frees.");
  });
  refreshProjects();
}

async function post(task, action, body = {}) {
  await act(task.id, async () => {
    const { task: updated } = await api("POST", `/api/tasks/${task.id}/${action}`, body);
    state.rejecting.delete(task.id);
    upsertTask(updated);
  });
  refreshProjects();
}

async function remove(task) {
  await act(task.id, async () => {
    await api("DELETE", `/api/tasks/${task.id}`);
    upsertTask({ ...task, deleted: true });
  });
  refreshProjects();
}

let projectsTimer = null;
function refreshProjects() {
  clearTimeout(projectsTimer);
  projectsTimer = setTimeout(() => loadProjects().catch(() => {}), 150);
}

$("add-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (addingTask) return;
  const form = e.currentTarget;
  const assignNow = e.submitter && e.submitter.dataset.assign === "1";
  const errEl = $("add-task-error");
  errEl.hidden = true;
  const payload = {
    region: state.selectedRegion,
    title: form.elements.title.value,
    description: form.elements.description.value,
    linkedIssue: form.elements.linkedIssue.value || null,
    assignee: form.elements.assignee.value || null,
  };
  const submitters = [...form.querySelectorAll('button[type="submit"]')];
  addingTask = true;
  for (const b of submitters) b.disabled = true;
  if (assignNow && submitters[0]) submitters[0].classList.add("is-busy");
  try {
    const { task } = await api("POST", "/api/tasks", payload);
    upsertTask(task);
    form.reset();
    agentOptions($("add-task-agent"));
    if (assignNow) await assign(task, payload.assignee);
    else refreshProjects();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    addingTask = false;
    for (const b of submitters) b.classList.remove("is-busy");
    renderTasks(); // re-enables the form according to the selected region
  }
});

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function openProjectDialog(project) {
  const dlg = $("project-dialog");
  const form = $("project-form");
  form.dataset.region = project.region;
  $("project-dialog-region").textContent = project.region;
  form.elements.workdir.value = project.workdir || "";
  form.elements.notes.value = project.notes || "";
  $("project-form-error").hidden = true;
  dlg.showModal();
}

$("project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errEl = $("project-form-error");
  try {
    await api("PATCH", `/api/projects/${encodeURIComponent(form.dataset.region)}`, {
      workdir: form.elements.workdir.value.trim() || null,
      notes: form.elements.notes.value,
    });
    $("project-dialog").close();
    await loadProjects();
    toast(`Saved settings for ${form.dataset.region}`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

$("settings-btn").addEventListener("click", () => {
  const form = $("settings-form");
  const s = state.config.settings;
  form.elements.concurrency.value = s.concurrency;
  form.elements.timeoutMin.value = s.timeoutMin;
  agentOptions($("settings-agent"), { selected: s.defaultAgent });
  form.elements.yolo.checked = Boolean(s.yolo);
  $("settings-home").textContent = state.config.home;
  $("settings-form-error").hidden = true;
  $("settings-dialog").showModal();
});

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errEl = $("settings-form-error");
  try {
    const { settings } = await api("PATCH", "/api/settings", {
      concurrency: Number(form.elements.concurrency.value),
      timeoutMin: Number(form.elements.timeoutMin.value),
      defaultAgent: form.elements.defaultAgent.value,
      yolo: form.elements.yolo.checked,
    });
    state.config.settings = settings;
    $("settings-dialog").close();
    renderHeader();
    renderTasks();
    toast("Saved board settings");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

for (const btn of document.querySelectorAll("dialog [data-close]")) btn.addEventListener("click", () => btn.closest("dialog").close());

$("refresh-btn").addEventListener("click", async () => {
  const btn = $("refresh-btn");
  btn.disabled = true;
  btn.classList.add("is-busy");
  try {
    const r = await api("POST", "/api/refresh");
    if (r.ok) {
      toast(r.output && r.output.includes("Already up to date") ? "Memory clone already up to date." : "Memory clone pulled and rescanned.");
      await Promise.all([loadConfig(), loadProjects()]);
      await loadIssues();
    } else toast(r.error || "Refresh skipped", { error: true });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    btn.classList.remove("is-busy");
    btn.disabled = false;
    renderHeader();
  }
});

// ---------------------------------------------------------------------------
// Column resize handles (persisted)
// ---------------------------------------------------------------------------

(function initHandles() {
  const root = document.documentElement;
  for (let i = 1; i <= 5; i++) {
    const saved = safeGet(`amp-board:col-${i}`);
    if (saved && /^\d+px$/.test(saved)) root.style.setProperty(`--col-${i}`, saved);
  }
  for (const handle of document.querySelectorAll(".handle")) {
    const n = Number(handle.dataset.col);
    const col = handle.previousElementSibling;
    const setWidth = (px) => {
      const w = Math.max(220, Math.round(px));
      root.style.setProperty(`--col-${n}`, `${w}px`);
      safeSet(`amp-board:col-${n}`, `${w}px`);
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = col.getBoundingClientRect().width;
      handle.classList.add("is-dragging");
      document.body.classList.add("is-resizing");
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => setWidth(startW + (ev.clientX - startX));
      const up = () => {
        handle.classList.remove("is-dragging");
        document.body.classList.remove("is-resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    handle.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setWidth(col.getBoundingClientRect().width + (e.key === "ArrowRight" ? 24 : -24));
    });
    handle.addEventListener("dblclick", () => {
      root.style.removeProperty(`--col-${n}`);
      try {
        localStorage.removeItem(`amp-board:col-${n}`);
      } catch {
        /* ignore */
      }
    });
  }
})();

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

let es = null;
let backoff = 1000;
function connect() {
  const conn = $("conn");
  if (es) es.close();
  es = new EventSource("/api/events");
  es.addEventListener("hello", () => {
    conn.textContent = "live";
    conn.className = "conn is-live";
    backoff = 1000;
    loadTasks().catch(() => {});
  });
  es.addEventListener("task", (e) => {
    upsertTask(JSON.parse(e.data));
    renderTasks();
    refreshProjects();
  });
  es.addEventListener("log", (e) => {
    const { runId, done } = JSON.parse(e.data);
    if (done) {
      const entry = state.logs.get(runId);
      if (entry) entry.done = false; // one more pull to catch the tail
    }
    if (document.querySelector(`[data-log="${runId}"]`)) pullLog(runId);
  });
  es.addEventListener("memory", () => {
    Promise.all([loadConfig(), loadProjects()]).then(loadIssues).catch(() => {});
  });
  es.addEventListener("project", () => refreshProjects());
  es.addEventListener("settings", (e) => {
    if (state.config) state.config.settings = JSON.parse(e.data);
    renderTasks();
  });
  es.onerror = () => {
    conn.textContent = "reconnecting";
    conn.className = "conn is-down";
    es.close();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  try {
    await loadConfig();
    await Promise.all([loadProjects(), loadTasks()]);
    await loadIssues();
    renderDetail();
  } catch (err) {
    toast(`Failed to load board: ${err.message}`, { error: true, ms: 10000 });
  }
  connect();
  setInterval(() => {
    // keep relative timestamps honest without re-fetching
    for (const el of document.querySelectorAll(".when[title], .history time[title]")) el.textContent = ago(el.title);
  }, 30000);
})();
