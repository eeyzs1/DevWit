/** 一次性工具：下载 v0.1.1 真实发布资产并计算 SHA256（winget/Homebrew 清单数据源）。用完即删。 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const release = JSON.parse(fs.readFileSync(path.join(ROOT, "release-v011.json"), "utf-8"));
const WANTED = ["DevWit.Setup.0.1.1.exe", "DevWit-0.1.1-arm64.dmg"];

for (const name of WANTED) {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) { console.error(`MISSING: ${name}`); process.exitCode = 1; continue; }
  const target = path.join(ROOT, name);
  if (!fs.existsSync(target) || fs.statSync(target).size !== asset.size) {
    console.log(`下载 ${name} (${(asset.size / 1048576).toFixed(1)}MB)…`);
    const res = await fetch(asset.browser_download_url, { redirect: "follow" });
    if (!res.ok) { console.error(`HTTP ${res.status}: ${name}`); process.exitCode = 1; continue; }
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  }
  const size = fs.statSync(target).size;
  if (size !== asset.size) { console.error(`SIZE MISMATCH: ${name} ${size} != ${asset.size}`); process.exitCode = 1; continue; }
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(target));
  console.log(`OK ${name} | size=${size} | sha256=${hash.digest("hex")}`);
}
