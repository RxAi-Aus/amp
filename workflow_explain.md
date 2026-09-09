# How the Two Robots Work — GitHub Actions Explained Simply

This document explains the two GitHub Actions workflows that power the Agent
Memory system. Written in plain language so anyone can understand it.

---

## The Setup

When you push code to GitHub, it lives in a folder on the internet. GitHub has
**free robots** called **Actions** that can run code for you automatically — you
don't need your own computer to be on. You just tell them *when* to wake up and
*what* to do, using a recipe file (the `.yml` files in `.github/workflows/`).

These robots are **already deployed** the moment the `.yml` files exist in the
`.github/workflows/` folder on GitHub. That's it. No extra button. No server to
set up. Push the files → robots are live.

---

## Robot 1: The Tracker 📋

**File:** `.github/workflows/not-indexed-tracker.yml`

**When does it wake up?** Every time someone (human or agent) opens a new issue.

**What does it do?** Think of it like a receptionist at a hotel:

1. 🏨 A new guest (issue) walks in the door
2. 📝 The receptionist writes their name on a sticky note (`not_indexed.md`)
3. ✅ Done. Goes back to sleep.

### What the robot actually runs

| Step | What it does | In simple terms |
|------|-------------|-----------------|
| `actions/checkout` | Downloads your repo files onto the robot's temporary computer | Opens the notebook |
| `setup-node` + `npm ci` | Installs Node.js and your project's tools | Gets a pen ready |
| `npm run build` | Compiles TypeScript → JavaScript | Sharpens the pen |
| `node dist/track_not_indexed.js` | Reads the issue title, number, and date → adds one line to `not_indexed.md` | Writes the guest's name on the sticky note |
| `git add` + `git commit` + `git push` | Saves the updated file back to GitHub | Sticks the note on the wall so everyone can see it |

**How fast?** ~30 seconds. The guest walks in, name goes on the wall, done.

**Safety lock:** If 5 issues arrive at the same time, they line up one by one —
no two robots try to write the sticky note at the same time.

```yaml
concurrency:
  group: not-indexed-update
  cancel-in-progress: false    # queue them, don't cancel
```

---

## Robot 2: The Organiser 🗂️

**File:** `.github/workflows/index-scheduler.yml`

**When does it wake up?** Every 6 hours, like clockwork — midnight, 6am, noon,
6pm UTC. You can also wake it up manually from the Actions tab.

```yaml
on:
  schedule:
    - cron: '0 0,6,12,18 * * *'   # every 6 hours
  workflow_dispatch:                # manual trigger button
```

**What does it do?** Think of it like a librarian who reorganises the bookshelf:

1. 📚 Reads **every single issue** and all their comments
2. ⚖️ Calculates a "trust score" (weight) for each one:
   - Things that **worked** (Outcome: success) → score goes **up** (+0.30)
   - Things that **failed** (Outcome: failure) → score goes **down** (-0.20)
   - Old stuff naturally **fades** a tiny bit each cycle (decay)
3. 📖 Rewrites the table of contents (`INDEX.md`) and the chapter pages
   (`REGION-*.md`) with everything sorted by score — best stuff on top
4. 🧹 Clears the sticky notes (`not_indexed.md`) because everything is now in
   the proper index
5. 💾 Saves everything back to GitHub

### What the robot actually runs

| Step | What it does | In simple terms |
|------|-------------|-----------------|
| `actions/checkout` | Downloads your repo | Opens the library |
| `setup-node` + `npm ci` + `build` | Sets up tools | Gets supplies ready |
| `node dist/compile_index.js` | The big brain step — reads all issues from GitHub API, calculates weights, writes INDEX.md + REGION files | Reorganises every book on every shelf |
| `git add` + `git commit` + `git push` | Saves everything back | Puts the new catalogue on the front desk |

**Safety lock:** If you manually trigger it while a scheduled run is already
happening, the running one finishes first — they don't fight.

```yaml
concurrency:
  group: index-compile
  cancel-in-progress: false    # let the running one finish
```

---

## How to "deploy" them

Here's the thing a lot of people don't realise: **there is nothing extra to
deploy**. These files deploy themselves.

```
Your computer                         GitHub
    │                                    │
    │  git push (with .yml files)  ──►   │
    │                                    │  ✅ GitHub sees .yml files
    │                                    │  ✅ Robots are now active
    │                                    │  ✅ Tracker listens for issues
    │                                    │  ✅ Scheduler sets its 6-hour alarm
```

The only things you need to make sure:

1. ✅ The `.yml` files are in `.github/workflows/` (they already are in this repo)
2. ✅ Workflow permissions are set to **Read and write** in your repo's
   Settings → Actions → General → Workflow permissions
3. ✅ The repo is pushed to GitHub

**That's it. The robots are running 24/7, for free** (on public repos, or within
the 2,000 free minutes/month on private repos).

---

## What each robot writes to (and how they don't fight)

```
                    ┌──────────────────┐
  New issue ──────► │ Tracker robot    │ ──► appends 1 line to not_indexed.md
                    └──────────────────┘

  Every 6 hours ──► ┌──────────────────┐     ┌─────────────────────────┐
                    │ Organiser robot  │ ──► │ Rewrites INDEX.md       │
                    │                  │     │ Rewrites REGION-*.md    │
                    │                  │     │ Updates weights.json    │
                    │                  │     │ Resets not_indexed.md   │
                    └──────────────────┘     └─────────────────────────┘
```

The Tracker only touches `not_indexed.md`. The Organiser rewrites everything
including `not_indexed.md` (it clears it after absorbing the contents). Because
the Organiser only runs every 6 hours, the two robots almost never overlap.

---

## The even simpler version

> You wrote two recipe cards and put them in a special drawer
> (`.github/workflows/`). GitHub's kitchen staff found the recipes and now they
> cook automatically — one every time a new order comes in, one every 6 hours to
> clean up. You don't need to tell them to start. They just... do it.

---

## Key terms

| Term | What it means |
|------|--------------|
| **GitHub Actions** | Free robots that run code on GitHub's computers |
| **Workflow** | A recipe file (`.yml`) that tells the robot when and what to run |
| **Trigger** | The event that wakes the robot up (new issue, timer, manual click) |
| **Runner** | The temporary computer the robot uses (`ubuntu-latest`) |
| **Concurrency group** | A queue so robots don't fight over the same file |
| **`GITHUB_TOKEN`** | A password GitHub automatically gives the robot so it can read/write your repo |
| **Cron** | A timer format — `0 0,6,12,18 * * *` means "at minute 0 of hours 0, 6, 12, 18, every day" |

---

For the full technical specification, see [PROTOCOL.md](./PROTOCOL.md).
For installation instructions, see [README.md](./README.md).
