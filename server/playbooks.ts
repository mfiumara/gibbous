// Playbooks: how a goal flows through Gibbous (plan? tests? who reviews? what happens when it's approved?).
import type { Playbook, Task } from './store.ts';

export const BUILTIN_PLAYBOOKS: Playbook[] = [
  { id: 'pb_standard', builtin: true, name: 'Plan, build, review', description: 'A planner splits the goal; each task is built in a worktree and reviewed, then waits for you.',
    plan: true, writeTests: false, reviewRounds: 2, reviewPasses: ['correctness'], finish: 'manual' },
  { id: 'pb_ship', builtin: true, name: 'Ship it as PRs', description: 'Like the standard flow, but tests are required and approved tasks open pull requests automatically.',
    plan: true, writeTests: true, reviewRounds: 2, reviewPasses: ['correctness', 'tests'], finish: 'pr' },
  { id: 'pb_quick', builtin: true, name: 'Quick fix', description: 'No planner: one task, one review round, merged automatically once approved.',
    plan: false, writeTests: false, reviewRounds: 1, reviewPasses: ['correctness'], finish: 'merge' },
  { id: 'pb_triage', builtin: true, name: 'Bug triage', description: 'The planner reproduces the bug first; tasks are a failing test, then the fix.',
    plan: true, planPrompt: 'This is a bug report. Plan a task that writes a failing test reproducing it, then a task (depending on it) that fixes the bug so the test passes. Investigate enough to name the likely root cause in the fix task.',
    writeTests: true, reviewRounds: 2, reviewPasses: ['correctness', 'tests'], finish: 'manual' },
  { id: 'pb_deps', builtin: true, name: 'Dependency bump', description: 'Upgrade dependencies one ecosystem at a time; tests must pass; security review on.',
    plan: true, planPrompt: 'Plan one task per package ecosystem/lockfile to upgrade outdated dependencies to their latest compatible versions, fixing any breakage. Avoid major-version jumps unless the goal says so.',
    writeTests: false, reviewRounds: 1, reviewPasses: ['correctness', 'security'], finish: 'manual' },
];

const PASSES: Record<Playbook['reviewPasses'][number], string> = {
  correctness: 'Correctness: logic errors, edge cases, missing pieces, anything that would break existing behaviour.',
  security: 'Security: injection, unsafe input handling, secrets in code or logs, auth/permission mistakes, risky dependencies.',
  tests: 'Tests: the change must be covered by meaningful tests that fail without it; run them.',
};

export function reviewPrompt(task: Task, base: string | undefined, pb?: Playbook) {
  const passes = (pb?.reviewPasses?.length ? pb.reviewPasses : ['correctness'] as const).map(p => `- ${PASSES[p]}`).join('\n');
  return `You are a strict code reviewer. Another agent just worked on this task in the current directory:\n\n"""${task.title}\n${task.prompt}"""\n\n` +
    `Review ALL changes: run \`git status\` and \`git diff ${base ?? 'HEAD'}\` (include untracked files). Check:\n${passes}\n` +
    `Run the tests if there are any. Do NOT modify any files. Uncommitted changes are expected: Gibbous commits, merges and pushes ` +
    `itself, so never ask for commits, pushes or PRs.\n\n` +
    `End your reply with exactly one line \`VERDICT: APPROVE\` or \`VERDICT: CHANGES\`, followed (for CHANGES) by a numbered list of concrete required fixes.`;
}

export function workerPrompt(task: Task, depTitles: string[], pb?: Playbook) {
  return [
    task.prompt,
    depTitles.length ? `This builds on already-merged tasks: ${depTitles.map(t => `"${t}"`).join(', ')}.` : '',
    pb?.writeTests ? 'Add or extend tests that cover this change, and make sure they pass.' : '',
    pb?.workerNote ?? '',
    'When you are done, make sure the work is complete and tests (if any) pass. Commit nothing and do not push or open PRs; Gibbous handles that.',
  ].filter(Boolean).join('\n\n');
}

// The planner's last ```json block. Task prompts often quote code in their own ``` fences, so a regex up to the
// next fence cuts the JSON short; instead scan from the first "{" after the marker to its matching "}".
export function extractPlanJson(text: string): unknown {
  const at = text.lastIndexOf('```json');
  const start = text.indexOf('{', at < 0 ? 0 : at);
  if (start < 0) throw new Error('no task list found in the planner reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('the task list in the planner reply is incomplete');
}
