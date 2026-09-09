# Product

Scope: the AMP Board UI under `board/` (the only user-facing interface in this repository). Derived from `board/design/brief.md`; the rest of the repo is a protocol + scripts with no UI.

## Register

product

## Users

One developer (the repo owner) who runs several software projects and delegates work to AI coding agents (claudecowork, codex, agy, hermes, openclaw). They sit at a 1440×900 desktop with mouse and keyboard, glancing across the board many times a day while agents run in the background. The job: see every project's memory at a glance, pick the right memory issue to act on, queue a task for an agent, watch it run, get it reviewed, and approve or send it back.

## Product Purpose

A local, single-user web tool that puts a five-column workflow (Projects → Memory issues → Waiting → Finished → Approval) on top of RxAi AMP shared memory. Success: the user can triage all fourteen projects in one screen, never has to read a log file by hand to know what an agent did, and every approval decision is made with the reviewer's evidence in view. Memory issues stay data; the board never writes them.

## Brand Personality

Calm, precise, dense. A developer tool in the lineage of Linear and GitHub Projects: information density is a feature, chrome is minimal, state is always legible. Nothing sells; everything informs.

## Anti-references

- Trello / kanban-with-stickers: playful cards, avatars, colour-coded labels as decoration.
- Marketing-page instincts: hero imagery, gradients, illustrations, oversized headings.
- Dashboard theatre: big-number metric tiles, spinners in the middle of content, orchestrated load animations.

## Design Principles

1. **Five columns, one glance.** Every state a task can be in must be readable without opening anything.
2. **Evidence beside every decision.** Summaries, posted issue numbers, reviewer notes and log tails sit on the card that asks for the click.
3. **Memory is data.** Issue bodies render through a whitelist; nothing from the memory repo becomes live UI.
4. **Status is colour, colour is status.** One accent for actions and selection; a fixed semantic set for task states; no other colour.
5. **Quiet when idle, explicit when running.** Motion only signals activity (a running spinner, a growing log); nothing moves otherwise.

## Accessibility & Inclusion

WCAG AA contrast for text and every status colour on both light and dark themes, measured against every ground an element can land on rather than one. Theme follows the OS (`prefers-color-scheme`). All controls are real buttons and inputs with labels, and every interactive target is at least 24×24 CSS px even where its visible box is smaller. Task state is announced once, through a single live region, rather than by every status pill. `prefers-reduced-motion` removes the spinner and transitions. The five columns fit down to about 1100 px before scrolling, and widths the user drags are kept at every window size. Nothing depends on hover alone: on a device that cannot hover, hover-revealed controls are always shown.
