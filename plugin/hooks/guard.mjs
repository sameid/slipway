#!/usr/bin/env node
// PreToolUse guard for slipway app repos. Blocks changes to .github/, CODEOWNERS and the
// platform-owned fields of app.yaml (name, auth, auto_merge, sizes). Branch protection and
// the deployer enforce the same rules on GitHub; this just stops the agent early.
//
// It only acts inside a slipway app repo (git root has an app.yaml with a template key)
// and fails open: bad input or an internal error never blocks a tool call.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PLATFORM_FIELDS = ["name", "auth", "auto_merge", "sizes"];

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Returns a reason to block, or null to allow.
export function check(input) {
  const tool = input?.tool_name;
  const toolInput = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === "string" ? input.cwd : process.cwd();
  if (tool === "Bash") return checkBash(String(toolInput.command ?? ""), cwd);
  if (EDIT_TOOLS.has(tool)) {
    const file = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
    if (typeof file !== "string" || !file) return null;
    return checkFile(path.resolve(cwd, file), tool, toolInput);
  }
  return null;
}

function checkFile(file, tool, toolInput) {
  const root = appRepoRoot(path.dirname(file));
  if (!root) return null;
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (rel === ".github" || rel.startsWith(".github/")) {
    return (
      "slipway: .github/ is owned by the dev team in slipway apps, so agents don't change it. " +
      "Builds and deploys run in the platform's CodeBuild, not GitHub Actions. If this change is really " +
      "needed, tell the colleague to ask the dev team."
    );
  }
  if (rel === "CODEOWNERS" || rel === "docs/CODEOWNERS") {
    return "slipway: CODEOWNERS is owned by the dev team in slipway apps. Ask the dev team if it needs to change.";
  }
  if (rel !== "app.yaml") return null;

  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const after = resultingContent(before, tool, toolInput);
  if (after === null) return null;
  const changed = changedPlatformFields(before, after);
  if (!changed.length) return null;
  return (
    `slipway: this edit changes ${changed.join(", ")} in app.yaml. ${PLATFORM_FIELDS.join(", ")} are ` +
    "platform-owned and need dev team approval, so leave them as they are and tell the colleague to ask the " +
    "dev team. Other fields (description, api, web, secrets) can be edited."
  );
}

// The file's content after the tool runs, or null if we can't tell (the tool will
// probably fail on its own, e.g. old_string not found).
function resultingContent(before, tool, toolInput) {
  if (tool === "Write") return typeof toolInput.content === "string" ? toolInput.content : null;
  if (tool === "Edit") return applyEdit(before, toolInput);
  if (tool === "MultiEdit" && Array.isArray(toolInput.edits)) {
    let text = before;
    for (const edit of toolInput.edits) {
      text = applyEdit(text, edit ?? {});
      if (text === null) return null;
    }
    return text;
  }
  return null;
}

function applyEdit(text, { old_string: oldString, new_string: newString, replace_all: replaceAll }) {
  if (typeof oldString !== "string" || typeof newString !== "string") return null;
  if (oldString === "") return null;
  if (replaceAll) return text.split(oldString).join(newString);
  const index = text.indexOf(oldString);
  if (index < 0) return null;
  return text.slice(0, index) + newString + text.slice(index + oldString.length);
}

export function changedPlatformFields(before, after) {
  const a = topLevelBlocks(before);
  const b = topLevelBlocks(after);
  return PLATFORM_FIELDS.filter((key) => a.get(key) !== b.get(key));
}

// Top-level key -> normalized text of its value and indented children (comments, blank
// lines and trailing whitespace ignored), so reformatting comments isn't a "change".
function topLevelBlocks(text) {
  const blocks = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trimEnd();
    if (!line.trim()) continue;
    const match = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (match) {
      current = match[1];
      blocks.set(current, match[2].trim());
    } else if (/^\s/.test(line) && current) {
      blocks.set(current, `${blocks.get(current)}\n${line.trim()}`);
    } else {
      current = null;
    }
  }
  return blocks;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Shell commands that look like they write to a guarded path. Deliberately narrow: it
// catches redirects and the usual file-changing commands, and leaves reads alone.
const GUARDED = String.raw`(?:\.github(?=/|[\s'";|&)]|$)|CODEOWNERS(?=[\s'";|&)]|$)|app\.yaml(?=[\s'";|&)]|$))`;
const PATH_PREFIX = String.raw`['"]?[^\s'";|&<>]*`;
const BASH_PATTERNS = [
  new RegExp(String.raw`>>?\|?\s*${PATH_PREFIX}${GUARDED}`),
  new RegExp(
    String.raw`(?:^|[;&|(\s])(?:sudo\s+)?(?:rm|mv|tee|touch|mkdir|truncate|ln|chmod|chown|unlink|dd|` +
      String.raw`sed\s+(?:-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*i|yq\s+(?:-[a-zA-Z]*i|e\s+-i|eval\s+-i)|` +
      String.raw`git\s+(?:rm|mv))\b[^;&|]*?\s${PATH_PREFIX}${GUARDED}`,
  ),
  // cp, install and rsync only matter when the guarded path is the destination (last argument).
  new RegExp(String.raw`(?:^|[;&|(\s])(?:cp|install|rsync)\b[^;&|]*\s${PATH_PREFIX}${GUARDED}['"]?\s*(?:$|[;&|)])`),
];

function checkBash(command, cwd) {
  if (!command || !appRepoRoot(cwd)) return null;
  if (!BASH_PATTERNS.some((pattern) => pattern.test(command))) return null;
  return (
    "slipway: this command looks like it changes .github/, CODEOWNERS or app.yaml, which are guarded in " +
    "slipway apps. Edit app.yaml with the Edit tool instead (description, api, web and secrets are fine to " +
    "change; name, auth, auto_merge and sizes need the dev team). .github/ and CODEOWNERS belong to the dev team."
  );
}

// The git root above dir if it's a slipway app repo, else null. Walks up from the
// nearest existing directory so new files in new folders are covered too.
export function appRepoRoot(dir) {
  let current = path.resolve(dir);
  while (!isDir(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return isAppRepo(current) ? current : null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isDir(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isAppRepo(root) {
  try {
    return /^template\s*:\s*\S/m.test(readFileSync(path.join(root, "app.yaml"), "utf8"));
  } catch {
    return false;
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch (err) {
    process.stderr.write(`slipway guard: couldn't parse hook input, allowing (${err.message})\n`);
    return 0;
  }
  try {
    const reason = check(input);
    if (reason) {
      process.stderr.write(`${reason}\n`);
      return 2;
    }
  } catch (err) {
    process.stderr.write(`slipway guard: internal error, allowing (${err.message})\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
