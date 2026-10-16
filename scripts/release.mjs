// Releases IMD Agents from the maintainer's Mac: `pnpm release 0.1.1`, or `pnpm release --dry-run`
// to build, sign and notarize the current version without publishing anything.
//
// Signing stays on this Mac on purpose. The Developer ID certificate, the notarization credentials
// and the key that signs updates live in this Mac's keychain, never in GitHub's secrets, where
// anyone able to push a workflow to the repository could use them.
//
// 1. Checks: a clean main equal to origin, a new version, the certificate, the update key.
// 2. Builds one app for Apple Silicon and Intel, signed with the Developer ID.
// 3. Notarizes and staples the app, builds the disk image around it, notarizes and staples that,
//    and asks Gatekeeper about both, as Finder will.
// 4. Writes latest.json, which installed copies read to update themselves.
// 5. Commits the version, then publishes the disk image, the update and latest.json as a GitHub
//    release, a draft until every file is up.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ICONS, TITLE_BAR, WINDOW } from "./installer/window.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const REPO = "Identity-md/desktop";
const NAME = "IMD Agents";
// The Developer ID's team, and the keychain profile `xcrun notarytool store-credentials` saved for it.
const TEAM_ID = process.env.APPLE_TEAM_ID ?? "P4HYHYKX7H";
const NOTARY_PROFILE = process.env.NOTARY_PROFILE ?? "skillet-notary";
// The update key, made once with `tauri signer generate` and kept only in the keychain.
const KEY_SERVICE = "fun.imd.agents.release";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const notesAt = args.indexOf("--notes");
const notes = notesAt >= 0 ? args[notesAt + 1] : null;
const asked = args.find((arg, i) => /^\d+\.\d+\.\d+$/.test(arg) && args[i - 1] !== "--notes");

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const step = (text) => console.log(`\n· ${text}`);
const fail = (text) => { console.error(`\n✗ ${text}`); process.exit(1); };
const secret = (account) => {
  try { return run("security", ["find-generic-password", "-s", KEY_SERVICE, "-a", account, "-w"]); }
  catch { return fail(`No ${account} in the keychain under ${KEY_SERVICE}. It is made once with \`tauri signer generate\`.`); }
};
const newer = (a, b) => { const [x, y] = [a, b].map((v) => v.split(".").map(Number)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

// ---------------------------------------------------------------------------------------------
step("Checking");
const confPath = join(ROOT, "src-tauri/tauri.conf.json");
const cargoPath = join(ROOT, "src-tauri/Cargo.toml");
const pkgPath = join(ROOT, "package.json");
const current = JSON.parse(readFileSync(confPath, "utf8")).version;
const cargoVersion = readFileSync(cargoPath, "utf8").match(/^version = "(.*)"/m)?.[1];
const pkgVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
if (cargoVersion !== current || pkgVersion !== current) fail(`Versions disagree: tauri.conf.json ${current}, Cargo.toml ${cargoVersion}, package.json ${pkgVersion}.`);
const version = dryRun ? current : asked ?? fail("Say which version: pnpm release 0.1.1 (or --dry-run).");
if (!dryRun) {
  if (!newer(version, current)) fail(`${version} is not newer than ${current}.`);
  if (run("git", ["branch", "--show-current"]) !== "main") fail("Release from main.");
  if (run("git", ["status", "--porcelain"])) fail("Commit or stash your changes first.");
  run("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
  if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", "origin/main"])) fail("main is not the same as origin/main.");
  if (run("git", ["tag", "--list", `v${version}`])) fail(`v${version} is already tagged.`);
  run("gh", ["auth", "status"]);
}
const identity = run("security", ["find-identity", "-v", "-p", "codesigning"])
  .split("\n").find((line) => line.includes("Developer ID Application") && line.includes(`(${TEAM_ID})`))?.match(/\b([0-9A-F]{40})\b/)?.[1];
if (!identity) fail(`No Developer ID Application certificate for team ${TEAM_ID} in the keychain.`);
const updaterKey = secret("updater-key");
const updaterPassword = secret("updater-password");
for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
  if (!run("rustup", ["target", "list", "--installed"]).split("\n").includes(target)) run("rustup", ["target", "add", target]);
}
try { run("create-dmg", ["--version"]); } catch { fail("The disk image needs create-dmg: brew install create-dmg"); }
console.log(`  ${NAME} ${version}${dryRun ? " (dry run: nothing is committed or published)" : ""}, signed by team ${TEAM_ID}`);

// ---------------------------------------------------------------------------------------------
const bumped = !dryRun && version !== current;
const restore = () => { if (bumped) run("git", ["checkout", "--", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "package.json"]); };
process.on("exit", (code) => { if (code !== 0) restore(); });
if (bumped) {
  step(`Setting the version to ${version}`);
  writeFileSync(confPath, readFileSync(confPath, "utf8").replace(`"version": "${current}"`, `"version": "${version}"`));
  writeFileSync(cargoPath, readFileSync(cargoPath, "utf8").replace(/^version = ".*"/m, `version = "${version}"`));
  writeFileSync(pkgPath, readFileSync(pkgPath, "utf8").replace(`"version": "${current}"`, `"version": "${version}"`));
}

step("Building for Apple Silicon and Intel, signed with the Developer ID");
const build = spawnSync("pnpm", ["tauri", "build", "--target", "universal-apple-darwin", "--bundles", "app", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true } })], {
  cwd: ROOT,
  stdio: "inherit",
  // The certificate by its hash: the same certificate can sit in two keychains under one name.
  env: { ...process.env, APPLE_SIGNING_IDENTITY: identity, TAURI_SIGNING_PRIVATE_KEY: updaterKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: updaterPassword },
});
if (build.status !== 0) fail("The build failed.");
const bundle = join(ROOT, "src-tauri/target/universal-apple-darwin/release/bundle/macos");
const app = join(bundle, `${NAME}.app`);
const tarball = `${app}.tar.gz`;
for (const file of [app, tarball, `${tarball}.sig`]) if (!existsSync(file)) fail(`The build left no ${file}.`);
const signature = spawnSync("codesign", ["-dvv", app], { encoding: "utf8" }).stderr;
if (!signature.includes(`TeamIdentifier=${TEAM_ID}`) || !signature.includes("Authority=Developer ID Application")) fail("The app is not signed with the Developer ID.");
run("codesign", ["--verify", "--deep", "--strict", app]);

const out = join(ROOT, "src-tauri/target/release-files");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const notarize = (file) => {
  const answer = JSON.parse(run("xcrun", ["notarytool", "submit", file, "--keychain-profile", NOTARY_PROFILE, "--wait", "--output-format", "json"], { timeout: 60 * 60 * 1000 }));
  if (answer.status !== "Accepted") {
    const log = spawnSync("xcrun", ["notarytool", "log", answer.id, "--keychain-profile", NOTARY_PROFILE], { encoding: "utf8" }).stdout;
    fail(`Apple did not accept ${file}: ${answer.status}\n${log}`);
  }
  console.log(`  accepted (${answer.id})`);
};
const assess = (argv, file) => {
  const verdict = spawnSync("spctl", [...argv, "-vv", file], { encoding: "utf8" });
  const said = `${verdict.stdout}${verdict.stderr}`;
  if (verdict.status !== 0 || !said.includes("accepted") || !said.includes("Notarized Developer ID")) fail(`Gatekeeper refuses ${file}:\n${said}`);
  console.log(`  Gatekeeper: accepted, Notarized Developer ID`);
};

step("Notarizing the app");
const zip = join(out, "app.zip");
run("ditto", ["-c", "-k", "--keepParent", app, zip]);
notarize(zip);
rmSync(zip);
run("xcrun", ["stapler", "staple", app]);
assess(["--assess", "--type", "execute"], app);

step("Building, signing and notarizing the disk image");
// The window it opens on: imd.fun's wall around a lit monitor holding the app, an arrow and Applications
// (scripts/installer/background.mjs draws it for window.mjs's points). create-dmg lays it out through Finder.
const stage = join(out, "stage");
mkdirSync(stage);
run("ditto", [app, join(stage, `${NAME}.app`)]);
const dmg = join(out, "IMD-Agents.dmg");
run("create-dmg", ["--volname", NAME, "--background", join(ROOT, "src-tauri/installer/dmg-background.tiff"),
  "--window-pos", "200", "120", "--window-size", String(WINDOW.width), String(WINDOW.height + TITLE_BAR), "--icon-size", "128", "--text-size", "12",
  "--icon", `${NAME}.app`, ...ICONS.app.map(String), "--hide-extension", `${NAME}.app`, "--app-drop-link", ...ICONS.applications.map(String),
  "--no-internet-enable", dmg, stage], { timeout: 10 * 60 * 1000 });
rmSync(stage, { recursive: true });
run("codesign", ["--sign", identity, "--timestamp", dmg]);
notarize(dmg);
run("xcrun", ["stapler", "staple", dmg]);
assess(["--assess", "--type", "open", "--context", "context:primary-signature"], dmg);

// The update is the app as signed, before stapling: the same code Apple notarized, and an update
// the app downloads itself is never quarantined, so Gatekeeper does not ask for the ticket.
step("Writing the update");
cpSync(tarball, join(out, "IMD-Agents.app.tar.gz"));
const url = `https://github.com/${REPO}/releases/download/v${version}/IMD-Agents.app.tar.gz`;
const platform = { signature: readFileSync(`${tarball}.sig`, "utf8").trim(), url };
writeFileSync(join(out, "latest.json"), `${JSON.stringify({
  version,
  notes: notes ?? `${NAME} ${version}`,
  pub_date: new Date().toISOString(),
  // One build runs on both, so both point at it.
  platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform },
}, null, 2)}\n`);
console.log(`  ${out}: IMD-Agents.dmg, IMD-Agents.app.tar.gz, latest.json`);

if (dryRun) {
  console.log("\n✓ Dry run: built, signed, notarized and stapled. Nothing was committed or published.");
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
step(`Committing ${version} and publishing v${version}`);
run("git", ["add", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "package.json"]);
run("git", ["commit", "--quiet", "-m", `Release ${version}`]);
run("git", ["push", "--quiet", "origin", "main"]);
const sha = run("git", ["rev-parse", "HEAD"]);
run("gh", ["release", "create", `v${version}`, "--repo", REPO, "--target", sha, "--title", `${NAME} ${version}`, "--notes", notes ?? `${NAME} ${version}`, "--draft",
  join(out, "IMD-Agents.dmg"), join(out, "IMD-Agents.app.tar.gz"), join(out, "latest.json")]);
run("gh", ["release", "edit", `v${version}`, "--repo", REPO, "--draft=false", "--latest"]);
console.log(`\n✓ ${NAME} ${version} is out: https://github.com/${REPO}/releases/tag/v${version}`);
console.log(`  Download: https://github.com/${REPO}/releases/latest/download/IMD-Agents.dmg`);
