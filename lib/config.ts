import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Config {
  enabled: boolean;
  path: string;
  push: boolean;
}

export type LoadedConfig =
  | { ok: true; config: Config }
  | { ok: false; error: string };

export function agentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
}

export function configPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return (
    env.PI_SESSION_STORE_CONFIG ??
    path.join(agentDir(env, home), "session-store.json")
  );
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function parseConfig(
  raw: unknown,
  home: string = os.homedir(),
): LoadedConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config is not a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.trim() === "") {
    return { ok: false, error: "config.path must be a non-empty string" };
  }
  return {
    ok: true,
    config: {
      enabled: obj.enabled === undefined ? true : obj.enabled === true,
      push: obj.push === undefined ? true : obj.push === true,
      path: expandHome(obj.path.trim(), home),
    },
  };
}

export function loadConfig(filePath: string = configPath()): LoadedConfig {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: "no config file" };
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: `cannot read config: ${String(error)}` };
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch {
    return { ok: false, error: "config is not valid JSON" };
  }
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
