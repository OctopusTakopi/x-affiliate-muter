// Checks the extension's own wiring: the manifest parses, and every file it
// names exists in the repo and in the zip build.sh produces.
// Run with: node test/manifest.mjs
//
// harness.mjs loads content.js directly, so it passes even when a manifest
// dependency was never committed.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");

console.log("checking the manifest parses...");
const manifest = JSON.parse(read("manifest.json"));
assert.equal(manifest.manifest_version, 3, "Chrome only accepts manifest v3");
assert.match(manifest.version, /^\d+(\.\d+){0,3}$/, "the version must be dotted integers");
assert.ok(manifest.name, "an extension needs a name");
assert.ok(manifest.description, "the store listing and the extensions page show the description");

// Maps each referenced file to the manifest key that named it, so a failure
// names the right part of the manifest.
const referenced = new Map();
const refer = (where, file) => {
  if (!referenced.has(file)) referenced.set(file, where);
};

for (const [i, script] of (manifest.content_scripts || []).entries()) {
  assert.ok(script.matches && script.matches.length, `content_scripts[${i}] matches nothing`);
  for (const file of script.js || []) refer(`content_scripts[${i}].js`, file);
  for (const file of script.css || []) refer(`content_scripts[${i}].css`, file);
}
for (const [i, entry] of (manifest.web_accessible_resources || []).entries()) {
  for (const file of entry.resources || []) {
    refer(`web_accessible_resources[${i}].resources`, file);
  }
}
for (const file of Object.values(manifest.icons || {})) refer("icons", file);
if (manifest.background && manifest.background.service_worker) {
  refer("background.service_worker", manifest.background.service_worker);
}

console.log(`checking the ${referenced.size} file(s) the manifest loads exist...`);
for (const [file, where] of referenced) {
  assert.ok(
    existsSync(join(root, file)),
    `${where} loads "${file}", which is not in the repository - Chrome refuses ` +
      "the extension, and an uncommitted file is the usual reason"
  );
}

console.log("checking every loaded file is valid JavaScript...");
// A syntax error in a content script is silent. Chrome logs it to a console
// nobody has open.
for (const file of referenced.keys()) {
  if (!file.endsWith(".js")) continue;
  const { default: vm } = await import("node:vm");
  assert.doesNotThrow(
    () => new vm.Script(read(file), { filename: file }),
    `${file} does not parse`
  );
}

console.log("checking the packaging script ships everything the manifest loads...");
// build.sh keeps its own list, so a file missed there still loads unpacked from
// the repo while being absent from the zip.
const build = read("build.sh");
const packaged = /^files="([^"]*)"/m.exec(build);
assert.ok(packaged, "build.sh should declare the packaged set as files=\"...\"");
const shipped = new Set(packaged[1].split(/\s+/).filter(Boolean));

assert.ok(shipped.has("manifest.json"), "the zip is not an extension without its manifest");
for (const file of referenced.keys()) {
  assert.ok(
    shipped.has(file),
    `the manifest loads "${file}" but build.sh does not copy it into the package`
  );
}
for (const file of shipped) {
  assert.ok(existsSync(join(root, file)), `build.sh packages "${file}", which does not exist`);
}

console.log("\nmanifest and packaging are consistent");
