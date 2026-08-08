// Run a Kite program that has siblings.
//
// `kitec run` takes one file and resolves no modules, so it cannot run anything
// in this project — a Kite module is a *directory*, and every file in `src/`
// depends on its neighbours. This does what `vite-plugin-kite` does: hand the
// compiler the entry and its siblings by module name, then instantiate what
// comes back and call `main`.
//
//     node test/run-kite.mjs test/money_test.kite
//
// The program under test may not touch the DOM — there is no document here.
// That is the point: `money.kite` and `i18n.kite` are pure, and this is what
// makes them testable without a browser.

import { readFile, readdir, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compiler, BuildFailed } from "@kite-lang/compiler-wasm";

const entryPath = resolve(process.argv[2] ?? "test/money_test.kite");
const dir = dirname(entryPath);

// Siblings come from the entry's own directory *and* from `src/`, so a test
// file can sit in `test/` and still reach the modules it is testing.
const sources = {};
for (const from of [resolve(dir), resolve(dir, "../src")]) {
  let names;
  try {
    names = await readdir(from);
  } catch {
    continue;
  }
  for (const name of names) {
    if (!name.endsWith(".kite")) continue;
    const full = join(from, name);
    if (full === entryPath) continue;
    sources[basename(name, ".kite")] = await readFile(full, "utf8");
  }
}

const kite = await compiler();
let artefacts;
try {
  artefacts = kite.build({ entry: await readFile(entryPath, "utf8"), siblings: sources });
} catch (e) {
  if (e instanceof BuildFailed) {
    process.stderr.write(e.diagnostics);
    process.exit(1);
  }
  throw e;
}

const out = await mkdtemp(join(tmpdir(), "kite-test-"));
await mkdir(out, { recursive: true });
for (const [name, body] of Object.entries(artefacts)) {
  await writeFile(join(out, name), body);
}

// The bytes rather than the path: the generated loader `fetch`es anything that
// is not a `Uint8Array`, and Node's fetch will not take a bare filesystem path.
const api = await import(join(out, "api.js"));
const exports = await api.load(artefacts["app.wasm"]);
if (typeof exports.main !== "function") {
  console.error("that program exports no main()");
  process.exit(1);
}
exports.main();
