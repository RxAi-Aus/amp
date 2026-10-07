/**
 * Prompt rules shared by the Claude Code and Codex A/B runners, so "the same
 * prompt rules" is true by construction rather than by copy.
 *
 * Two variants, selected by how memory reaches the session:
 *
 *   L2 — lifecycle hooks inject AMP memory (Claude Code, Codex with the AMP
 *        hooks installed). v2 wording, 2026-09-23: v1 told the model memory was
 *        "already injected at session start"; since PROTOCOL v2.11 the summary
 *        tier can arrive alongside the prompt instead, and two Opus sessions
 *        with the matching summary in context answered "Recall used: none".
 *        v2 names both arrival points and the block heading, and asks for every
 *        issue whose injected title or summary informed the answer.
 *
 *   L1 — no hooks run (Codex `--ignore-user-config`); recall, if any, is the
 *        model's own work through the AMP skill, and nothing but this prompt
 *        keeps the AMP-off arm from doing it. The sentence therefore still tells
 *        the model to honour AMP_DISABLE itself. It is unchanged from the
 *        original Codex runner text (version 1) so the L1 measurements taken on
 *        2026-09-10 and 2026-09-23 stay comparable. This variant must never be
 *        sent to a hook-capable runtime: on Claude Code it triggered a denied
 *        shell echo and the model refused the injected memory.
 *
 * Bump a version only when its text changes; reports print the version so a
 * citation rate is never compared across wordings.
 */
export type DeliveryLevel = 'L1' | 'L2';

export const RULES_VERSION = 2;      // L2 (hook-delivered) rules
export const L1_RULES_VERSION = 1;   // L1 variant, unchanged

const HEAD = `You are doing a READ-ONLY investigation of this repository.
Rules: do not edit or create files, do not commit, and do not create or comment
on GitHub issues. You may read files and run read-only shell commands.`;

const MEMORY_L2 = `AMP
memory, when enabled, is injected into your context by hooks — at session start
and/or alongside this prompt, in blocks headed "RxAi AMP shared memory"; use it
if present, and do not run commands to check AMP status or fetch more.`;

const MEMORY_L1 = `Before
any AMP action, check AMP_DISABLE in the environment; when it is 1, do not load,
read, or use AMP memory.`;

const TAIL_L2 = `Never display credential values. Answer in English,
under 300 words, naming exact file paths and function names. End with one line
exactly in this form: Recall used: #N, #M (list every AMP issue, from any of
those blocks, whose title or summary informed your answer), or: Recall used: none.`;

const TAIL_L1 = `Never display credential values. Answer in English,
under 300 words, naming exact file paths and function names. End with one line
exactly in this form: Recall used: #N, #M (list every AMP issue whose content
you relied on), or: Recall used: none.`;

export const RULES = `${HEAD} ${MEMORY_L2}\n${TAIL_L2}`;
export const RULES_L1 = `${HEAD} ${MEMORY_L1} ${TAIL_L1}`;

export function rulesFor(level: DeliveryLevel): { text: string; version: number } {
  return level === 'L2' ? { text: RULES, version: RULES_VERSION } : { text: RULES_L1, version: L1_RULES_VERSION };
}
