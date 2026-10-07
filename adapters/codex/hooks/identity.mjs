// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Codex hook identity — which AMP agent a Codex-runtime session belongs to.
 *
 * ~/.codex/hooks.json launches every shim with RXAI_AMP_AGENT=codex, but the
 * Codex runtime is not only Codex: OpenClaw runs its OpenAI models on it
 * (`agentRuntime: codex`), and those sessions fire the same hooks. Each
 * session records who started it as `originator` — "Codex Desktop" for the
 * ChatGPT Desktop app, "openclaw" for OpenClaw — in the first line of its
 * rollout (`transcript_path` in the hook input), and the runtime reads it from
 * CODEX_INTERNAL_ORIGINATOR_OVERRIDE when a host sets one. An originator that
 * names another AMP agent takes that identity, so OpenClaw's ledger, recall
 * header and capture check (which looks for an issue titled
 * `[FROM:<agent>…`) match the identity it writes under. Anything else —
 * including the ChatGPT Desktop app — stays `codex`. Fail-soft: no transcript,
 * unreadable file, unknown originator → the hooks.json identity.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { readStdinJson } from "../../lib/amp-config.mjs";

/** Agents other than codex that are known to run on the Codex runtime. */
export const ORIGINATOR_AGENTS = new Map([["openclaw", "openclaw"]]);
const HEAD_BYTES = 256 * 1024;

/** `originator` from a rollout's session_meta line, or "". */
export function originatorFromTranscript(file) {
  if (!file) return "";
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
    const firstLine = head.split("\n", 1)[0];
    return firstLine.match(/"originator"\s*:\s*"([^"]{1,64})"/)?.[1] ?? "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The AMP agent for an originator, or null when it stays with the default. */
export function agentForOriginator(originator) {
  return ORIGINATOR_AGENTS.get(String(originator || "").trim().toLowerCase()) ?? null;
}

/** Set RXAI_AMP_AGENT / RXAI_AMP_RUNTIME for the shared hook about to load. */
export async function applyCodexIdentity() {
  process.env.RXAI_AMP_AGENT ||= "codex";
  process.env.RXAI_AMP_RUNTIME = "codex";
  try {
    const input = await readStdinJson();
    const originator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || originatorFromTranscript(input.transcript_path);
    const agent = agentForOriginator(originator);
    if (agent) process.env.RXAI_AMP_AGENT = agent;
  } catch {
    /* fail-soft: keep the hooks.json identity */
  }
}
