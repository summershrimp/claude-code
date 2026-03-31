#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const mapPath = path.join(packageDir, "cli.js.map");
const outDir = path.join(packageDir, "restored-src");

const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));

if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) {
  throw new Error("Invalid source map: missing sources or sourcesContent");
}

if (map.sources.length !== map.sourcesContent.length) {
  throw new Error("Invalid source map: sources length does not match sourcesContent length");
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const restoreablePrefixes = ["../src/", "../vendor/"];
let restoredCount = 0;

for (let i = 0; i < map.sources.length; i += 1) {
  const sourcePath = map.sources[i];
  const sourceContent = map.sourcesContent[i];

  if (typeof sourcePath !== "string" || typeof sourceContent !== "string") {
    continue;
  }

  if (!restoreablePrefixes.some((prefix) => sourcePath.startsWith(prefix))) {
    continue;
  }

  const relativePath = sourcePath.replace(/^\.\.\//, "");
  const destinationPath = path.join(outDir, relativePath);

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, sourceContent, "utf8");
  restoredCount += 1;
}

const entrypoint = map.sources.find((sourcePath) => sourcePath === "../src/entrypoints/cli.tsx");
const readme = [
  "# Restored Claude CLI sources",
  "",
  `Generated from: ${path.relative(packageDir, mapPath)}`,
  `Restored files: ${restoredCount}`,
  "",
  "Included paths:",
  "- src/**",
  "- vendor/**",
  "",
  "Entrypoint:",
  `- ${entrypoint ? "src/entrypoints/cli.tsx" : "not found in source map"}`,
  "",
].join("\n");

fs.writeFileSync(path.join(outDir, "README.md"), readme, "utf8");

console.log(`Restored ${restoredCount} files to ${outDir}`);
