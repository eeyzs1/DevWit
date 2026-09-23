// HN 账号创建（v0.7.30 版）——只建号+验证登录，不提交
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.join(__dirname, "evidence");
const CREDS = path.resolve(__dirname, "..", "..", "launch-credentials.env");
const log = (m) => console.log(`[hn ${new Date().toISOString()}] ${m}`);

function upsertCred(key, value) {
  let raw = fs.existsSync(CREDS) ? fs.readFileSync(CREDS, "utf8") : "";
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, "m").test(raw)) {
    raw = raw.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else {
    raw = raw.replace(/\s*$/, "") + `\n\n# Hacker News (Show HN)\n${line}\n`;
  }
  fs.writeFileSync(CREDS, raw);
}

const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(45000);

const candidates = ["devwit_ide", "eeyzs1_devwit", "devwit_hn", "devwit_editor"];
const password = "Dw!" + crypto.randomBytes(9).toString("base64url");

let username = null;
for (const u of candidates) {
  await page.goto("https://news.ycombinator.com/login?goto=submit", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  log(`try create account: ${u}`);
  const createForm = page.locator("form").nth(1);
  await createForm.locator("input[name='acct']").fill(u);
  await createForm.locator("input[name='pw']").fill(password);
  await createForm.locator("input[type='submit']").click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(EVIDENCE, `hn-create-${u}.png`), fullPage: true });
  const body = await page.locator("body").innerText();
  const ok =
    (await page.locator("a[href^='logout']").count()) > 0 ||
    /logout/i.test(body) ||
    (page.url().includes("submit") && (await page.locator("input[name='title']").count()) > 0);
  if (ok) {
    username = u;
    log(`account ready: ${u}`);
    break;
  }
  log(`failed ${u}: ${body.slice(0, 200).replace(/\s+/g, " ")}`);
}

if (!username) {
  fs.writeFileSync(path.join(EVIDENCE, "hn-account-failed.txt"), "Could not create HN account");
  await page.close();
  console.error("❌ 账号创建失败（截图见 evidence/hn-create-*.png）");
  process.exit(4);
}

upsertCred("HN_USERNAME", username);
upsertCred("HN_PASSWORD", password);
log("credentials saved to launch-credentials.env");
await page.close();
console.log(`✅ HN 账号就绪: ${username}（已登录，等最佳窗口提交）`);
process.exit(0);
