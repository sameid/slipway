// slipway setup: put slipway in your own AWS account, with apps under your own GitHub
// org or personal account. Without --yes it only checks and prints what it would do.
// With --yes it creates, or updates, everything. Each step skips what's already done, so
// running it again after a failure, or after updating the plugin, carries on.
//
//   1. the Terraform state bucket, slipway-tfstate-<account> (AWS CLI)
//   2. the foundation (foundation/*.tf), applied from a copy in ~/.cache/slipway. Its
//      inputs are kept next to its state, in s3://<state bucket>/foundation/terraform.tfvars.json,
//      so any laptop can update it later
//   3. waits for the deployer instance's first boot
//   4. the GitHub App, through GitHub's manifest flow (github-app.mjs), with its keys in
//      Secrets Manager (slipway/github-app)
//   5. the deployer release for this plugin version (deployer/scripts/release.sh)
//   6. a dashboard admin, then saves the deployer's URL as `slipway connect` would
//
// It needs admin credentials for the AWS account; nothing after setup does.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Aws, credentialHint } from "./aws.mjs";
import { cacheDir, pluginVersion, saveUserConfig, SOURCE_ROOT, userConfig } from "./config.mjs";
import { api, isTransient } from "./deployer.mjs";
import { appInfo, createApp, github, GithubError, waitForInstallation } from "./github-app.mjs";
import { CliError, EXIT, print, run, sleep, tail } from "./util.mjs";

const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const EMAIL = /^[^@\s'"`\\]+@[^@\s'"`\\]+\.[^@\s'"`\\]+$/;
const APP_SECRET = "slipway/github-app";
const SERVICES = ["ec2", "ecr", "ecs", "elb", "logs", "rds", "s3", "secretsmanager", "sns", "ssm"];
const RDS_CLASSES = ["db.t3.micro", "db.t3.small", "db.t3.medium"];
const STEPS = 6;

export function compareVersions(a, b) {
  const parts = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v ?? "") ?? [0, 0, 0, 0]).slice(1).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// Resources a Terraform plan (terraform show -json) would change in any way.
export function changedResources(plan) {
  return (plan.resource_changes ?? [])
    .filter((rc) => rc.mode !== "data" && rc.change?.actions?.some((a) => ["create", "update", "delete"].includes(a)))
    .map((rc) => rc.address);
}

// Resources a Terraform plan (terraform show -json) would delete or replace.
export function destructiveChanges(plan) {
  return (plan.resource_changes ?? [])
    .filter((rc) => rc.mode !== "data" && rc.change?.actions?.includes("delete"))
    .map((rc) => ({ address: rc.address, replace: rc.change.actions.includes("create") }));
}

// The AZ for the deployer: one with a default subnet that offers its instance type.
export function pickAz(region, subnetAzs, offeredAzs, wanted) {
  const usable = subnetAzs.filter((az) => offeredAzs.includes(az)).sort();
  if (wanted) return usable.includes(`${region}${wanted}`) ? wanted : null;
  return usable.length ? usable[0].slice(region.length) : null;
}

// The Terraform variables setup manages: what was used last time, then the flags.
export function foundationInputs(stored, opts, { region, login }) {
  const vars = { ...stored, region };
  if (stored.region && stored.region !== region) {
    throw new CliError(`slipway is already set up in ${stored.region} in this AWS account. Run setup with --region ${stored.region}.`, EXIT.USAGE);
  }
  if (opts.owner && stored.github_owner && opts.owner.toLowerCase() !== stored.github_owner.toLowerCase()) {
    throw new CliError(
      `This setup's apps live under ${stored.github_owner} on GitHub. setup can't move them to ${opts.owner}; ` +
        "that would need a new GitHub App and a new deployer instance.",
      EXIT.USAGE,
    );
  }
  vars.github_owner = opts.owner ?? stored.github_owner ?? login;
  if (opts.email) vars.alert_email = opts.email.trim();
  if (opts.budget !== undefined) vars.budget_amount = Number(opts.budget);
  if (opts["allowed-users"] !== undefined) {
    vars.github_allowed_users = opts["allowed-users"].split(/[\s,]+/).filter(Boolean).map((u) => u.toLowerCase());
  }
  if (opts.codeowners !== undefined) vars.github_codeowners = opts.codeowners.trim();

  if (!LOGIN.test(vars.github_owner)) throw new CliError(`"${vars.github_owner}" isn't a GitHub account name.`, EXIT.USAGE);
  if (!vars.alert_email) throw new CliError("Give an email address for alerts and your dashboard account: --email you@example.com", EXIT.USAGE);
  if (!EMAIL.test(vars.alert_email)) throw new CliError(`"${vars.alert_email}" isn't an email address.`, EXIT.USAGE);
  if (vars.budget_amount !== undefined && !(vars.budget_amount > 0)) throw new CliError("--budget is a monthly amount in USD, like 100.", EXIT.USAGE);
  for (const user of vars.github_allowed_users ?? []) {
    if (!LOGIN.test(user)) throw new CliError(`"${user}" in --allowed-users isn't a GitHub login.`, EXIT.USAGE);
  }
  if (vars.github_codeowners && !/^@[A-Za-z0-9][\w.\/-]*$/.test(vars.github_codeowners)) {
    throw new CliError('--codeowners is a GitHub user or team, like "@my-org/platform".', EXIT.USAGE);
  }
  return vars;
}

function checkTools() {
  const problems = [];
  const aws = run("aws", ["--version"]);
  if (aws.missing) problems.push("The AWS CLI v2 isn't installed: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
  else if (!/aws-cli\/2\./.test(aws.stdout + aws.stderr)) problems.push(`The AWS CLI v2 is needed; you have ${(aws.stdout + aws.stderr).trim()}.`);
  const tf = run("terraform", ["version", "-json"]);
  if (tf.missing) {
    problems.push(
      "Terraform 1.11 or later isn't installed. On a Mac: brew tap hashicorp/tap && brew install hashicorp/tap/terraform " +
        "(Homebrew's own terraform formula is too old). Elsewhere: https://developer.hashicorp.com/terraform/install",
    );
  } else {
    let version = "";
    try {
      version = JSON.parse(tf.stdout).terraform_version;
    } catch {
      // Very old versions have no -json.
    }
    if (compareVersions(version, "1.11.0") < 0) problems.push(`Terraform ${version || "(unknown version)"} is too old; 1.11 or later is needed.`);
  }
  for (const cmd of ["npm", "tar", "bash"]) {
    if (run(cmd, ["--version"]).missing) problems.push(`${cmd} isn't installed.`);
  }
  if (!existsSync(path.join(SOURCE_ROOT, "foundation", "main.tf"))) {
    problems.push(`This copy of the plugin has no infrastructure code (${path.join(SOURCE_ROOT, "foundation")}). Reinstall the plugin.`);
  }
  return problems;
}

// Read-only checks that the region has everything slipway uses (docs/foundation.md).
function checkRegion(aws, region, wantedAz) {
  const problems = [];
  const opt = aws.call(["account", "get-region-opt-status", "--region-name", region]);
  if (opt.ok && !["ENABLED", "ENABLED_BY_DEFAULT"].includes(opt.data?.RegionOptStatus)) {
    problems.push(`${region} isn't enabled in this account (${opt.data?.RegionOptStatus}). Enable it in the AWS console: Account → AWS Regions.`);
  }
  const listed = aws.call(
    ["ssm", "get-parameters-by-path", "--path", `/aws/service/global-infrastructure/regions/${region}/services`, "--query", "Parameters[].Value"],
    { region: "us-east-1" },
  );
  if (listed.ok) {
    const missing = SERVICES.filter((s) => !(listed.data ?? []).includes(s));
    if (!(listed.data ?? []).length) problems.push(`AWS doesn't list a region called ${region}.`);
    else if (missing.length) problems.push(`${region} is missing services slipway needs: ${missing.join(", ")}.`);
  }
  if (problems.length) return { problems, azSuffix: null };

  const subnets = aws.must(
    ["ec2", "describe-subnets", "--filters", "Name=default-for-az,Values=true", "--query", "Subnets[].AvailabilityZone"],
    "Listing the region's default subnets",
  );
  if (!subnets?.length) {
    problems.push(`${region} has no default VPC, which slipway uses. Create one with: aws ec2 create-default-vpc --region ${region}`);
  }
  const offered = aws.must(
    [
      "ec2", "describe-instance-type-offerings", "--location-type", "availability-zone",
      "--filters", "Name=instance-type,Values=t3.small", "--query", "InstanceTypeOfferings[].Location",
    ],
    "Checking where t3.small instances are offered",
  );
  const azSuffix = subnets?.length ? pickAz(region, subnets, offered ?? [], wantedAz) : null;
  if (subnets?.length && !azSuffix) {
    problems.push(
      wantedAz
        ? `The deployer's zone ${region}${wantedAz} has no default subnet or doesn't offer t3.small any more.`
        : `No zone in ${region} has both a default subnet and t3.small instances.`,
    );
  }
  for (const dbClass of RDS_CLASSES) {
    const count = aws.call([
      "rds", "describe-orderable-db-instance-options", "--engine", "postgres", "--db-instance-class", dbClass,
      "--query", "length(OrderableDBInstanceOptions[?starts_with(EngineVersion, '17.')])",
    ]);
    if (count.ok && !(count.data > 0)) problems.push(`${region} has no ${dbClass} Postgres 17 databases, which app sizes use.`);
  }
  return { problems, azSuffix };
}

// The state bucket's region, null if it doesn't exist; throws if another account has it.
function stateBucketRegion(aws, bucket) {
  const location = aws.call(["s3api", "get-bucket-location", "--bucket", bucket]);
  if (location.ok) return location.data?.LocationConstraint || "us-east-1";
  if (/NoSuchBucket|Not Found|404/.test(location.error)) return null;
  throw new CliError(`Can't use the bucket ${bucket}, which slipway keeps its Terraform state in:\n${tail(location.error, 5)}`);
}

function storedInputs(aws, bucket) {
  const result = run("aws", ["s3", "cp", `s3://${bucket}/foundation/terraform.tfvars.json`, "-"], { env: aws.env() });
  if (result.status !== 0) return {};
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {};
  }
}

function hasFoundation(aws, bucket) {
  return aws.call(["s3api", "head-object", "--bucket", bucket, "--key", "foundation/terraform.tfstate"]).ok;
}

function currentRelease(aws) {
  const param = aws.call(["ssm", "get-parameter", "--name", "/slipway/deployer/version", "--query", "Parameter.Value"]);
  return param.ok && param.data !== "unset" ? param.data : null;
}

// Versioned, encrypted, private, and only over TLS; old state versions expire after 90 days.
function ensureStateBucket(aws, bucket, region, exists) {
  if (exists) {
    print(`${bucket} exists.`);
  } else {
    const create = ["s3api", "create-bucket", "--bucket", bucket];
    if (region !== "us-east-1") create.push("--create-bucket-configuration", `LocationConstraint=${region}`);
    aws.must(create, `Creating ${bucket}`);
    print(`Created ${bucket}.`);
  }
  const put = (args, what) => aws.must(["s3api", ...args, "--bucket", bucket], what);
  put(
    ["put-public-access-block", "--public-access-block-configuration",
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"],
    "Blocking public access to the state bucket",
  );
  put(["put-bucket-ownership-controls", "--ownership-controls", "Rules=[{ObjectOwnership=BucketOwnerEnforced}]"], "Setting the state bucket's ownership");
  put(["put-bucket-versioning", "--versioning-configuration", "Status=Enabled"], "Turning on versioning for the state bucket");
  put(
    ["put-bucket-encryption", "--server-side-encryption-configuration",
      JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: true }] })],
    "Turning on encryption for the state bucket",
  );
  put(
    ["put-bucket-lifecycle-configuration", "--lifecycle-configuration",
      JSON.stringify({
        Rules: [{
          ID: "expire-old-versions",
          Status: "Enabled",
          Filter: {},
          NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        }],
      })],
    "Setting the state bucket's lifecycle",
  );
  put(
    ["put-bucket-policy", "--policy",
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "DenyInsecureTransport",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:*",
          Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }],
      })],
    "Setting the state bucket's policy",
  );
  put(["put-bucket-tagging", "--tagging", "TagSet=[{Key=platform,Value=slipway},{Key=component,Value=foundation}]"], "Tagging the state bucket");
}

// A fresh copy of foundation/ to run Terraform in, keeping only downloaded providers.
function foundationDir(account, region) {
  const dir = path.join(cacheDir(), `foundation-${account}-${region}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (entry !== ".terraform") rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  const src = path.join(SOURCE_ROOT, "foundation");
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const name = entry.name;
    const wanted = entry.isFile() ? name.endsWith(".tf") || name === ".terraform.lock.hcl" : ["files", "templates"].includes(name);
    if (wanted) cpSync(path.join(src, name), path.join(dir, name), { recursive: true });
  }
  return dir;
}

function replaceMessage(changes) {
  const lines = changes.map((c) => `  ${c.address} (${c.replace ? "replaced" : "deleted"})`);
  const instance = changes.some((c) => c.address === "aws_instance.deployer");
  return [
    "This update would replace or delete existing resources:",
    ...lines,
    ...(instance
      ? ["Replacing the deployer instance loses its database: dashboard accounts, the app registry and job history. Apps keep running."]
      : []),
    "Nothing was changed. To go ahead anyway, run setup again with --allow-replace.",
  ].join("\n");
}

// Applies the foundation. Returns its outputs and the addresses of what changed.
function applyFoundation(aws, { account, region, bucket, vars, allowReplace }) {
  const dir = foundationDir(account, region);
  const varsFile = path.join(dir, "terraform.tfvars.json");
  writeFileSync(varsFile, `${JSON.stringify(vars, null, 2)}\n`);
  const env = aws.env({ TF_IN_AUTOMATION: "1", TF_INPUT: "0" });
  const tf = (args, { capture = false } = {}) => run("terraform", [`-chdir=${dir}`, ...args], { env, inherit: !capture });
  const must = (args, what) => {
    const result = tf(args);
    if (result.status !== 0) throw new CliError(`${what} failed (see above). Fix that, then run setup again.`);
  };

  must(["init", "-input=false", "-reconfigure", `-backend-config=bucket=${bucket}`, `-backend-config=region=${region}`], "terraform init");
  // The inputs go next to the state first, so a re-run after a failed apply uses them.
  aws.must(["s3", "cp", "--only-show-errors", varsFile, `s3://${bucket}/foundation/terraform.tfvars.json`], "Saving the foundation's inputs");

  // The first apply can fail just after creating the instance's IAM role, before EC2
  // sees it; a second attempt gets past that.
  const changed = new Set();
  for (let attempt = 1; ; attempt++) {
    const plan = tf(["plan", "-input=false", "-out=tfplan", "-detailed-exitcode", "-compact-warnings"]);
    if (plan.status === 0) {
      print("No changes to the foundation.");
      break;
    }
    if (plan.status !== 2) throw new CliError("terraform plan failed (see above). Fix that, then run setup again.");
    const show = tf(["show", "-json", "tfplan"], { capture: true });
    if (show.status !== 0) throw new CliError(`terraform show failed:\n${tail(show.stderr, 10)}`);
    const planned = JSON.parse(show.stdout);
    const destructive = destructiveChanges(planned);
    if (destructive.length && !allowReplace) throw new CliError(replaceMessage(destructive), EXIT.FAILED);
    for (const address of changedResources(planned)) changed.add(address);
    if (tf(["apply", "-input=false", "tfplan"]).status === 0) break;
    if (attempt === 2) throw new CliError("terraform apply failed (see above). Fix that, then run setup again.");
    print("", "terraform apply failed; trying once more in 30 seconds (new IAM roles take a moment to reach EC2).");
    run("sleep", ["30"]);
  }
  const outputs = tf(["output", "-json"], { capture: true });
  if (outputs.status !== 0) throw new CliError(`terraform output failed:\n${tail(outputs.stderr, 10)}`);
  return {
    outputs: Object.fromEntries(Object.entries(JSON.parse(outputs.stdout)).map(([k, v]) => [k, v.value])),
    changed: [...changed],
  };
}

async function waitForFirstBoot(aws, instanceId) {
  await aws.waitForSsm(instanceId);
  const boot = await aws.runOnInstance(
    instanceId,
    ["cloud-init status --wait >/dev/null 2>&1; cloud-init status --long"],
    { comment: "slipway setup: wait for first boot", timeoutSeconds: 1800 },
  );
  if (/^status:\s*done/m.test(boot.stdout)) return;
  const log = await aws.runOnInstance(instanceId, ["tail -n 40 /var/log/cloud-init-output.log"], { comment: "slipway setup: first-boot log", timeoutSeconds: 60 });
  throw new CliError(`The deployer instance's first-boot setup didn't finish:\n${boot.stdout.trim()}\n\nLast lines of /var/log/cloud-init-output.log:\n${log.stdout.trim()}`);
}

function readAppSecret(aws) {
  const result = aws.call(["secretsmanager", "get-secret-value", "--secret-id", APP_SECRET, "--query", "SecretString"]);
  if (!result.ok) {
    if (/ResourceNotFound/.test(result.error)) return null;
    throw new CliError(`Can't read ${APP_SECRET}:\n${tail(result.error, 5)}`);
  }
  try {
    const value = JSON.parse(result.data);
    return value.appId && value.privateKey && value.webhookSecret ? value : null;
  } catch {
    return null;
  }
}

function storeAppSecret(aws, app) {
  const value = JSON.stringify({ appId: app.appId, privateKey: app.privateKey, webhookSecret: app.webhookSecret });
  const exists = aws.call(["secretsmanager", "describe-secret", "--secret-id", APP_SECRET]).ok;
  aws.withFile(
    value,
    (file) =>
      exists
        ? ["secretsmanager", "put-secret-value", "--secret-id", APP_SECRET, "--secret-string", file]
        : ["secretsmanager", "create-secret", "--name", APP_SECRET, "--tags", "Key=platform,Value=slipway", "--secret-string", file],
    "Saving the GitHub App's keys in Secrets Manager",
  );
}

// Returns { slug, created }: created is true when the deployer must pick up new keys.
async function ensureGithubApp(aws, { owner, isOrg, deployerUrl, browser }) {
  let app = readAppSecret(aws);
  let slug;
  let created = false;
  if (app) {
    const info = await appInfo(app);
    if (!info) {
      print(`The GitHub App in ${APP_SECRET} doesn't work any more (deleted, or its key revoked). Creating a new one.`);
      app = null;
    } else if (info.owner?.login?.toLowerCase() !== owner.toLowerCase()) {
      throw new CliError(`The GitHub App in ${APP_SECRET} (${info.slug}) belongs to ${info.owner?.login}, not ${owner}.`);
    } else {
      slug = info.slug;
      print(`GitHub App ${slug} exists.`);
    }
  }
  if (!app) {
    app = await createApp({ owner, isOrg, deployerUrl, browser });
    slug = app.slug;
    storeAppSecret(aws, app);
    created = true;
    print(`Created the GitHub App ${slug}; its keys are in Secrets Manager (${APP_SECRET}).`);
  }
  await waitForInstallation(app, slug, owner);
  print(`${slug} is installed on all of ${owner}'s repositories.`);
  return { slug, created };
}

function timestamp() {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

async function releaseDeployer(aws, { instanceId, force, restart }) {
  const wanted = pluginVersion();
  const current = currentRelease(aws);
  if (!force && current && compareVersions(current, wanted) > 0) {
    throw new CliError(
      `The deployer runs ${current}, which is newer than this plugin (${wanted}). Update the plugin ` +
        "(/plugin marketplace update slipway), or run setup with --release to install this version anyway.",
    );
  }
  if (force || !current || compareVersions(current, wanted) !== 0) {
    const version = `${wanted}-${timestamp()}`;
    const script = path.join(SOURCE_ROOT, "deployer", "scripts", "release.sh");
    const result = run("bash", [script, version], { env: aws.env({ YES: "1", SKIP_CHECKS: "1" }), inherit: true });
    if (result.status !== 0) throw new CliError("Releasing the deployer failed (see above). Run setup again to retry.");
    return;
  }
  if (!restart) {
    print(`Deployer ${current} is running.`);
    return;
  }
  // The deployer reads the GitHub App's keys and its access settings when it starts.
  const result = await aws.runOnInstance(instanceId, ["/opt/slipway/bin/update-deployer.sh"], { comment: "slipway setup: restart" });
  if (result.status !== "Success") throw new CliError(`Restarting the deployer failed:\n${tail(`${result.stdout}\n${result.stderr}`, 20)}`);
  print(`Restarted deployer ${current} with its new settings.`);
}

// Returns the temporary password, or null if the account already exists.
async function ensureAdmin(aws, instanceId, { email, name }) {
  const result = await aws.runOnInstance(
    instanceId,
    [`/opt/slipway/bin/create-admin --email ${shellQuote(email)} --name ${shellQuote(name)}`],
    { comment: "slipway setup: dashboard admin", timeoutSeconds: 300 },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const password = /Temporary password \(shown once\): (\S+)/.exec(output)?.[1];
  if (password) return password;
  if (/already has an account/.test(output)) return null;
  throw new CliError(`Creating your dashboard account failed:\n${tail(output.trim(), 20)}`);
}

async function whoamiWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api.whoami();
    } catch (err) {
      if (!isTransient(err) || attempt === 24) throw err;
      await sleep(5000);
    }
  }
}

export async function setup(opts) {
  const saved = userConfig().setup ?? {};
  const region = opts.region ?? saved.region;
  const profile = opts.profile ?? saved.profile ?? (process.env.AWS_PROFILE || null);
  if (!region) throw new CliError("Choose a region for slipway: slipway setup --region us-east-1 (it should run nothing else).", EXIT.USAGE);
  if (!REGION.test(region)) throw new CliError(`"${region}" isn't an AWS region name.`, EXIT.USAGE);
  const aws = new Aws({ profile, region });

  print("Checking your tools, AWS account, GitHub account and region...");
  const toolProblems = checkTools();
  if (toolProblems.length) throw new CliError(toolProblems.map((p) => `- ${p}`).join("\n"));

  const who = aws.call(["sts", "get-caller-identity"]);
  if (!who.ok) {
    const hint = credentialHint(who.error, profile);
    throw new CliError(`Can't use your AWS credentials${profile ? ` (profile ${profile})` : ""}:\n${tail(who.error, 5)}${hint ? `\n${hint}` : ""}`);
  }
  const account = who.data.Account;
  if (/:root$/.test(who.data.Arn)) {
    throw new CliError("You're signed in to AWS as the account's root user. Use an IAM user or IAM Identity Center role with admin rights instead.");
  }

  let me;
  try {
    me = await github("GET", "/user");
  } catch (err) {
    if (err instanceof GithubError && err.status === 401) throw new CliError("The GitHub CLI's sign-in doesn't work. Run: ! gh auth login");
    throw err;
  }

  const bucket = `slipway-tfstate-${account}`;
  const bucketRegion = stateBucketRegion(aws, bucket);
  if (bucketRegion && bucketRegion !== region) {
    throw new CliError(`slipway is already set up in ${bucketRegion} in this AWS account (one setup per account). Run setup with --region ${bucketRegion}.`, EXIT.USAGE);
  }
  const stored = bucketRegion ? storedInputs(aws, bucket) : {};
  const existing = bucketRegion ? hasFoundation(aws, bucket) : false;
  const vars = foundationInputs(stored, opts, { region, login: me.login });
  const owner = vars.github_owner;

  let ownerInfo;
  try {
    ownerInfo = await github("GET", `/users/${encodeURIComponent(owner)}`);
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) throw new CliError(`There's no GitHub account called ${owner}.`, EXIT.USAGE);
    throw err;
  }
  const isOrg = ownerInfo.type === "Organization";
  const notes = [];
  if (!isOrg && owner.toLowerCase() !== me.login.toLowerCase()) {
    throw new CliError(
      `${owner} is someone else's personal account (you're signed in to GitHub as ${me.login}). ` +
        `Use your own account, an org you own, or sign in to the GitHub CLI as ${owner}.`,
      EXIT.USAGE,
    );
  }
  if (isOrg) {
    const membership = await github("GET", `/user/memberships/orgs/${encodeURIComponent(owner)}`).catch(() => null);
    if (membership?.role !== "admin") notes.push(`You don't seem to be an owner of ${owner}; GitHub may not let you create the App there.`);
  } else if (me.plan?.name === "free") {
    notes.push(
      "Your GitHub plan is Free, which can't protect private repos' main branch. Apps still work, " +
        "but a direct push to main deploys to staging without the check. GitHub Pro fixes that.",
    );
  }

  const { problems, azSuffix } = checkRegion(aws, region, stored.deployer_az_suffix);
  if (problems.length) throw new CliError(`${region} won't work for slipway:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  vars.deployer_az_suffix = azSuffix;
  const release = currentRelease(aws);

  print(
    "",
    `  AWS account  ${account}, as ${who.data.Arn}${profile ? ` (profile ${profile})` : ""}`,
    `  Region       ${region}, for slipway only (the deployer goes in ${region}${azSuffix})`,
    `  GitHub       apps are created under ${owner} (${isOrg ? "an org" : "your personal account"}); you're ${me.login}`,
    `  Email        ${vars.alert_email}: alerts, and your dashboard account`,
    `  Budget       $${vars.budget_amount ?? 500} a month for the region (emails at 80% and the 100% forecast)`,
    `  Plugin       ${pluginVersion()}${release ? `; the deployer runs ${release}` : ""}`,
    "",
  );
  if (existing) {
    print("slipway is already set up here. With --yes, setup updates the foundation, checks the GitHub App, and releases the deployer if this plugin is newer.");
  } else {
    print(
      "With --yes, setup creates: a Terraform state bucket; the foundation (about 20 resources: one t3.small",
      "instance with an Elastic IP, a CloudFront distribution, an artifacts bucket, IAM roles, an alerts topic",
      "and a budget); a GitHub App on " + owner + ", installed on all its repositories; the deployer; and your",
      "dashboard account. It takes 20-30 minutes, and costs about $20-25 a month before any apps. Each app adds",
      "a database, a service and a CloudFront distribution per environment.",
    );
  }
  for (const note of notes) print(`Note: ${note}`);
  if (!opts.yes) {
    print("", "Nothing has changed. Run the same command with --yes to go ahead.");
    return;
  }

  let n = 0;
  const step = (title) => print("", `==> [${++n}/${STEPS}] ${title}`);

  step("State bucket");
  ensureStateBucket(aws, bucket, region, Boolean(bucketRegion));
  saveUserConfig({ setup: { account, region, profile } });

  step("Foundation (Terraform; the first run takes 10-20 minutes)");
  const { outputs, changed } = applyFoundation(aws, { account, region, bucket, vars, allowReplace: Boolean(opts["allow-replace"]) });
  const deployerUrl = outputs.deployer_url;
  const instanceId = outputs.deployer_instance_id;

  step("Deployer instance (waiting for its first boot, about 5 minutes the first time)");
  await waitForFirstBoot(aws, instanceId);
  print(`${instanceId} is ready.`);

  step("GitHub App");
  const app = await ensureGithubApp(aws, { owner, isOrg, deployerUrl, browser: opts.browser !== false });

  step("Deployer release");
  const restart = app.created || changed.includes("aws_ssm_parameter.github_access");
  await releaseDeployer(aws, { instanceId, force: Boolean(opts.release), restart });

  step("Dashboard account and plugin");
  const password = await ensureAdmin(aws, instanceId, { email: vars.alert_email, name: me.name || me.login });
  const file = saveUserConfig({ deployerUrl, setup: { account, region, profile } });
  const whoami = await whoamiWithRetry();

  print(
    "",
    "slipway is ready.",
    `  Deployer    ${deployerUrl} (saved in ${file})`,
    password
      ? `  Dashboard   sign in as ${vars.alert_email} with the temporary password ${password}; you'll choose your own`
      : `  Dashboard   sign in as ${vars.alert_email} (your account already existed)`,
    `  GitHub      apps are created under ${whoami.owner}; you're ${whoami.login}; the deployer's App is ${app.slug}`,
    `  Alerts      confirm the "AWS Notification - Subscription Confirmation" email sent to ${vars.alert_email}`,
    "  Next        /new-app",
  );
}
