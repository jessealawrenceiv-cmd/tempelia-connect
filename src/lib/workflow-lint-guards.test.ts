import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WORKFLOW_LINT_FILE,
  extractPythonGuards,
  findGuard,
} from "./workflow-lint-guards";

/**
 * Unit tests for the CI workflow lint guards. Each test extracts the real
 * python guard from the workflow file and runs it against a throwaway fixture
 * repo, so the tests can never drift from what CI actually enforces.
 */

const workflowYaml = readFileSync(WORKFLOW_LINT_FILE, "utf8");
const guards = extractPythonGuards(workflowYaml);

const hasPyYaml =
  spawnSync("python3", ["-c", "import yaml"], { encoding: "utf8" }).status === 0;

function fixtureRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "workflow-lint-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runGuard(
  source: string,
  files: Record<string, string>,
): { status: number; output: string } {
  const cwd = fixtureRepo(files);
  const scriptPath = path.join(cwd, ".guard.py");
  writeFileSync(scriptPath, source);
  const res = spawnSync("python3", [scriptPath], { cwd, encoding: "utf8" });
  return {
    status: res.status ?? 1,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function workflow(steps: string): string {
  return `name: fixture
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps}
`;
}

function setupNodeStep(withBlock: string[]): string {
  const body = withBlock.length
    ? `        with:\n${withBlock.map((l) => `          ${l}`).join("\n")}\n`
    : "";
  return `      - uses: actions/setup-node@v4\n${body}`;
}

describe("extractPythonGuards", () => {
  it("finds every inline python guard in the workflow", () => {
    expect(guards.size).toBeGreaterThanOrEqual(4);
    for (const source of guards.values()) {
      expect(source).toContain("import");
      expect(source.startsWith(" ")).toBe(false);
    }
  });

  it("keys guards by their step name", () => {
    const names = [...guards.keys()].join(" | ").toLowerCase();
    expect(names).toContain("node.js 24.x");
    expect(names).toContain("commit sha");
    expect(names).toContain("engines.node");
    expect(names).toContain("cache");
  });

  it("throws a helpful error for an unknown step name", () => {
    expect(() => findGuard(guards, "does-not-exist")).toThrow(/No workflow guard/);
  });

  it("ignores heredocs that are not python guards", () => {
    const extracted = extractPythonGuards(
      [
        "      - name: shell only",
        "        run: |",
        "          echo hi",
        "      - name: python guard",
        "        run: |",
        "          python3 - <<'PY'",
        "          print(1)",
        "          PY",
      ].join("\n"),
    );
    expect([...extracted.keys()]).toEqual(["python guard"]);
    expect(extracted.get("python guard")).toBe("print(1)");
  });
});

describe.skipIf(!hasPyYaml)("Node.js 24.x pin guard", () => {
  let guard: string;
  beforeAll(() => {
    guard = findGuard(guards, "Node.js 24.x pin");
  });

  it.each(["24", '"24"', "24.x", "24.0.0", "24.4.1", "^24", "~24.0.0"])(
    "accepts an explicit pin of %s",
    (value) => {
      const res = runGuard(guard, {
        ".github/workflows/a.yml": workflow(
          setupNodeStep([`node-version: ${value}`]),
        ),
      });
      expect(res.output).not.toContain("::error::");
      expect(res.status).toBe(0);
    },
  );

  it.each(["20", "20.x", "latest", "lts/*", "*", ">=24", "24 - 25", "24,25", '""'])(
    "rejects %s",
    (value) => {
      const res = runGuard(guard, {
        ".github/workflows/a.yml": workflow(
          setupNodeStep([`node-version: ${value}`]),
        ),
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain("::error::");
    },
  );

  it("rejects a setup-node step with no node-version at all", () => {
    const res = runGuard(guard, {
      ".github/workflows/a.yml": workflow(setupNodeStep([])),
    });
    expect(res.status).toBe(1);
  });

  it("rejects node-version-file as an indirect pin", () => {
    const res = runGuard(guard, {
      ".github/workflows/a.yml": workflow(
        setupNodeStep(["node-version-file: .nvmrc"]),
      ),
    });
    expect(res.status).toBe(1);
    expect(res.output.toLowerCase()).toContain("node-version-file");
  });

  it("reports the file path and line number of every offender", () => {
    const res = runGuard(guard, {
      ".github/workflows/mixed.yml": workflow(
        [
          setupNodeStep(["node-version: 24"]),
          setupNodeStep(["node-version: 20"]),
          setupNodeStep(["node-version: latest"]),
        ].join(""),
      ),
    });
    expect(res.status).toBe(1);
    const offenders = res.output
      .split("\n")
      .filter((l) => /mixed\.yml:\d+/.test(l));
    expect(offenders).toHaveLength(2);
  });

  it("never false-positives on comments mentioning node-version", () => {
    const res = runGuard(guard, {
      ".github/workflows/a.yml": `name: fixture
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # a comment about node-version: 20 must be ignored
${setupNodeStep(["node-version: 24"])}`,
    });
    expect(res.status).toBe(0);
  });
});

describe.skipIf(!hasPyYaml)("third-party action SHA pin guard", () => {
  let guard: string;
  const sha = "0c5077e51419868618aeaa5fe8019c62421857d6";
  beforeAll(() => {
    guard = findGuard(guards, "commit SHA");
  });

  it("allows first-party actions pinned to a tag", () => {
    const res = runGuard(guard, {
      ".github/workflows/a.yml": workflow(
        "      - uses: actions/checkout@v4\n      - uses: github/codeql-action/init@v3\n",
      ),
    });
    expect(res.status).toBe(0);
  });

  it("allows a third-party action pinned to a full commit SHA", () => {
    const res = runGuard(guard, {
      ".github/workflows/a.yml": workflow(
        `      - uses: oven-sh/setup-bun@${sha}\n`,
      ),
    });
    expect(res.status).toBe(0);
  });

  it.each(["oven-sh/setup-bun@v2", "oven-sh/setup-bun@main", "foo/bar@1234567"])(
    "rejects %s",
    (uses) => {
      const res = runGuard(guard, {
        ".github/workflows/a.yml": workflow(`      - uses: ${uses}\n`),
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain("::error::");
    },
  );

  it("ignores local and docker action references", () => {
    const res = runGuard(guard, {
      ".github/workflows/a.yml": workflow(
        "      - uses: ./.github/actions/local\n      - uses: docker://alpine:3.20\n",
      ),
    });
    expect(res.status).toBe(0);
  });
});

describe.skipIf(!hasPyYaml)("package.json engines.node guard", () => {
  let guard: string;
  beforeAll(() => {
    guard = findGuard(guards, "engines.node");
  });

  it.each(["24.x", "^24", "~24.0.0", ">=24 <25", "24.4.1"])(
    "accepts engines.node %s",
    (spec) => {
      const res = runGuard(guard, {
        "package.json": JSON.stringify({ engines: { node: spec } }),
      });
      expect(res.status).toBe(0);
    },
  );

  it.each([">=20", "^22 || ^24", "*", "latest", "", "20.x"])(
    "rejects engines.node %s",
    (spec) => {
      const res = runGuard(guard, {
        "package.json": JSON.stringify({ engines: { node: spec } }),
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain("::error");
    },
  );

  it("rejects a missing engines object", () => {
    const res = runGuard(guard, { "package.json": JSON.stringify({}) });
    expect(res.status).toBe(1);
    expect(res.output).toContain("engines");
  });

  it("rejects a missing engines.node key", () => {
    const res = runGuard(guard, {
      "package.json": JSON.stringify({ engines: { npm: "10" } }),
    });
    expect(res.status).toBe(1);
  });

  it("passes against this repo's real package.json", () => {
    const res = runGuard(guard, {
      "package.json": readFileSync("package.json", "utf8"),
    });
    expect(res.status).toBe(0);
  });
});

describe.skipIf(!hasPyYaml)("npm cache config guard", () => {
  let guard: string;
  beforeAll(() => {
    guard = findGuard(guards, "cache");
  });

  it("skips entirely when no package-lock.json is present", () => {
    const res = runGuard(guard, {
      ".github/workflows/a.yml": workflow(setupNodeStep(["node-version: 24"])),
    });
    expect(res.status).toBe(0);
    expect(res.output).toContain("skipped");
  });

  it("passes when cache and cache-dependency-path are both set", () => {
    const res = runGuard(guard, {
      "package-lock.json": "{}",
      ".github/workflows/a.yml": workflow(
        setupNodeStep([
          "node-version: 24",
          "cache: npm",
          "cache-dependency-path: package-lock.json",
        ]),
      ),
    });
    expect(res.status).toBe(0);
  });

  it("fails when cache is missing", () => {
    const res = runGuard(guard, {
      "package-lock.json": "{}",
      ".github/workflows/a.yml": workflow(setupNodeStep(["node-version: 24"])),
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain("cache is missing");
  });

  it("fails when cache-dependency-path is missing", () => {
    const res = runGuard(guard, {
      "package-lock.json": "{}",
      ".github/workflows/a.yml": workflow(
        setupNodeStep(["node-version: 24", "cache: npm"]),
      ),
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain("cache-dependency-path is missing");
  });

  it("fails when cache is set to a non-npm package manager", () => {
    const res = runGuard(guard, {
      "package-lock.json": "{}",
      ".github/workflows/a.yml": workflow(
        setupNodeStep([
          "node-version: 24",
          "cache: yarn",
          "cache-dependency-path: package-lock.json",
        ]),
      ),
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain("expected 'npm'");
  });

  it("ignores lockfiles inside node_modules", () => {
    const res = runGuard(guard, {
      "node_modules/dep/package-lock.json": "{}",
      ".github/workflows/a.yml": workflow(setupNodeStep(["node-version: 24"])),
    });
    expect(res.status).toBe(0);
    expect(res.output).toContain("skipped");
  });

  it("reports offenders with file path and line number", () => {
    const res = runGuard(guard, {
      "package-lock.json": "{}",
      ".github/workflows/multi.yml": workflow(
        [
          setupNodeStep(["node-version: 24"]),
          setupNodeStep([
            "node-version: 24",
            "cache: npm",
            "cache-dependency-path: package-lock.json",
          ]),
        ].join(""),
      ),
    });
    expect(res.status).toBe(1);
    expect(res.output).toMatch(/multi\.yml:\d+ \(job 'build', step 1\)/);
  });
});

describe.skipIf(!hasPyYaml)("real workflow files", () => {
  it("pass every guard as committed", () => {
    for (const [name, source] of guards) {
      const res = spawnSync("python3", ["-c", source], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(
        res.status,
        `guard "${name}" failed:\n${res.stdout}${res.stderr}`,
      ).toBe(0);
    }
  });
});
