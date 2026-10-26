import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAppYaml, renderEnv, renderShared, inputsFromConfig, main, ENV_OUTPUTS, linksOutside, secretNames } from "../appyaml.mjs";

const VALID = `
name: my-app
template: react-express
description: Tracks equipment loans for the ops team
owner: jane.doe

api:
  port: 3000
  health_check: /api/health
  migrate_command: ["node", "dist/migrate.js"]

web:
  build_command: npm run build --workspace web
  output_dir: web/dist

secrets:
  - STRIPE_KEY
  - OPENAI_API_KEY

# Platform-owned (dev team approval required to change)
auto_merge: true
sizes:
  staging: small
  prod: medium
`;

const VERSIONS = { AWS_PROVIDER_VERSION: "6.68.0", RANDOM_PROVIDER_VERSION: "3.9.1" };

test("accepts the design's example app.yaml", () => {
  const { config, errors } = parseAppYaml(VALID, { app: "my-app" });
  assert.deepEqual(errors, []);
  assert.equal(config.sizes.prod, "medium");
  assert.deepEqual(config.secrets, ["STRIPE_KEY", "OPENAI_API_KEY"]);
});

test("fills in defaults for a minimal app.yaml", () => {
  const { config, errors } = parseAppYaml("name: tiny\n");
  assert.deepEqual(errors, []);
  assert.equal(config.api.port, 3000);
  assert.equal(config.api.health_check, "/api/health");
  assert.deepEqual(config.api.migrate_command, ["node", "dist/migrate.js"]);
  assert.equal(config.web.output_dir, "web/dist");
  assert.deepEqual(config.sizes, { staging: "small", prod: "small" });
  assert.deepEqual(config.secrets, []);
});

test("rejects a name that differs from the registered app", () => {
  const { errors } = parseAppYaml(VALID, { app: "other-app" });
  assert.match(errors.join("\n"), /registered as "other-app"/);
});

test("rejects bad values with one message each", () => {
  const { config, errors } = parseAppYaml(`
name: My_App
api:
  port: 70000
  health_check: /health
  migrate_command: []
web:
  output_dir: ../outside
secrets: [stripe_key, PORT, AWS_SECRET_ACCESS_KEY, OK_KEY, OK_KEY]
auth: none
auto_merge: "yes"
sizes:
  staging: huge
extra: 1
`);
  assert.equal(config, null);
  const all = errors.join("\n");
  for (const expected of [
    /name must be/, /api.port/, /health_check must be a path under \/api\//, /migrate_command/,
    /output_dir must be inside the repo/, /"stripe_key" must be UPPER_SNAKE_CASE/, /PORT is reserved/,
    /AWS_SECRET_ACCESS_KEY is reserved/, /OK_KEY is listed twice/, /unknown key "auth"/,
    /auto_merge must be true or false/, /sizes.staging must be one of/, /unknown key "extra"/,
  ]) {
    assert.match(all, expected);
  }
});

test("rejects duplicate keys and non-mappings", () => {
  assert.match(parseAppYaml("name: a-b\nname: c-d\n").errors[0], /not valid YAML/);
  assert.match(parseAppYaml("- just\n- a list\n").errors[0], /must be a YAML mapping/);
});

test("renders the env root config with a relative module source and the contract's state key", () => {
  const { config } = parseAppYaml(VALID);
  const root = renderEnv({
    app: "my-app", env: "prod", inputs: inputsFromConfig(config, "prod"),
    outDir: "/platform/work/my-app-prod", modulesDir: "/platform/modules", stateBucket: "slipway-tfstate-123",
    region: "eu-west-1", versions: VERSIONS,
  });
  assert.equal(root.module.env.source, "../../modules/app-env");
  assert.deepEqual(root.terraform.backend.s3, {
    bucket: "slipway-tfstate-123", key: "apps/my-app/prod.tfstate", region: "eu-west-1", encrypt: true, use_lockfile: true,
  });
  assert.equal(root.terraform.required_providers.aws.version, "6.68.0");
  assert.deepEqual(root.provider.aws.default_tags.tags, { platform: "slipway", app: "my-app", env: "prod" });
  assert.equal(root.module.env.size, "medium");
  assert.deepEqual(root.module.env.secret_names, ["STRIPE_KEY", "OPENAI_API_KEY"]);
  assert.equal(root.module.env.service_image, "${var.service_image}");
  assert.equal(root.variable.destroying.type, "bool");
  assert.equal(root.module.env.custom_domain, "${var.custom_domain}");
  assert.equal(root.module.env.certificate_arn, "${var.certificate_arn}");
  assert.deepEqual(root.variable.custom_domain, { type: "string", default: "" });
  assert.deepEqual(Object.keys(root.output), ENV_OUTPUTS);
});

test("renders the shared root config", () => {
  const root = renderShared({
    app: "my-app", outDir: "/platform/work/my-app-shared", modulesDir: "/platform/modules", stateBucket: "b",
    region: "eu-west-1", versions: VERSIONS,
  });
  assert.equal(root.module.shared.source, "../../modules/app-shared");
  assert.equal(root.terraform.backend.s3.key, "apps/my-app/shared.tfstate");
  assert.equal(root.output.ecr_repository_url.value, "${module.shared.ecr_repository_url}");
});

test("injects app.yaml's secrets and every other parameter the env has, except removals and names only app.yaml may use", () => {
  const { names, skipped, conflicts } = secretNames({
    declared: ["STRIPE_KEY", "OPENAI_API_KEY"],
    existing: ["OPENAI_API_KEY", "STRIPE_KEY", "SLACK_TOKEN", "AIRTABLE_KEY", "OLD_KEY", "NODE_OPTIONS", "AWS_REGION", "lower", "DB_HOST"],
    removed: ["OLD_KEY"],
  });
  assert.deepEqual(names, ["STRIPE_KEY", "OPENAI_API_KEY", "AIRTABLE_KEY", "SLACK_TOKEN"]);
  assert.deepEqual(skipped, [
    "AWS_REGION (set by the platform)", "DB_HOST (set by the platform)",
    "NODE_OPTIONS (only app.yaml may declare it)", "lower (not an UPPER_SNAKE_CASE name)",
  ]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(secretNames({ declared: ["STRIPE_KEY"], existing: ["STRIPE_KEY"], removed: ["STRIPE_KEY"] }).conflicts, ["STRIPE_KEY"]);
});

test("CLI: secret-names, and render-env with them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "appyaml-"));
  try {
    const file = path.join(dir, "app.yaml");
    writeFileSync(file, VALID);
    assert.equal(main(["secret-names", file, "--existing", "STRIPE_KEY:OPENAI_API_KEY:SLACK_TOKEN:GONE", "--removed", "GONE"]),
      "STRIPE_KEY\nOPENAI_API_KEY\nSLACK_TOKEN");
    assert.equal(main(["secret-names", file, "--existing", "", "--removed", ""]), "STRIPE_KEY\nOPENAI_API_KEY");
    assert.throws(() => main(["secret-names", file, "--existing", "STRIPE_KEY", "--removed", "STRIPE_KEY"]),
      /STRIPE_KEY is being removed on the dashboard, but this release's app.yaml requires it/);
    assert.throws(() => main(["secret-names", file]), /usage: secret-names/);

    const out = path.join(dir, "work", "my-app-staging");
    const render = (...extra) => {
      main(["render-env", "--app", "my-app", "--env", "staging", "--app-yaml", file, "--out-dir", out,
        "--modules-dir", path.join(dir, "modules"), "--state-bucket", "b", "--region", "eu-west-1", ...extra]);
      return JSON.parse(readFileSync(path.join(out, "main.tf.json"), "utf8")).module.env.secret_names;
    };
    assert.deepEqual(render(), ["STRIPE_KEY", "OPENAI_API_KEY"]);
    assert.deepEqual(render("--secret-names", "STRIPE_KEY:OPENAI_API_KEY:SLACK_TOKEN"), ["STRIPE_KEY", "OPENAI_API_KEY", "SLACK_TOKEN"]);
    assert.deepEqual(render("--secret-names", ""), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: validate, get and render-env from a destroy-time inputs file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "appyaml-"));
  try {
    const file = path.join(dir, "app.yaml");
    writeFileSync(file, VALID);
    assert.equal(main(["validate", file, "--app", "my-app"]), "app.yaml OK");
    assert.equal(main(["get", file, "web.output_dir"]), "web/dist");
    assert.equal(main(["get", file, "secrets"]), "STRIPE_KEY\nOPENAI_API_KEY");
    assert.equal(main(["get", file, "api.migrate_command"]), '["node","dist/migrate.js"]');

    const inputs = path.join(dir, "inputs.json");
    writeFileSync(inputs, JSON.stringify({
      size: "large", api_port: 8080, health_check_path: "/api/up", migrate_command: ["npm", "run", "migrate"], secret_names: [],
    }));
    const out = path.join(dir, "work", "my-app-staging");
    main(["render-env", "--app", "my-app", "--env", "staging", "--inputs-json", inputs, "--out-dir", out,
      "--modules-dir", path.join(dir, "modules"), "--state-bucket", "b", "--region", "eu-west-1"]);
    const root = JSON.parse(readFileSync(path.join(out, "main.tf.json"), "utf8"));
    assert.equal(root.module.env.size, "large");
    assert.equal(root.module.env.api_port, 8080);
    assert.equal(root.module.env.source, "../../modules/app-env");

    assert.throws(() => main(["validate", path.join(dir, "missing.yaml")]), /app.yaml at its root/);
    writeFileSync(file, "name: Bad\n");
    assert.throws(() => main(["validate", file]), (err) => err.summary.startsWith("app.yaml is invalid: name must be"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-links: links inside the folder are fine, links out of it are not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "links-"));
  try {
    const src = path.join(dir, "src");
    mkdirSync(path.join(src, "node_modules", ".bin"), { recursive: true });
    mkdirSync(path.join(src, "api"));
    writeFileSync(path.join(src, "api", "cli.js"), "");
    writeFileSync(path.join(dir, "secret.env"), "TOKEN=x");
    // What npm makes: workspace links and .bin links, all inside.
    symlinkSync("../api", path.join(src, "node_modules", "api"));
    symlinkSync("../api/cli.js", path.join(src, "node_modules", ".bin", "cli"));
    assert.deepEqual(linksOutside(src), []);
    assert.equal(main(["check-links", src]), `no symbolic links out of ${src}`);

    symlinkSync("../secret.env", path.join(src, "app.yaml"));
    symlinkSync("/etc", path.join(src, "api", "etc"));
    symlinkSync("../../nowhere", path.join(src, "api", "dangling"));
    assert.deepEqual(linksOutside(src).sort(), ["api/dangling", "api/etc", "app.yaml"]);
    assert.throws(() => main(["check-links", src, "--what", "the repo"]), /the repo contains symbolic links that point outside it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
