# OKF.md — Open Knowledge Format: Authoring Checklist + Agent Read Runbook

**Purpose.** This document is the actionable companion to the **Open Knowledge Format (OKF) v0.1** specification. It has two parts:

- **Part A — Authoring checklist:** what must be done to produce OKF-standard files (so a document such as `Australia.md` can be authored and will pass conformance).
- **Part B — Agent read/parse runbook:** the exact steps a consumption agent follows to read and traverse an OKF-standard file/bundle (e.g., `Australia.md`).

**Source of truth.** Every rule below is traceable to a section of the spec. When this document and the spec disagree, the spec wins.
Spec: <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md> (OKF v0.1 — Draft).

> **Scope note.** This file deliberately encodes **only** what the OKF v0.1 spec states. Anything the spec leaves to the producer is marked *(producer's choice)*. Nothing here invents required fields, types, or tooling beyond the spec.

---

## 0. What OKF is (one paragraph)

OKF is a directory of UTF-8 Markdown files, each with a YAML frontmatter block, used to represent *knowledge* (metadata, context, curated insight). It is intentionally minimal: no schema registry, no central authority, no required tooling — "if you can `cat` a file you can read OKF; if you can `git clone` a repo you can ship it." A single knowledge file (a **Concept**, e.g., `Australia.md`) lives inside a **Knowledge Bundle** (the directory tree that is the unit of distribution). *(Spec §0–§3.)*

**Key terms** *(§2):* **Bundle** = the directory tree (unit of distribution). **Concept** = one Markdown document. **Concept ID** = the file path within the bundle minus `.md` (e.g., `regions/australia.md` → `regions/australia`). **Frontmatter** = the `---`-delimited YAML at the top. **Body** = everything after it. **Link** = a Markdown link between concepts. **Citation** = a link to an external source backing a claim.

---

# Part A — Authoring checklist (produce OKF-standard files)

Work top-down: bundle → concept document → frontmatter → body → links → index/log → conformance gate.

### A1. Bundle structure *(§3)*
- [ ] Place concepts as `.md` files in a directory tree. Subdirectories group concepts *(producer's choice of organization — the structure is independent of the domain)*.
- [ ] Decide distribution form: a **git repo** (recommended — gives history, attribution, diffs), a tarball/zip, or a subdirectory of a larger repo.
- [ ] (Optional) Add a bundle-root `index.md` for progressive disclosure (see A6).
- [ ] (Optional) Add `log.md` files to record change history (see A7).

A minimal bundle looks like *(Spec Appendix A)*:
```
my_bundle/
├── index.md            # optional: directory listing
├── datasets/
│   ├── index.md
│   └── sales.md
└── tables/
    ├── index.md
    ├── orders.md
    └── customers.md
```
For the worked example, `Australia.md` would simply be one concept document at a path you choose (e.g., bundle root, or `regions/australia.md`).

### A2. Reserved filenames *(§3.1)* — do NOT use these for concept documents
| Filename   | Meaning                          |
|------------|----------------------------------|
| `index.md` | Directory listing (see A6).       |
| `log.md`   | Update history (see A7).          |

- [ ] Confirm your concept filename is **not** `index.md` or `log.md`. (`Australia.md` is fine.)

### A3. Concept document — required structure *(§4)*
Every concept file has exactly two parts:
- [ ] **(1)** A YAML **frontmatter block**, opened by `---` on its own line at the very start of the file and closed by `---` on its own line.
- [ ] **(2)** A Markdown **body** after the closing `---`.
- [ ] File encoding is UTF-8.

### A4. Frontmatter fields *(§4.1)*
**Required:**
- [ ] `type:` — a short, descriptive, self-explanatory string identifying the kind of concept (e.g., `BigQuery Table`, `API Endpoint`, `Metric`, `Playbook`, `Reference`). **Not** registered centrally; pick a clear value. **This is the only mandatory field.**

**Recommended (in priority order):**
- [ ] `title:` — human-readable display name (consumers may otherwise derive it from the filename).
- [ ] `description:` — a single summarizing sentence (used by index generators, search snippets, previews).
- [ ] `resource:` — a canonical URI for the underlying asset, **if** the concept describes a physical resource (omit for purely abstract concepts).
- [ ] `tags:` — a YAML list of short strings for cross-cutting categorization.
- [ ] `timestamp:` — ISO 8601 datetime of the last meaningful change.

**Extensions:**
- [ ] You MAY add any additional producer-defined keys. Keep them self-explanatory.

Illustrative frontmatter for `Australia.md` *(structure only — fill with vetted content; values shown are placeholders, not asserted facts)*:
```markdown
---
type: Reference
title: Australia
description: <one-sentence summary of what this concept covers>
resource: <canonical URI, if one applies — else omit>
tags: [<tag>, <tag>]
timestamp: 2026-06-22T00:00:00Z
---

<body — see A5>
```

### A5. Body conventions *(§4.2)*
- [ ] Body is standard Markdown. **Favor structural Markdown** — headings, lists, tables, fenced code blocks — over freeform prose (aids both humans and agent retrieval).
- [ ] No body section is required. Use these **conventional** headings when applicable:

| Heading       | Use for                                              |
|---------------|------------------------------------------------------|
| `# Schema`    | Structured description of an asset's columns/fields. |
| `# Examples`  | Concrete usage examples (often fenced code blocks).  |
| `# Citations` | External sources backing claims (see A8).            |

### A6. Index files *(§6)* — optional, per directory
- [ ] An `index.md` MAY appear in any directory (including the bundle root) to enumerate that directory's contents (progressive disclosure).
- [ ] Index files contain **no frontmatter** — **except** the bundle-root `index.md`, which MAY carry a single frontmatter key `okf_version: "0.1"` *(§11)*.
- [ ] Body = one or more `#` sections, each a list of `* [Title](relative-url) - short description` entries. Descriptions SHOULD reuse the linked concept's `description`.
- [ ] You MAY auto-generate `index.md`; consumers MAY synthesize one when absent.

### A7. Log files *(§7)* — optional, per level
- [ ] A `log.md` MAY appear at any level to record changes for that scope.
- [ ] Format: date-grouped entries, **newest first**, with `## YYYY-MM-DD` headings (ISO 8601 date form is **required** when used).
- [ ] Each entry is prose; a leading bold word (`**Update**`, `**Creation**`, `**Deprecation**`, …) is a convention, not a requirement.

### A8. Cross-linking & citations *(§5, §8)*
- [ ] Link concepts with standard Markdown links. **Prefer absolute (bundle-relative) links** beginning with `/` (stable under moves), e.g. `[customers](/tables/customers.md)`; relative links like `./other.md` are also valid.
- [ ] A link asserts an *untyped relationship*; the **kind** of relationship is conveyed by surrounding prose, not the link.
- [ ] Broken links are **allowed** (they may represent not-yet-written knowledge) — do not treat them as errors.
- [ ] When the body makes externally-sourced claims, list them under a final `# Citations` heading, numbered `[1] [label](url)`. Citations MAY be absolute URLs, bundle-relative paths, or paths into a `references/` subdirectory.

### A9. Conformance gate *(§9)* — must pass before publishing
A bundle is **conformant** with OKF v0.1 if and only if:
- [ ] **(1)** Every non-reserved `.md` file in the tree has a **parseable YAML frontmatter block**.
- [ ] **(2)** Every frontmatter block has a **non-empty `type`** field.
- [ ] **(3)** Every reserved file (`index.md`, `log.md`) follows §6 / §7 structure when present.

Everything else in the spec is **soft guidance** — a conformant bundle must NOT be rejected for missing optional fields, unknown `type` values, unknown extra keys, broken links, or missing `index.md` files.

### A10. Versioning *(§11)* — optional
- [ ] To declare the targeted OKF version, add `okf_version: "0.1"` to the **bundle-root `index.md`** frontmatter (the only place frontmatter is allowed in an `index.md`).

---

# Part B — Agent read/parse runbook (consume an OKF file like `Australia.md`)

This is the deterministic procedure a consumption agent should follow. The guiding principle from the spec is **permissive consumption**: read best-effort, tolerate gaps, and **never refuse** a bundle over soft-guidance violations *(§9)*.

### B1. Establish the bundle root and version
1. Identify the **bundle root** (the top of the directory tree, or the repo/archive root). Concept IDs and absolute links (`/…`) are resolved relative to this root *(§2, §5.1)*.
2. If a root `index.md` exists, read its frontmatter for `okf_version`. If the version is unknown to you, **attempt best-effort consumption anyway** — do not refuse *(§11)*.

### B2. Progressive disclosure before deep reading *(§6)*
3. If `index.md` is present (root or directory level), read it **first** to enumerate available concepts and their descriptions, so you can decide what to open without scanning every file. If no `index.md` exists, you MAY synthesize one by scanning sibling files' frontmatter.

### B3. Open a concept (e.g., `Australia.md`) and split it
4. Read the file as UTF-8. Detect the frontmatter block: it starts with `---` on the first line and ends at the next line that is exactly `---`.
5. Split into **frontmatter** (the YAML between the fences) and **body** (everything after the closing fence) *(§4)*.
6. Compute the **Concept ID** = file path within the bundle minus the `.md` suffix (e.g., `regions/australia.md` → `regions/australia`) *(§2)*.

### B4. Parse frontmatter (tolerant)
7. Parse the YAML. Require a **non-empty `type`** — this is the one field you can rely on; use it for routing/filtering/presentation *(§4.1, §9)*.
8. If `type` is **unknown to you**, treat the concept as a **generic concept** — do **not** drop it *(§4.1)*.
9. Read recommended fields when present: `title` (else derive a title from the filename), `description`, `resource` (canonical URI of the underlying asset; absent ⇒ abstract concept), `tags`, `timestamp`.
10. **Preserve unknown/extra keys** verbatim if you round-trip the document; never reject a document for unrecognized fields *(§4.1)*.

### B5. Read the body structurally *(§4.2)*
11. Parse the Markdown body. Treat the conventional headings specially when present: `# Schema` (field/column structure), `# Examples` (usage), `# Citations` (sources). Absence of any section is normal.

### B6. Traverse relationships *(§5)*
12. Collect Markdown links in the body. Resolve **absolute** links (leading `/`) against the bundle root; resolve **relative** links (`./…`, `../…`) against the current file's directory.
13. Treat each link as a **directed, untyped edge** to another concept; infer the relationship's meaning from surrounding prose, not the link itself.
14. If a link target does not exist, **tolerate it** (not-yet-written knowledge) — log/skip, do not error *(§5.3)*.

### B7. Use logs and citations as context *(§7, §8)*
15. If a `log.md` exists at the relevant level, use its newest-first `## YYYY-MM-DD` entries for recency/change context.
16. Resolve `# Citations` entries as supporting evidence; they may be external URLs, bundle-relative paths, or `references/` concepts.

### B8. Consumption invariants (do not violate) *(§9)*
- Do **not** reject a bundle/document for: missing optional frontmatter fields, unknown `type`, unknown extra keys, broken cross-links, or missing `index.md`.
- The **only** hard requirements you may enforce are §9(1)–(3): parseable frontmatter, non-empty `type`, and correct structure of any `index.md`/`log.md`.

### B9. Worked example — reading `Australia.md`
1. Locate bundle root; read root `index.md` (note `okf_version` if present).
2. Open `Australia.md`; split frontmatter/body; Concept ID = `Australia` (or `regions/australia` if nested).
3. From frontmatter: read `type` (required) → route accordingly; read `title`/`description`/`tags`/`timestamp`/`resource` if present; keep any extra keys.
4. Parse body; capture `# Schema`/`# Examples`/`# Citations` if present.
5. Follow links (e.g., `/regions/...` resolves from bundle root); record edges; tolerate any broken targets.
6. Surface the concept to the caller with its `type`, title, description, body, outbound links, and citations — without having rejected anything for soft-guidance gaps.

---

## Appendix — Quick conformance self-test (for `Australia.md` or any concept)
- [ ] First line is `---`; a later line is exactly `---` (parseable frontmatter). *(§9.1)*
- [ ] Frontmatter has a non-empty `type:`. *(§9.2)*
- [ ] Filename is not a reserved name used as a concept. *(§3.1)*
- [ ] If the file is `index.md`/`log.md`, it follows §6/§7 structure. *(§9.3)*
- [ ] (Recommended) `title`, `description`, `timestamp` present; links prefer the absolute `/…` form; citations under `# Citations`.

*Grounded in OKF v0.1 (Draft). Section references (§) point to the spec. Items marked "producer's choice" are intentionally unspecified by OKF.*
