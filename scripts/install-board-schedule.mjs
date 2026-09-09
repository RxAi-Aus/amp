#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * install-board-schedule.mjs — launchd installer for AMP Board pull mode.
 *
 *   npm run board:schedule -- --agent codex --every 30m [--role reviewer]
 *                             [--port 7345] [--uninstall] [--dry-run]
 *
 * Writes ~/Library/LaunchAgents/com.rxai.amp.board.<agent>[.reviewer].plist
 * that runs `node board/cli.mjs next --agent <agent>` every --every
 * (StartInterval). The poller is deterministic Node: with an empty queue it
 * prints "nothing to do" and exits without starting any agent, so the idle
 * cost is zero and there is no Rule 14 loop risk.
 *
 * launchd has a minimal PATH, so the plist carries one that includes
 * ~/.local/bin, /opt/homebrew/bin and the directory of the node binary
 * running this installer (nvm installs live there). Follows the
 * hooks:install:* pattern: idempotent, --dry-run prints without writing.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

/** "30m" | "1h" | "90s" | "600" → seconds (minimum 60). */
export function parseEvery(value) {
  const m = String(value ?? "").trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) throw new Error(`--every must look like 30m, 1h or 90s (got "${value}")`);
  const n = Number(m[1]);
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
  const seconds = n * unit;
  if (seconds < 60) throw new Error("--every must be at least 60 seconds");
  return seconds;
}

export function labelFor(agent, role) {
  return `com.rxai.amp.board.${agent}${role === "reviewer" ? ".reviewer" : ""}`;
}

export function plistPath(agent, role, home = homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${labelFor(agent, role)}.plist`);
}

function xml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPlist({ agent, role = "worker", everySeconds, port = null, home = homedir(), nodeBin = process.execPath, root = repoRoot }) {
  const label = labelFor(agent, role);
  const args = [nodeBin, path.join(root, "board", "cli.mjs"), "next", "--agent", agent];
  if (role === "reviewer") args.push("--role", "reviewer");
  if (port) args.push("--port", String(port));
  const logFile = path.join(home, ".rxai-amp", "board-runs", `schedule-${agent}${role === "reviewer" ? "-reviewer" : ""}.log`);
  const pathEnv = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    path.dirname(nodeBin),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key><string>${xml(root)}</string>`,
    `  <key>StartInterval</key><integer>${everySeconds}</integer>`,
    "  <key>RunAtLoad</key><false/>",
    `  <key>StandardOutPath</key><string>${xml(logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(logFile)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    `    <key>PATH</key><string>${xml(pathEnv)}</string>`,
    `    <key>HOME</key><string>${xml(home)}</string>`,
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function launchctl(args, { dryRun }) {
  const cmd = `launchctl ${args.join(" ")}`;
  if (dryRun) {
    process.stdout.write(`[dry-run] ${cmd}\n`);
    return true;
  }
  try {
    execFileSync("launchctl", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    process.stdout.write(`ran: ${cmd}\n`);
    return true;
  } catch (err) {
    const msg = (err.stderr || err.message || "").toString().trim();
    process.stdout.write(`(${cmd} → ${msg || "non-zero exit"})\n`);
    return false;
  }
}

export function main(argv = process.argv.slice(2)) {
  const agent = flag(argv, "--agent");
  if (!agent || !/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) {
    process.stderr.write("usage: install-board-schedule.mjs --agent <name> [--every 30m] [--role reviewer] [--port N] [--uninstall] [--dry-run]\n");
    return 2;
  }
  const role = flag(argv, "--role", "worker") === "reviewer" ? "reviewer" : "worker";
  const dryRun = argv.includes("--dry-run");
  const uninstall = argv.includes("--uninstall");
  const home = process.env.AMP_BOARD_SCHEDULE_HOME || homedir();
  const file = plistPath(agent, role, home);
  const domain = `gui/${process.getuid ? process.getuid() : 501}`;

  if (uninstall) {
    launchctl(["bootout", domain, file], { dryRun });
    if (existsSync(file)) {
      if (dryRun) process.stdout.write(`[dry-run] would remove ${file}\n`);
      else {
        unlinkSync(file);
        process.stdout.write(`removed ${file}\n`);
      }
    } else process.stdout.write(`nothing installed at ${file}\n`);
    return 0;
  }

  let everySeconds;
  try {
    everySeconds = parseEvery(flag(argv, "--every", "30m"));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const port = flag(argv, "--port") ? Number(flag(argv, "--port")) : null;
  const plist = buildPlist({ agent, role, everySeconds, port, home });

  if (dryRun) {
    process.stdout.write(`[dry-run] would write ${file}:\n${plist}`);
    launchctl(["bootout", domain, file], { dryRun });
    launchctl(["bootstrap", domain, file], { dryRun });
    return 0;
  }

  mkdirSync(path.dirname(file), { recursive: true });
  const existed = existsSync(file) && readFileSync(file, "utf8") === plist;
  writeFileSync(file, plist);
  mkdirSync(path.join(home, ".rxai-amp", "board-runs"), { recursive: true, mode: 0o700 });
  process.stdout.write(`${existed ? "unchanged" : "wrote"} ${file} (every ${everySeconds}s, ${role} ${agent})\n`);
  launchctl(["bootout", domain, file], { dryRun }); // ignore failure: not loaded yet
  if (!launchctl(["bootstrap", domain, file], { dryRun })) {
    process.stderr.write("launchctl bootstrap failed — the plist is written; load it manually with the command above.\n");
    return 1;
  }
  process.stdout.write(`check: launchctl list | grep ${labelFor(agent, role)}\nlog:   ${path.join(home, ".rxai-amp", "board-runs")}/schedule-${agent}*.log\n`);
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) process.exit(main());
