// app.yaml: the only file in an app repo the platform reads (design 5.2).
import { parse } from "yaml";
import { SECRET_KEY } from "./names.js";

/** Fields only the dev team may change. */
export const PLATFORM_FIELDS = ["name", "auth", "auto_merge", "sizes"] as const;

export type AppYaml = {
  name: string | null;
  autoMerge: boolean;
  secrets: string[];
  raw: Record<string, unknown>;
};

export function parseAppYaml(text: string): AppYaml {
  const raw: unknown = parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("app.yaml must be a mapping");
  const doc = raw as Record<string, unknown>;
  const secrets = doc.secrets ?? [];
  if (!Array.isArray(secrets) || !secrets.every((s): s is string => typeof s === "string" && SECRET_KEY.test(s))) {
    throw new Error("app.yaml secrets must be a list of names like STRIPE_KEY");
  }
  return {
    name: typeof doc.name === "string" ? doc.name : null,
    autoMerge: doc.auto_merge !== false,
    secrets: [...new Set(secrets)],
    raw: doc,
  };
}

/** Platform-owned fields that differ between two versions of app.yaml. */
export function changedPlatformFields(before: string | null, after: string | null): string[] {
  const read = (text: string | null): Record<string, unknown> => {
    if (text === null) return {};
    try {
      return parseAppYaml(text).raw;
    } catch {
      return { __invalid__: text };
    }
  };
  const a = read(before);
  const b = read(after);
  if ("__invalid__" in b) return ["app.yaml (not valid YAML)"];
  return PLATFORM_FIELDS.filter((f) => stable(a[f]) !== stable(b[f]));
}

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
