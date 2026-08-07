/**
 * Helpers for unit-testing the CI workflow lint guards.
 *
 * The guards live as inline `python3 - <<'PY' ... PY` heredocs inside
 * `.github/workflows/log-action-types.yml`. Rather than duplicating their
 * logic in tests (which would let the tests drift from CI), we extract the
 * exact script text from the workflow and execute it against fixtures.
 */

export const WORKFLOW_LINT_FILE = ".github/workflows/log-action-types.yml";

const STEP_NAME_RE = /^\s*-\s+name:\s*(.+?)\s*$/;
const HEREDOC_START = "python3 - <<'PY'";
const HEREDOC_INDENT = 10;

/**
 * Extract every inline python guard from a workflow file, keyed by the name of
 * the step that runs it. Steps without a python heredoc are omitted.
 */
export function extractPythonGuards(workflowYaml: string): Map<string, string> {
  const guards = new Map<string, string>();
  const lines = workflowYaml.split("\n");
  let currentStep: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const nameMatch = STEP_NAME_RE.exec(line);
    if (nameMatch) {
      currentStep = nameMatch[1] ?? null;
      continue;
    }
    if (line.trim() !== HEREDOC_START) continue;

    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const raw = lines[j] ?? "";
      if (raw.trim() === "PY") break;
      body.push(raw.slice(HEREDOC_INDENT));
    }
    if (currentStep) guards.set(currentStep, body.join("\n"));
    i = j;
  }

  return guards;
}

/** Look up one guard by a case-insensitive substring of its step name. */
export function findGuard(
  guards: Map<string, string>,
  nameFragment: string,
): string {
  const needle = nameFragment.toLowerCase();
  for (const [name, source] of guards) {
    if (name.toLowerCase().includes(needle)) return source;
  }
  throw new Error(
    `No workflow guard step matching "${nameFragment}". Found: ${[
      ...guards.keys(),
    ].join(" | ")}`,
  );
}
