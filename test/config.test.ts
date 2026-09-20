import { describe, expect, it } from "vitest";
import {
  expandHome,
  isPathInside,
  parseConfig,
} from "../lib/config.ts";

describe("expandHome", () => {
  it("expands a leading ~/", () => {
    expect(expandHome("~/Code/store", "/home/u")).toBe("/home/u/Code/store");
  });
  it("expands bare ~", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });
  it("leaves other paths alone", () => {
    expect(expandHome("/abs/path", "/home/u")).toBe("/abs/path");
    expect(expandHome("relative", "/home/u")).toBe("relative");
  });
});

describe("parseConfig", () => {
  it("applies defaults for enabled and push", () => {
    const result = parseConfig({ path: "~/store" }, "/home/u");
    expect(result).toEqual({
      ok: true,
      config: { enabled: true, path: "/home/u/store", push: true },
    });
  });

  it("rejects a missing or empty path", () => {
    expect(parseConfig({}).ok).toBe(false);
    expect(parseConfig({ path: "   " }).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(parseConfig(null).ok).toBe(false);
    expect(parseConfig([]).ok).toBe(false);
    expect(parseConfig("x").ok).toBe(false);
  });

  it("honours explicit false flags", () => {
    const result = parseConfig({ path: "/s", enabled: false, push: false });
    expect(result).toEqual({
      ok: true,
      config: { enabled: false, path: "/s", push: false },
    });
  });
});

describe("isPathInside", () => {
  it("detects nested paths and rejects siblings", () => {
    expect(isPathInside("/a/b/c", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/bc", "/a/b")).toBe(false);
  });
});
