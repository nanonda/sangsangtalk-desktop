import fs from "node:fs";

const thumb = fs.readFileSync(process.env.THUMB_FILE, "utf8").trim();
if (!/^[A-Fa-f0-9]{40}$/.test(thumb)) {
  console.error("Signing was requested but the imported certificate thumbprint had an unexpected form. It was not printed.");
  process.exit(1);
}

const configPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.bundle.windows = config.bundle.windows || {};
config.bundle.windows.certificateThumbprint = thumb;
config.bundle.windows.digestAlgorithm = "sha256";
config.bundle.windows.timestampUrl = "http://timestamp.digicert.com";
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log("certificate thumbprint applied to the runner config");
