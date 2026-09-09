# Design

Visual system for the AMP Board (`board/public`). Plain CSS custom properties, no framework, no CDN, no web fonts. The tokens in `board/public/styles.css` are the source of truth and this file records them. `board/design/` holds the original mockups and their pre-build colour spec; it is a historical package, not a mirror, and its values no longer match the code.

## Theme

Restrained developer tool. Neutral greys, one blue accent for actions and selection, a fixed semantic set for task states. Theme follows the OS via `prefers-color-scheme`; both themes ship first-class.

## Color

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` | `#fafafa` | `#0d1117` |
| `--surface` | `#ffffff` | `#161b22` |
| `--surface-2` (column headers, inputs) | `#f4f4f5` | `#1c2128` |
| `--border` (decorative rules) | `#e5e7eb` | `#30363d` |
| `--border-strong` (control edges) | `#848d99` | `#656c76` |
| `--text` | `#1b1b1d` | `#f0f6fc` |
| `--text-2` (secondary) | `#3f4650` | `#c9d1d9` |
| `--muted` | `#5f6f86` | `#8b949e` |
| `--accent` | `#2360e8` | `#58a6ff` |
| `--accent-ink` (text on accent) | `#ffffff` | `#0d1117` |
| `--terminal-bg` (log tail) | `#0f172a` | `#010409` |
| `--terminal-muted` (log placeholder) | `#73839b` | `#8b949e` |

Status colours (`--st-<name>` foreground, `--st-<name>-bg` tint):

| State | Light | Dark |
| --- | --- | --- |
| queued / done | `#475569` | `#9fa8b3` |
| running | `#1a57de` | `#61afff` |
| blocked | `#a84800` | `#d89f2b` |
| failed / reject | `#c90011` | `#ff7b72` |
| finished | `#037169` | `#7ee787` |
| reviewing / approval | `#7e22ce` | `#bc8cff` |
| approve | `#007533` | `#7ee787` |

Memory type tags (intent, facts, pattern, invalidation, discovery, events, lifefact) use the same tint technique with subdued hues; they are labels, not calls to action.

### The contrast rule these values satisfy

A status pill is not always on the same ground. In a task card it sits on `--surface`; in the project column it sits on a row that may be plain, hovered (`--surface-2`), or selected (`--accent-soft` over `--surface`). Every `--st-*` foreground clears 4.5:1 against its own tint on **all three**, and the selected row is the strictest of them, so it is what sets these values. Changing a status colour means re-checking all three grounds, not just the card.

`--border` and `--border-strong` are not interchangeable. `--border` draws decorative rules between columns and cards and is exempt from contrast minimums. `--border-strong` is the only thing that marks the edge of an input, a select, or a default button, so it carries WCAG 1.4.11 and must clear 3:1 against both `--surface` and `--surface-2`.

`--muted` is a page-surface colour and fails on the terminal ground. Text on `--terminal-bg` uses `--terminal-fg` or `--terminal-muted`.

## Typography

One family: the system UI stack (`-apple-system, "SF Pro Text", Inter, "Segoe UI", system-ui, sans-serif`). Monospace for paths, ids, issue numbers, weights and log output (`ui-monospace, "SF Mono", Menlo, monospace`).

Fixed rem scale: 11 px labels, 12 px meta and table rows, 13 px body and controls, 14 px card titles, 15 px column titles. Line-height 1.45 for body, 1.35 for compact rows. Weights 400 / 500 / 600 only.

### Heading levels in the detail pane

The page is an `h1`, a column head is an `h2`, the open issue's title is an `h3`, and an OKF section name is an `h4`. A memory body's own headings render below that, starting at `h5`.

They are re-levelled per block rather than by a fixed offset. Authors start at whatever level they like, so a block whose shallowest heading is `##` still lands on `h5`, with its deeper headings following underneath. A fixed offset suited one block and skipped a level in the next. The three body levels compress into `h5` and `h6`, which is the cost of nesting a whole document inside a pane, and is preferable to the levels rendering identically as they used to.

## Spacing & Shape

2 px base unit: 2 / 4 / 6 / 8 / 10 / 12 / 16 / 24, with 8 px carrying most of the layout. A 4 px base is too coarse for a board this dense; the half-steps are load-bearing, not sloppiness. Values off that scale exist only as optical nudges (a checkbox baseline, inline code padding), never as layout.

Spacing carries hierarchy, so it is deliberately uneven. Within a group, 6 px. Between groups, 12 px. That one contrast is what separates a task card's identity from its evidence from its actions.

Cards and panels radius 6 px, pills 999 px, buttons and inputs 4 px. One-pixel borders in `--border`; no drop shadows except the popover and the toast, the only two elements that genuinely float.

## Components

- **Column**: sticky title bar with count, independently scrolling body, 1 px right border, 6 px drag handle with a 24 px grab area.
- **Project row**: a wrapper holding two sibling buttons, one selecting the project and one opening its settings, never nested; selected state = accent text + `--accent-soft` fill + a 2 px inset accent edge.
- **Issue row**: `#n` mono, weight bar (2 px track, accent fill proportional), title, comment count, date. `aria-current` marks the selected one.
- **New task form**: collapsed to a single `+ New task` row by default, since the Waiting column is for watching work rather than for the form that starts it. The choice persists, and creating a task from an issue opens it.
- **Task card**: three groups, 12 px apart. Identity (title, status pill, chips, age), evidence (summary, reviewer notes, log, status notes), actions. History sits below a hairline rule as provenance.
- **Note block**: a tinted block with no border and no radius competing with the card's own. The bold lead-in says which note it is; the box does not.
- **Status pill**: 11 px, 600, tinted background, 999 px radius, dot before the label; running/reviewing dots spin. It is a label, not a live region, and it reports the task's own state — never a judgement something else made about the task.
- **Log tail**: `--terminal-bg`, 12 px mono, 6 lines visible, auto-scrolls to bottom.
- **Buttons**: primary (accent fill), default (surface + border), danger (failed colour text), all 28 px tall; small variants 24 px.

### The issue column's split

The list and the detail pane share the column by content, not by a fixed fraction. The detail pane sizes to what it holds and stops at 55 % of the column (45 % below 1180 px), scrolling past that. With nothing selected it is one empty-state block tall and the list keeps the column.

## Motion

150–200 ms `cubic-bezier(0.22, 1, 0.36, 1)` on hover/focus/background changes. A 900 ms linear spin on running/reviewing dots. Cards do not animate in. `prefers-reduced-motion: reduce` removes all transitions and the spin.

## Words

The reader is the person who built this and runs the agents it drives. Domain terms are not jargon to them: `REGION`, OKF body, weight, place, the `rxai-amp` skill all stay. What gets simplified is everything that is not domain vocabulary.

One word per thing, throughout:

| Use | Not |
| --- | --- |
| Create (a task) | Add, New |
| Assign (a task to an agent) | Give, Send |
| Delete | Remove, Trash |
| Comment (a reply on an issue) | Reply, Response |
| Settings | Preferences, Options |

Three rules the copy is held to:

1. **A control says what happens.** `Create and assign`, `Show log` / `Hide log`, `Confirm reject`. Never `OK`, `Submit`, or a bare noun like `Log`.
2. **A fallback is a sentence, not a shrug.** When an agent returns nothing, the card says "The agent finished without writing a summary", not `(none)`. The empty case is still information.
3. **Colour never contradicts the words.** A card's pill takes the colour of the task's own state. The reviewer's verdict is evidence and reads in the note, because a green pill on a card that is waiting for you says the opposite of what the card means.

## Fitting the window

The board is a five-column desktop tool. It adapts by lowering the floor under each column, never by swapping in a fixed template.

| Window | Column floors (1–5) | Board needs |
| --- | --- | --- |
| above 1340 px | 220 / 300 / 260 / 260 / 260 | 1324 px |
| up to 1340 px | 196 / 268 / 240 / 232 / 232 | 1192 px |
| up to 1180 px | 172 / 244 / 224 / 216 / 216 | 1096 px |

Below roughly 1100 px the board scrolls horizontally, which is the honest answer for five columns. Two rules matter more than the numbers. A drag writes `--col-N` inline on `:root`, and an inline style outranks every rule above, so a width the user chose survives at any window size. And a column's own width, not the window's, decides what fits inside it, so anything that reflows within a column is a container query on `.col-body` rather than a media query.

## Target sizes

Every interactive target is at least 24×24 CSS px (WCAG 2.2 SC 2.5.8), which is not the same as every element being that big. Density is preserved by growing the target and leaving the visible box alone:

- The column divider stays a hairline; its `::after` widens the grab area to 24 px. It overlaps a little of each neighbour's indent, where a press that never becomes a drag does nothing at all.
- An interactive chip keeps the 18 px box of the static chips beside it and grows its target vertically into the card's own margins.
- Static chips and pills are labels, not targets, and stay at 18 px. If it is 24 px, it is clickable; if it is not, it is not.

A coarse pointer widens the divider further, and `@media (hover: none)` reveals the controls that hover otherwise uncovers.
