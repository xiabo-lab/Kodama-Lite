import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const deb = config.bundle?.linux?.deb;
const destination = "/usr/lib/kodama-lite/tesla-bt-connect.sh";

if (deb?.files?.[destination] !== "../scripts/tesla-bt-connect.sh") {
  throw new Error("Debian package does not contain the Tesla Bluetooth helper");
}
if (deb.postInstallScript !== "deb/postinstall.sh") {
  throw new Error("Debian package does not declare the Bluetooth install hook");
}

const postinstall = readFileSync(
  path.join(root, "src-tauri", deb.postInstallScript),
  "utf8",
);
for (const required of [
  "install -D -m 0755",
  "/usr/local/bin/tesla-bt-connect.sh",
  "systemctl --no-block restart",
]) {
  if (!postinstall.includes(required)) {
    throw new Error(`Bluetooth install hook is missing: ${required}`);
  }
}

console.log("PASS: Debian OTA payload installs and restarts Tesla Bluetooth helper");
