import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { changedPlatformFields } from "../hooks/guard.mjs";
import { appRepo, runGuard, tempDir } from "./helpers/harness.mjs";

const t = tempDir();
const repo = appRepo(path.join(t.dir, "loan-tracker"));
const appYaml = path.join(repo, "app.yaml");
const plain = path.join(t.dir, "not-an-app");
mkdirSync(plain);
execFileSync("git", ["init", "--quiet"], { cwd: plain });
after(() => t.cleanup());

const edit = (file, oldString, newString, extra = {}) => ({
  tool_name: "Edit",
  cwd: repo,
  tool_input: { file_path: file, old_string: oldString, new_string: newString, ...extra },
});
const bash = (command, cwd = repo) => ({ tool_name: "Bash", cwd, tool_input: { command } });

describe("file edits in an app repo", () => {
  test("blocks .github/, even in folders that don't exist yet", async () => {
    const r = await runGuard({ tool_name: "Write", cwd: repo, tool_input: { file_path: path.join(repo, ".github/workflows/ci.yml"), content: "x" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\.github\/ is platform-owned/);
  });

  test("blocks CODEOWNERS, with relative paths too", async () => {
    const r = await runGuard({ tool_name: "Write", cwd: repo, tool_input: { file_path: "CODEOWNERS", content: "* @me" } });
    assert.equal(r.code, 2);
  });

  test("allows ordinary files", async () => {
    const r = await runGuard({ tool_name: "Write", cwd: repo, tool_input: { file_path: path.join(repo, "api/src/routes/loans.ts"), content: "x" } });
    assert.equal(r.code, 0, r.stderr);
  });

  test("allows app.yaml edits to non-platform fields", async () => {
    assert.equal((await runGuard(edit(appYaml, "secrets: []", "secrets:\n  - STRIPE_KEY"))).code, 0);
    assert.equal((await runGuard(edit(appYaml, 'description: "Tracks loans"', 'description: "Tracks equipment loans"'))).code, 0);
    assert.equal((await runGuard(edit(appYaml, "# Platform-owned (changes need a review from CODEOWNERS)", "# Platform-owned"))).code, 0);
  });

  test("blocks app.yaml edits to platform-owned fields", async () => {
    const sizes = await runGuard(edit(appYaml, "  prod: small", "  prod: large"));
    assert.equal(sizes.code, 2);
    assert.match(sizes.stderr, /changes sizes in app\.yaml/);
    assert.equal((await runGuard(edit(appYaml, "auto_merge: true", "auto_merge: false"))).code, 2);
    assert.equal((await runGuard(edit(appYaml, "name: loan-tracker", "name: loans"))).code, 2);
    assert.equal((await runGuard(edit(appYaml, "auto_merge: true\n", ""))).code, 2);
  });

  test("Write and MultiEdit are checked on the resulting file", async () => {
    const current = readFileSync(appYaml, "utf8");
    const write = (content) => ({ tool_name: "Write", cwd: repo, tool_input: { file_path: appYaml, content } });
    assert.equal((await runGuard(write(current.replace("Tracks loans", "Tracks gear")))).code, 0);
    assert.equal((await runGuard(write(current.replace("staging: small", "staging: medium")))).code, 2);
    const multi = {
      tool_name: "MultiEdit",
      cwd: repo,
      tool_input: {
        file_path: appYaml,
        edits: [
          { old_string: "Tracks loans", new_string: "Tracks gear" },
          { old_string: "auto_merge: true", new_string: "auto_merge: false" },
        ],
      },
    };
    assert.equal((await runGuard(multi)).code, 2);
  });

  test("an Edit whose old_string isn't there is left to the tool", async () => {
    assert.equal((await runGuard(edit(appYaml, "not in the file", "sizes: {}"))).code, 0);
  });

  test("works in a worktree, where .git is a file", async () => {
    const wt = path.join(t.dir, "loan-tracker-worktrees", "feat", "x");
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, ".git"), "gitdir: /somewhere\n");
    writeFileSync(path.join(wt, "app.yaml"), readFileSync(appYaml));
    const r = await runGuard({ tool_name: "Edit", cwd: wt, tool_input: { file_path: path.join(wt, ".github/x.yml"), old_string: "a", new_string: "b" } });
    assert.equal(r.code, 2);
  });
});

describe("shell commands in an app repo", () => {
  const blocked = [
    "mkdir -p .github/workflows",
    "echo 'x' > .github/workflows/ci.yml",
    "cat >> CODEOWNERS <<'EOF'\n* @me\nEOF",
    "sed -i '' 's/small/large/' app.yaml",
    "sed -i.bak -e 's/true/false/' ./app.yaml",
    "rm -rf .github",
    "git rm CODEOWNERS",
    "cp /tmp/other.yaml app.yaml",
    "npm test && mv app.yaml app.old",
  ];
  const allowed = [
    "cat app.yaml",
    "grep -n sizes app.yaml",
    "cp app.yaml /tmp/app-backup.yaml",
    "git add -A && git commit -m 'Update .github docs mention'",
    "ls .github",
    "npm run db:generate -w api",
    "git diff origin/main -- app.yaml",
  ];
  for (const command of blocked) {
    test(`blocks: ${command.split("\n")[0]}`, async () => {
      assert.equal((await runGuard(bash(command))).code, 2);
    });
  }
  for (const command of allowed) {
    test(`allows: ${command}`, async () => {
      assert.equal((await runGuard(bash(command))).code, 0);
    });
  }
});

describe("outside app repos and on bad input", () => {
  test("does nothing in other repos", async () => {
    assert.equal((await runGuard({ tool_name: "Write", cwd: plain, tool_input: { file_path: path.join(plain, ".github/workflows/ci.yml"), content: "x" } })).code, 0);
    assert.equal((await runGuard(bash("rm -rf .github", plain))).code, 0);
  });

  test("fails open on garbage", async () => {
    const r = await runGuard("not json");
    assert.equal(r.code, 0);
    assert.match(r.stderr, /couldn't parse/);
    assert.equal((await runGuard({})).code, 0);
    assert.equal((await runGuard({ tool_name: "Edit", tool_input: { file_path: 42 } })).code, 0);
    assert.equal((await runGuard({ tool_name: "Read", cwd: repo, tool_input: { file_path: path.join(repo, ".github/x") } })).code, 0);
  });
});

test("changedPlatformFields ignores comments and formatting", () => {
  const before = "name: a\nauto_merge: true # owner: platform\nsizes:\n  staging: small\n  prod: small\n";
  assert.deepEqual(changedPlatformFields(before, "name: a\nauto_merge: true\n\nsizes:\n  staging: small   # cheap\n  prod: small\n"), []);
  assert.deepEqual(changedPlatformFields(before, "name: a\nauto_merge: true\nsizes:\n  staging: small\n  prod: medium\n"), ["sizes"]);
  assert.deepEqual(changedPlatformFields(before, 'name: b\nauto_merge: "true # not a comment"\nsizes:\n  staging: small\n  prod: small\n'), ["name", "auto_merge"]);
});
