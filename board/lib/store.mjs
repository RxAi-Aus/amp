// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * store.mjs — ~/.rxai-amp/board.json persistence for the AMP Board.
 *
 *   • every mutation goes through reduce() then save()
 *   • save = write board.json.tmp, then renameSync (atomic on POSIX)
 *   • before a mutation the file mtime is compared with the last-saved mtime;
 *     when another process wrote in between, the file is reloaded and the
 *     action is replayed on the fresh state
 *   • cross-process claims (server vs. `cli next`) take board.json.lock
 *     (created with `wx`), held only for the claim/save window, stale after 10 s
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { BOARD_SCHEMA, emptyState, nowIso, reduce } from "./state.mjs";

export const LOCK_STALE_MS = 10_000;

export class LockBusyError extends Error {
  constructor(file) {
    super(`board lock busy: ${file}`);
    this.name = "LockBusyError";
    this.status = 503;
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function loadState(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${err.message}`);
  }
  if (!parsed || parsed.schema !== BOARD_SCHEMA) {
    throw new Error(`unexpected schema in ${file}: ${parsed && parsed.schema} (want ${BOARD_SCHEMA})`);
  }
  const base = emptyState(parsed.updatedAt);
  return {
    ...base,
    ...parsed,
    settings: { ...base.settings, ...(parsed.settings || {}) },
    projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {},
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
  };
}

export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return mtimeOf(file);
}

/**
 * Take board.json.lock around fn(). Synchronous by design: every store
 * operation is synchronous, so the window is milliseconds.
 */
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt++) {
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const age = Date.now() - (mtimeOf(lock) ?? Date.now());
      if (age > LOCK_STALE_MS) {
        try {
          unlinkSync(lock);
        } catch {
          /* raced with the holder releasing it */
        }
        continue;
      }
      throw new LockBusyError(file);
    }
  }
  if (fd === null) throw new LockBusyError(file);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
  } catch {
    /* lock content is advisory */
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Open (or lazily create) the board store.
 *   store.state             current in-memory state (fresh after reload())
 *   store.reload()          re-read from disk when it changed under us
 *   store.dispatch(action)  reload-if-changed → reduce → save; returns new state
 *   store.dispatchMany([..])same, one save at the end
 *   store.locked(fn)        run fn under board.json.lock (fn may dispatch)
 */
export function openStore(file, { now = nowIso } = {}) {
  let state = loadState(file) || emptyState(now());
  let savedMtime = mtimeOf(file);

  function reload() {
    const current = mtimeOf(file);
    if (current !== savedMtime) {
      const fresh = loadState(file);
      if (fresh) state = fresh;
      savedMtime = current;
      return true;
    }
    return false;
  }

  function dispatchMany(actions) {
    reload();
    let next = state;
    for (const action of actions) next = reduce(next, { at: now(), ...action });
    if (next !== state) {
      state = next;
      savedMtime = saveState(file, state);
    }
    return state;
  }

  return {
    file,
    get state() {
      return state;
    },
    reload,
    dispatch: (action) => dispatchMany([action]),
    dispatchMany,
    locked: (fn) => withLock(file, fn),
    /** Force a save of the current state (used after recovery). */
    persist() {
      savedMtime = saveState(file, state);
      return state;
    },
  };
}
