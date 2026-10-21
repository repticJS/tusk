// Prints the CHANGELOG.md section for a version (used as release notes).
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
const text = readFileSync("CHANGELOG.md", "utf8");
const start = text.indexOf(`## ${version}`);
if (start < 0) {
  console.error(`No CHANGELOG entry for ${version}`);
  process.exit(1);
}
const rest = text.slice(start).split("\n").slice(1).join("\n");
const end = rest.search(/^## /m);
process.stdout.write((end < 0 ? rest : rest.slice(0, end)).trim() + "\n");
