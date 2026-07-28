/**
 * CI 辅助（release.yml build-windows，门控 vars.AZURE_SIGN_ENABLED=true 才执行）：
 * 把 Azure Trusted Signing 配置注入 electron-builder.yml。
 * 签名配置不落盘仓库——账户元数据经环境变量传入；未启用时构建保持未签名现状。
 * electron-builder ≥25.1 原生支持 win.azureSignOptions（与 signtoolOptions 互斥），
 * 认证走标准 AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET 环境变量。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REQUIRED = ["AZURE_SIGN_PUBLISHER", "AZURE_SIGN_ENDPOINT", "AZURE_SIGN_ACCOUNT", "AZURE_SIGN_PROFILE"];
const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`DW_SIGN_ENV_MISSING:${missing.join(",")}`);
  process.exit(1);
}

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron-builder.yml");
const config = yaml.load(fs.readFileSync(target, "utf-8"));
config.win = config.win ?? {};
delete config.win.signtoolOptions;
config.win.azureSignOptions = {
  publisherName: process.env.AZURE_SIGN_PUBLISHER,
  endpoint: process.env.AZURE_SIGN_ENDPOINT,
  codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT,
  certificateProfileName: process.env.AZURE_SIGN_PROFILE,
};
fs.writeFileSync(target, yaml.dump(config));
console.log(`azure signing enabled: account=${process.env.AZURE_SIGN_ACCOUNT} profile=${process.env.AZURE_SIGN_PROFILE}`);
