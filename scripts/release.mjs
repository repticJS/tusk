// Usage: npm run release <version>
// Bumps the version in package.json, Cargo.toml, Cargo.lock and
// tauri.conf.json, checks CHANGELOG.md has notes for it, then commits.
// Pushing the commit to main publishes the release (the workflow tags it),
// and installed copies of Tusk update themselves.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: npm run release <major.minor.patch>");
  process.exit(1);
}

const edit = (path, fn) => writeFileSync(path, fn(readFileSync(path, "utf8")));

if (!readFileSync("CHANGELOG.md", "utf8").includes(`## ${version}`)) {
  console.error(`CHANGELOG.md has no "## ${version}" section. Add release notes first.`);
  process.exit(1);
}
if (execSync("git status --porcelain").toString().trim()) {
  console.error("Commit or stash your changes first.");
  process.exit(1);
}

edit("package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "tusk"\nversion = )"[^"]+"/, `$1"${version}"`));
execSync("npm install --package-lock-only --silent", { stdio: "inherit" });

execSync(`git add -A && git commit -m "Release v${version}"`, { stdio: "inherit" });
console.log(`\nCommitted v${version}. Publish with: git push origin main`);
