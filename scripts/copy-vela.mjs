import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/*
  Ship Vela with the package. The dashboard's chart library is copied from
  the installed @luxalgo/vela into dist/ at build time so the relay serves
  it from its own origin — no CDN, no external request, the same rule the
  rest of the dashboard lives by. `files` in package.json publishes dist/
  wholesale, so `npm publish` needs nothing extra.
*/

const require = createRequire(import.meta.url);
// Vela's exports map hides package.json; its entry point sits in dist/ next to the bundle.
const source = join(dirname(require.resolve("@luxalgo/vela")), "vela.global.min.js");
const target = resolve("dist", "vela.global.min.js");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`copied ${source} → ${target} (${(statSync(target).size / 1024).toFixed(0)} KiB)`);
