import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readVersions } from "../appyaml.mjs";

test("terraform.lock.hcl locks the provider versions versions.env pins", () => {
  const lock = readFileSync(new URL("../terraform.lock.hcl", import.meta.url), "utf8");
  const locked = Object.fromEntries(
    [...lock.matchAll(/provider "registry\.terraform\.io\/hashicorp\/(\w+)" \{\s*version\s*=\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
  const versions = readVersions();
  assert.deepEqual(locked, { aws: versions.AWS_PROVIDER_VERSION, random: versions.RANDOM_PROVIDER_VERSION });
  // The deployer instance's platform needs an h1 hash, or init skips the cache.
  assert.equal(lock.match(/"h1:/g)?.length, 2);
});
