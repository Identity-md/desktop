// Signs one Windows program for the release: `tauri build` runs this on each it makes, the app, NSIS's own and the
// installer, with release.mjs having put an Azure access token in the environment. Azure Artifact Signing, through
// jsign, which signs on a Mac, and timestamped by Microsoft's own authority, so the signature outlives the
// certificate, which Azure renews every few days.
import { execFileSync } from "node:child_process";

const [file] = process.argv.slice(2);
const { IMD_SIGNING_TOKEN: token, IMD_SIGNING_ENDPOINT: endpoint, IMD_SIGNING_ALIAS: alias } = process.env;
if (!file || !token || !endpoint || !alias) {
  console.error("sign-windows: release.mjs runs this, with a file to sign and the signing token in the environment");
  process.exit(1);
}
execFileSync("jsign", ["--storetype", "TRUSTEDSIGNING", "--keystore", endpoint, "--storepass", token, "--alias", alias, "--tsaurl", "http://timestamp.acs.microsoft.com", "--tsmode", "RFC3161", file], { stdio: "inherit" });
