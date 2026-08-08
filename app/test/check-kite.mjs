// Check a Kite program *and its siblings*.
//
// `kitec check <file>` reads one file and resolves no modules, so pointing it at
// `src/pos.kite` reports a missing module for every `use` in it — or, worse,
// says nothing and looks like a pass. A Kite module is a directory, so the
// honest check is `checkModule`, which is what the Vite plugin's build does.
//
//     node test/check-kite.mjs src/pos.kite src/office.kite

// It also **validates the WebAssembly it produced**, which is not the same
// question. A module can check clean, build without a diagnostic, and still
// emit a function the browser refuses to compile — that happened here, to a
// `match` used as a value whose arms were blocks containing `return`:
//
//   CompileError: Compiling function #298:"office_view.block_of" failed:
//   local.set[0] expected type (ref null 42), found i32.const of type i32
//
// Nothing caught it until the page was opened and came up blank. One
// `new WebAssembly.Module(bytes)` at the end of the check turns that into a
// build failure, which is where it belongs.

import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { compiler, BuildFailed } from "@kite-lang/compiler-wasm";

const entries = process.argv.slice(2);
if (entries.length === 0) {
  console.error("usage: check-kite.mjs <entry.kite>…");
  process.exit(2);
}

const kite = await compiler();
let bad = 0;

for (const arg of entries) {
  const entryPath = resolve(arg);
  const dir = dirname(entryPath);

  const siblings = {};
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".kite")) continue;
    const full = join(dir, name);
    if (full === entryPath) continue;
    siblings[basename(name, ".kite")] = await readFile(full, "utf8");
  }

  const diagnostics = kite.checkModule({
    entry: await readFile(entryPath, "utf8"),
    siblings,
  });

  if (diagnostics && diagnostics.trim().length > 0) {
    process.stderr.write(`${arg}:\n${diagnostics}\n`);
    bad++;
    continue;
  }

  let artefacts;
  try {
    artefacts = kite.build({ entry: await readFile(entryPath, "utf8"), siblings });
  } catch (e) {
    process.stderr.write(`${arg}: ${e instanceof BuildFailed ? e.diagnostics : e.message}\n`);
    bad++;
    continue;
  }

  try {
    new WebAssembly.Module(artefacts["app.wasm"]);
  } catch (e) {
    process.stderr.write(
      `${arg}: checked clean but produced WebAssembly the engine will not load —\n  ${e.message}\n`,
    );
    bad++;
    continue;
  }

  console.log(`  ok   ${arg} — ${Object.keys(siblings).length} siblings, wasm validates`);
}

process.exit(bad === 0 ? 0 : 1);
