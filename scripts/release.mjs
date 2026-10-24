// Releases IMD Agents from the maintainer's Mac: `pnpm release 0.1.1`, or `pnpm release --dry-run`
// to build, sign and notarize the current version without publishing anything.
//
// Signing stays on this Mac on purpose. The Developer ID certificate, the notarization credentials,
// the Azure credentials that sign for Windows and the key that signs updates live in this Mac's
// keychain, never in GitHub's secrets, where anyone able to push a workflow to the repository could
// use them.
//
// 1. Checks: a clean main equal to origin, a new version, the certificate, the update key, and for
//    Windows the tools that build for it here and the credentials that sign for it.
// 2. Builds one app for Apple Silicon and Intel, signed with the Developer ID.
// 3. Notarizes and staples the app, builds the disk image around it, notarizes and staples that,
//    and asks Gatekeeper about both, as Finder will.
// 4. Builds the Windows installer here too, for x64, each program in it signed with Azure Artifact
//    Signing as the build makes it.
// 5. Writes latest.json, which installed copies read to update themselves.
// 6. Commits the version, then publishes the disk image, the Windows installer, the update and
//    latest.json as a GitHub release, a draft until every file is up.
//
// `--mac-only` leaves Windows out, while its signing isn't set up; its installed copies then stay on
// the version before.
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
// Windows, built here with cargo-xwin and NSIS (brew install llvm lld makensis jsign sevenzip; cargo install --locked
// cargo-xwin) and signed with Azure Artifact Signing, as Skillet's Windows app is, by its account and
// certificate profile. The app registration that signs is in the keychain under KEY_SERVICE, as
// azure-tenant-id, azure-client-id and azure-client-secret.
const WINDOWS = "x86_64-pc-windows-msvc";
const AZURE_ENDPOINT = process.env.AZURE_SIGNING_ENDPOINT ?? "eus.codesigning.azure.net";
const AZURE_ALIAS = process.env.AZURE_SIGNING_ALIAS ?? "skillet/skillet";
const LLVM = ["/opt/homebrew/opt/llvm/bin", "/opt/homebrew/opt/lld/bin"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const macOnly = args.includes("--mac-only");
const notesAt = args.indexOf("--notes");
const notes = notesAt >= 0 ? args[notesAt + 1] : null;
const asked = args.find((arg, i) => /^\d+\.\d+\.\d+$/.test(arg) && args[i - 1] !== "--notes");

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const step = (text) => console.log(`\n· ${text}`);
const fail = (text) => { console.error(`\n✗ ${text}`); process.exit(1); };
const kept = (account) => {
  try { return run("security", ["find-generic-password", "-s", KEY_SERVICE, "-a", account, "-w"]); }
  catch { return null; }
};
const secret = (account) => kept(account) ?? fail(`No ${account} in the keychain under ${KEY_SERVICE}. It is made once with \`tauri signer generate\`.`);
const newer = (a, b) => { const [x, y] = [a, b].map((v) => v.split(".").map(Number)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** An access token for Azure Artifact Signing, from the app registration's own credentials: good for an hour, a build's worth. */
const azureToken = async ({ tenant, client, secret }) => {
  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: client, client_secret: secret, scope: "https://codesigning.azure.net/.default" }),
  });
  const body = await response.json().catch(() => ({}));
  return body.access_token ?? fail(`Azure refused the Windows signing credentials: ${body.error_description ?? response.status}`);
};

/** Whether a Windows program carries a signature: its certificate table, the fifth of the PE header's data directories, isn't empty. */
const signedPE = (file) => {
  const pe = readFileSync(file);
  const optional = pe.readUInt32LE(0x3c) + 24;
  const directories = optional + (pe.readUInt16LE(optional) === 0x20b ? 112 : 96);
  return pe.readUInt32LE(directories + 4 * 8 + 4) > 0;
};

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
// Windows: its target, the cross-compiler, NSIS and LLVM's resource compiler, and the signer and its credentials. A dry
// run without the credentials builds it unsigned, to try the build; a release can't.
let azure = null;
if (!macOnly) {
  if (!run("rustup", ["target", "list", "--installed"]).split("\n").includes(WINDOWS)) run("rustup", ["target", "add", WINDOWS]);
  try { run("cargo", ["xwin", "--version"]); } catch { fail("Windows builds here with cargo-xwin: cargo install --locked cargo-xwin (or release with --mac-only)"); }
  try { run("makensis", ["-VERSION"]); } catch { fail("Windows' installer needs NSIS: brew install makensis (or release with --mac-only)"); }
  if (!existsSync(join(LLVM[0], "llvm-rc"))) fail("Windows builds here with LLVM: brew install llvm lld (or release with --mac-only)");
  const [tenant, client, secretKey] = ["azure-tenant-id", "azure-client-id", "azure-client-secret"].map(kept);
  if (tenant && client && secretKey) azure = { tenant, client, secret: secretKey };
  else if (!dryRun) fail(`No Windows signing credentials: azure-tenant-id, azure-client-id and azure-client-secret in the keychain under ${KEY_SERVICE}. Add them, or release with --mac-only.`);
  if (azure) {
    try { run("jsign", ["--help"]); } catch { fail("Windows signs here with jsign: brew install jsign"); }
    try { run("7zz", ["i"]); } catch { fail("The Windows installer is opened to check what's in it with 7-Zip: brew install sevenzip"); }
  }
}
console.log(`  ${NAME} ${version}${dryRun ? " (dry run: nothing is committed or published)" : ""}, signed by team ${TEAM_ID}${macOnly ? ", Mac only" : azure ? ` and for Windows by ${AZURE_ALIAS}` : ", Windows unsigned"}`);

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

// Windows: the same version, cross-compiled here for x64 into a per-user NSIS installer. `tauri build` runs
// sign-windows.mjs on each program as it makes it, the app, NSIS's own and the installer last, and only then signs
// the installer for the updater, so the update installed copies fetch is the signed installer itself.
let windows = null;
if (!macOnly) {
  step(`Building for Windows (x64)${azure ? `, signed by ${AZURE_ALIAS}` : ", unsigned"}`);
  const env = { ...process.env, PATH: [...LLVM, process.env.PATH].join(":"), TAURI_SIGNING_PRIVATE_KEY: updaterKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: updaterPassword };
  if (azure) Object.assign(env, { IMD_SIGNING_TOKEN: await azureToken(azure), IMD_SIGNING_ENDPOINT: AZURE_ENDPOINT, IMD_SIGNING_ALIAS: AZURE_ALIAS });
  // the signer by absolute paths, as the installer's own build runs it from another folder; nothing secret in them,
  // as they are written into the installer's script
  const signing = azure ? { windows: { signCommand: { cmd: process.execPath, args: [join(ROOT, "scripts/sign-windows.mjs"), "%1"] } } } : {};
  const built = spawnSync("pnpm", ["tauri", "build", "--runner", "cargo-xwin", "--target", WINDOWS, "--bundles", "nsis", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true, ...signing } })], { cwd: ROOT, stdio: "inherit", env });
  if (built.status !== 0) fail("The Windows build failed.");
  const setup = join(ROOT, `src-tauri/target/${WINDOWS}/release/bundle/nsis/${NAME}_${version}_x64-setup.exe`);
  for (const file of [setup, `${setup}.sig`]) if (!existsSync(file)) fail(`The Windows build left no ${file}.`);
  if (azure) {
    // the installer, and the app and its uninstaller in it, as Windows meets them: the build signs the app before it
    // packs it, then puts the unsigned one back where it built it, so the packed one is the one to look at
    const unpacked = join(out, "windows-unpacked");
    run("7zz", ["x", `-o${unpacked}`, "-y", setup]);
    for (const file of [setup, join(unpacked, "imd-agents.exe"), join(unpacked, "uninstall.exe")]) if (!signedPE(file)) fail(`${file} isn't signed.`);
    rmSync(unpacked, { recursive: true });
    console.log("  the installer, and the app and uninstaller in it, are signed");
  }
  cpSync(setup, join(out, "IMD-Agents-Setup.exe"));
  windows = { signature: readFileSync(`${setup}.sig`, "utf8").trim(), url: `https://github.com/${REPO}/releases/download/v${version}/IMD-Agents-Setup.exe` };
}

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
  // One build runs on both Macs, so both point at it; Windows updates by running its new installer.
  platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform, ...(windows ? { "windows-x86_64": windows } : {}) },
}, null, 2)}\n`);
console.log(`  ${out}: IMD-Agents.dmg, IMD-Agents.app.tar.gz${windows ? ", IMD-Agents-Setup.exe" : ""}, latest.json`);

if (dryRun) {
  console.log(`\n✓ Dry run: built, signed, notarized and stapled${windows && !azure ? ", Windows unsigned" : ""}. Nothing was committed or published.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
step(`Committing ${version} and publishing v${version}`);
run("git", ["add", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "package.json"]);
run("git", ["commit", "--quiet", "-m", `Release ${version}`]);
run("git", ["push", "--quiet", "origin", "main"]);
const sha = run("git", ["rev-parse", "HEAD"]);
run("gh", ["release", "create", `v${version}`, "--repo", REPO, "--target", sha, "--title", `${NAME} ${version}`, "--notes", notes ?? `${NAME} ${version}`, "--draft",
  join(out, "IMD-Agents.dmg"), join(out, "IMD-Agents.app.tar.gz"), ...(windows ? [join(out, "IMD-Agents-Setup.exe")] : []), join(out, "latest.json")]);
run("gh", ["release", "edit", `v${version}`, "--repo", REPO, "--draft=false", "--latest"]);
console.log(`\n✓ ${NAME} ${version} is out: https://github.com/${REPO}/releases/tag/v${version}`);
console.log(`  Download: https://github.com/${REPO}/releases/latest/download/IMD-Agents.dmg`);
if (windows) console.log(`  Windows: https://github.com/${REPO}/releases/latest/download/IMD-Agents-Setup.exe`);
