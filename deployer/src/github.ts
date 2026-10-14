// Everything the deployer does on GitHub, as the slipway-deployer App
// (design 5.5 "GitHub App"). The interface lets tests and fake mode swap in an
// in-memory GitHub.
import { App } from "@octokit/app";
import { CHECK_CONTEXT } from "./names.js";

export type PullInfo = {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  headSha: string;
  headRef: string;
  headRepo: string | null; // owner/name of the head branch's repo
  baseRef: string;
  baseSha: string;
  mergeCommitSha: string | null;
};

export type CommitStatus = {
  context: string;
  state: "pending" | "success" | "failure" | "error";
  description: string;
  targetUrl?: string;
};

export type MergeResult = { merged: true; sha: string } | { merged: false; reason: string };

export interface GitHub {
  /** The login behind a user's token (`gh auth token`), or null if GitHub rejects it. */
  loginForToken(token: string): Promise<string | null>;
  isOrgMember(login: string): Promise<boolean>;
  repoExists(repo: string): Promise<boolean>;
  branchHead(repo: string, branch: string): Promise<string>;
  /** File contents at a ref, or null if the file doesn't exist there. */
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
  downloadZipball(repo: string, sha: string): Promise<Uint8Array>;
  setStatus(repo: string, sha: string, status: CommitStatus): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
  getPull(repo: string, number: number): Promise<PullInfo>;
  listOpenPulls(repo: string): Promise<PullInfo[]>;
  listPullFiles(repo: string, number: number): Promise<string[]>;
  /** How many commits `base` has that `headSha` doesn't. */
  behindBy(repo: string, base: string, headSha: string): Promise<number>;
  updateBranch(repo: string, number: number, expectedHeadSha: string): Promise<"updated" | "conflict">;
  squashMerge(repo: string, number: number, headSha: string, title: string): Promise<MergeResult>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  protectMain(repo: string): Promise<void>;
  archiveRepo(repo: string): Promise<void>;
  verifyWebhook(payload: string, signature: string): Promise<boolean>;
}

type InstallationOctokit = Awaited<ReturnType<App["getInstallationOctokit"]>>;

function split(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Bad repo name: ${repo}`);
  return { owner, repo: name };
}

function status(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err ? Number(err.status) : undefined;
}

type PullData = {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string };
};

function toPull(p: PullData): PullInfo {
  return {
    number: p.number,
    title: p.title,
    state: p.state === "open" ? "open" : "closed",
    draft: p.draft ?? false,
    merged: p.merged_at !== null,
    headSha: p.head.sha,
    headRef: p.head.ref,
    headRepo: p.head.repo?.full_name ?? null,
    baseRef: p.base.ref,
    baseSha: p.base.sha,
    mergeCommitSha: p.merge_commit_sha,
  };
}

export class OctokitGitHub implements GitHub {
  private app: App;
  private installation?: Promise<InstallationOctokit>;

  constructor(
    private opts: { appId: string; privateKey: string; webhookSecret: string; org: string; appSlug: string },
  ) {
    this.app = new App({
      appId: opts.appId,
      privateKey: opts.privateKey,
      webhooks: { secret: opts.webhookSecret },
    });
  }

  // The App is installed once on the whole org; its installation token covers every repo.
  private octokit(): Promise<InstallationOctokit> {
    this.installation ??= (async () => {
      const { data } = await this.app.octokit.request("GET /orgs/{org}/installation", { org: this.opts.org });
      return this.app.getInstallationOctokit(data.id);
    })().catch((err) => {
      this.installation = undefined;
      throw err;
    });
    return this.installation;
  }

  async loginForToken(token: string): Promise<string | null> {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "slipway-deployer",
      },
    });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`GitHub /user returned ${res.status}`);
    const body = (await res.json()) as { login: string };
    return body.login;
  }

  async isOrgMember(login: string): Promise<boolean> {
    const octokit = await this.octokit();
    try {
      const res = await octokit.request("GET /orgs/{org}/members/{username}", {
        org: this.opts.org,
        username: login,
      });
      return (res.status as number) === 204;
    } catch (err) {
      if (status(err) === 404 || status(err) === 302) return false;
      throw err;
    }
  }

  async repoExists(repo: string): Promise<boolean> {
    const octokit = await this.octokit();
    try {
      await octokit.request("GET /repos/{owner}/{repo}", split(repo));
      return true;
    } catch (err) {
      if (status(err) === 404) return false;
      throw err;
    }
  }

  async branchHead(repo: string, branch: string): Promise<string> {
    const octokit = await this.octokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      ...split(repo),
      ref: `heads/${branch}`,
    });
    return data.sha;
  }

  async readFile(repo: string, path: string, ref: string): Promise<string | null> {
    const octokit = await this.octokit();
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        ...split(repo),
        path,
        ref,
      });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (err) {
      if (status(err) === 404) return null;
      throw err;
    }
  }

  async downloadZipball(repo: string, sha: string): Promise<Uint8Array> {
    const octokit = await this.octokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/zipball/{ref}", { ...split(repo), ref: sha });
    return new Uint8Array(data as ArrayBuffer);
  }

  async setStatus(repo: string, sha: string, s: CommitStatus): Promise<void> {
    const octokit = await this.octokit();
    await octokit.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
      ...split(repo),
      sha,
      state: s.state,
      context: s.context,
      description: s.description.slice(0, 140),
      target_url: s.targetUrl,
    });
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    const octokit = await this.octokit();
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...split(repo),
      issue_number: number,
      body,
    });
  }

  async getPull(repo: string, number: number): Promise<PullInfo> {
    const octokit = await this.octokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...split(repo),
      pull_number: number,
    });
    return toPull(data);
  }

  async listOpenPulls(repo: string): Promise<PullInfo[]> {
    const octokit = await this.octokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      ...split(repo),
      state: "open",
      base: "main",
      per_page: 100,
    });
    return data.map(toPull);
  }

  async listPullFiles(repo: string, number: number): Promise<string[]> {
    const octokit = await this.octokit();
    const files: string[] = [];
    for (let page = 1; page <= 30; page++) {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        ...split(repo),
        pull_number: number,
        per_page: 100,
        page,
      });
      for (const f of data) {
        files.push(f.filename);
        if (f.previous_filename) files.push(f.previous_filename);
      }
      if (data.length < 100) break;
    }
    return files;
  }

  async behindBy(repo: string, base: string, headSha: string): Promise<number> {
    const octokit = await this.octokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      ...split(repo),
      basehead: `${base}...${headSha}`,
      per_page: 1,
    });
    return data.behind_by;
  }

  async updateBranch(repo: string, number: number, expectedHeadSha: string): Promise<"updated" | "conflict"> {
    const octokit = await this.octokit();
    try {
      await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", {
        ...split(repo),
        pull_number: number,
        expected_head_sha: expectedHeadSha,
      });
      return "updated";
    } catch (err) {
      if (status(err) === 422) return "conflict";
      throw err;
    }
  }

  async squashMerge(repo: string, number: number, headSha: string, title: string): Promise<MergeResult> {
    const octokit = await this.octokit();
    try {
      const { data } = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
        ...split(repo),
        pull_number: number,
        sha: headSha,
        merge_method: "squash",
        commit_title: `${title} (#${number})`,
      });
      return { merged: true, sha: data.sha };
    } catch (err) {
      const s = status(err);
      if (s === 405 || s === 409 || s === 422) {
        return { merged: false, reason: err instanceof Error ? err.message : `GitHub returned ${s}` };
      }
      throw err;
    }
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    const octokit = await this.octokit();
    try {
      await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { ...split(repo), ref: `heads/${branch}` });
    } catch (err) {
      if (status(err) !== 422 && status(err) !== 404) throw err; // already gone
    }
  }

  // Design 5.7: PRs required, the check must pass, no required reviews, only the
  // deployer's App can push to main, no force pushes or deletion.
  async protectMain(repo: string): Promise<void> {
    const octokit = await this.octokit();
    await octokit.request("PUT /repos/{owner}/{repo}/branches/{branch}/protection", {
      ...split(repo),
      branch: "main",
      required_status_checks: { strict: true, contexts: [CHECK_CONTEXT] },
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 0 },
      restrictions: { users: [], teams: [], apps: [this.opts.appSlug] },
      allow_force_pushes: false,
      allow_deletions: false,
    });
  }

  async archiveRepo(repo: string): Promise<void> {
    const octokit = await this.octokit();
    await octokit.request("PATCH /repos/{owner}/{repo}", { ...split(repo), archived: true });
  }

  async verifyWebhook(payload: string, signature: string): Promise<boolean> {
    try {
      return await this.app.webhooks.verify(payload, signature);
    } catch {
      return false;
    }
  }
}
