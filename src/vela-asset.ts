import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
  The chart library the dashboard draws with — Vela (@luxalgo/vela,
  Apache-2.0) — ships inside this package so the dashboard keeps its promise
  of no CDN and no external request. The build copies Vela's browser bundle
  next to the compiled relay (dist/vela.global.min.js) and the server hands
  it out from its own origin. See THIRD_PARTY_NOTICES.md for the attribution
  Vela's license asks for; the on-chart mark stays on.
*/

export const VELA_BUNDLE_FILE = "vela.global.min.js";

const require = createRequire(import.meta.url);

/**
 * Vela's installed package directory. Its exports map does not expose
 * package.json, so the entry point is resolved and the directory walked up
 * from its dist/ folder.
 */
const velaPackageDir = (): string | undefined => {
  try {
    return dirname(dirname(require.resolve("@luxalgo/vela")));
  } catch {
    return undefined;
  }
};

/**
 * The bundle on disk: the copy the build placed beside this module first
 * (the published layout), the installed package's own dist as a fallback
 * (running from source, tests). Undefined when neither exists.
 */
export const locateVelaBundle = (): string | undefined => {
  const beside = join(dirname(fileURLToPath(import.meta.url)), VELA_BUNDLE_FILE);
  if (existsSync(beside)) return beside;
  const pkg = velaPackageDir();
  if (pkg) {
    const installed = join(pkg, "dist", VELA_BUNDLE_FILE);
    if (existsSync(installed)) return installed;
  }
  return undefined;
};

/** The installed Vela version — the dashboard keys its immutable cache on it. */
export const velaVersion = (): string => {
  const pkg = velaPackageDir();
  if (!pkg) return "unknown";
  try {
    return (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
};

export type VelaAsset = { path: string; version: string; bytes: number };

/** Resolve the bundle once at boot; the server serves it from memory. */
export const loadVelaAsset = (): { asset: VelaAsset; body: Buffer } | undefined => {
  const path = locateVelaBundle();
  if (!path) return undefined;
  const body = readFileSync(path);
  return { asset: { path, version: velaVersion(), bytes: body.byteLength }, body };
};
