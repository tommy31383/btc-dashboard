const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const APP_TSX = path.join(ROOT, "App.tsx");
const APP_JSON = path.join(ROOT, "app.json");
const DIST_DIR = path.join(ROOT, "dist");
const DOCS_APP_DIR = path.join(ROOT, "docs", "app");
const DEPLOY_STAGE_PATHS = [
  "App.tsx",
  "app.json",
  "components/All5mPanel.tsx",
  "utils/all5mAccount.ts",
  "package.json",
  "tools/build-web-deploy.js",
  "tsconfig.json",
  "docs/app",
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...opts,
  });
}

function runText(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function formatBangkokDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid semver: ${version}`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function updateVersions() {
  const appTsx = fs.readFileSync(APP_TSX, "utf8");
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, "utf8"));

  const versionMatch = appTsx.match(/const APP_VERSION = "([^"]+)";/);
  if (!versionMatch) throw new Error("APP_VERSION not found in App.tsx");

  const nextVersion = bumpPatch(versionMatch[1]);
  const buildDate = formatBangkokDate();

  const nextAppTsx = appTsx
    .replace(/const APP_VERSION = "[^"]+";/, `const APP_VERSION = "${nextVersion}";`)
    .replace(/const BUILD_DATE = "[^"]+";/, `const BUILD_DATE = "${buildDate}";`);

  appJson.expo = appJson.expo || {};
  appJson.expo.version = nextVersion;

  fs.writeFileSync(APP_TSX, nextAppTsx);
  fs.writeFileSync(APP_JSON, JSON.stringify(appJson, null, 2) + "\n");

  return { nextVersion, buildDate };
}

function syncDistToDocs() {
  fs.rmSync(DOCS_APP_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOCS_APP_DIR, { recursive: true });
  fs.cpSync(DIST_DIR, DOCS_APP_DIR, { recursive: true });
}

function ensureGitRepo() {
  runText("git", ["rev-parse", "--is-inside-work-tree"]);
}

function commitAndPush(version) {
  const branch = runText("git", ["branch", "--show-current"]);

  run("git", ["add", ...DEPLOY_STAGE_PATHS]);

  const hasChanges = runText("git", ["status", "--porcelain"]);
  if (!hasChanges) {
    console.log("No changes to commit.");
    return;
  }

  run("git", ["commit", "-m", `deploy: v${version} web`]);
  run("git", ["push", "origin", branch]);
}

function main() {
  ensureGitRepo();
  const { nextVersion, buildDate } = updateVersions();
  console.log(`\nBumped to v${nextVersion} (${buildDate})\n`);
  if (process.platform === "win32") {
    run("cmd", ["/c", "npx", "expo", "export", "-p", "web"]);
  } else {
    run("npx", ["expo", "export", "-p", "web"]);
  }
  syncDistToDocs();
  commitAndPush(nextVersion);
  console.log(`\nDone: v${nextVersion} deployed to docs/app and pushed.\n`);
}

main();
