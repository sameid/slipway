import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizePem } from "../src/aws.js";

describe("normalizePem", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  it("leaves a well-formed key usable", () => {
    expect(normalizePem(privateKey)).toBe(privateKey);
  });

  it("restores line breaks that became spaces (console key/value editor)", () => {
    const mangled = privateKey.trim().replace(/\n/g, " ");
    expect(normalizePem(mangled)).toBe(privateKey);
    expect(() => createPrivateKey(normalizePem(mangled))).not.toThrow();
  });

  it("restores escaped \\n sequences", () => {
    const escaped = privateKey.trim().replace(/\n/g, "\\n");
    expect(normalizePem(escaped)).toBe(privateKey);
  });

  it("returns anything that isn't a PEM block unchanged", () => {
    expect(normalizePem("not a key")).toBe("not a key");
  });
});
