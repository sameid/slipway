import { describe, expect, test } from "vitest";
import { withGithubAccess } from "../src/config.js";
import { testConfig } from "./helpers.js";

describe("withGithubAccess", () => {
  test("reads allowed users and codeowners from the parameter's JSON", () => {
    const config = withGithubAccess(testConfig(), '{"allowedUsers":["Alice"," @bob ",""],"codeowners":" @acme/platform "}');
    expect(config.allowedUsers).toEqual(["alice", "bob"]);
    expect(config.codeowners).toBe("@acme/platform");
  });

  test("an empty codeowners and missing lists fall back to the defaults", () => {
    const config = withGithubAccess({ ...testConfig(), allowedUsers: ["old"], codeowners: "@old" }, '{"codeowners":""}');
    expect(config.allowedUsers).toEqual([]);
    expect(config.codeowners).toBeUndefined();
  });
});
