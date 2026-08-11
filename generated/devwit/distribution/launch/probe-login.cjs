// Probe login state on growth channels via existing Chrome CDP (9222).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
fs.mkdirSync(EVIDENCE, { recursive: true });

async function shot(page, name) {
  const p = path.join(EVIDENCE, name);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

async function probe(page, name, url, check) {
  console.log(`\n=== ${name} ===`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const result = await check(page);
  const file = await shot(page, `probe-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
  console.log(JSON.stringify({ name, url: page.url(), ...result, shot: file }, null, 2));
  return result;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  const out = {};

  out.hn = await probe(page, "HN", "https://news.ycombinator.com/submit", async (p) => {
    const body = await p.locator("body").innerText();
    const loggedIn = /logout/i.test(body) || (await p.locator("a[href^='logout']").count()) > 0;
    const hasForm = (await p.locator("input[name='title'], textarea[name='text']").count()) > 0;
    const needsLogin = /You have to be logged in|login/i.test(body) && !loggedIn;
    return { loggedIn, hasForm, needsLogin };
  });

  out.reddit = await probe(page, "Reddit", "https://www.reddit.com/r/programming/submit", async (p) => {
    const url = p.url();
    const body = await p.locator("body").innerText().catch(() => "");
    // Better: look for create post composer
    const composer = (await p.locator('textarea, div[contenteditable="true"], [data-testid="post-composer"]').count()) > 0;
    const loginWall = /log in|sign up to|login to reddit/i.test(body.slice(0, 2000));
    return { loggedIn: !loginWall && (composer || /reddit.com\/user\//.test(url) === false), composer, loginWall, finalUrl: url };
  });

  out.devto = await probe(page, "devto", "https://dev.to/new", async (p) => {
    const body = await p.locator("body").innerText();
    const loginWall = /Log in|Sign up|Continue with GitHub/i.test(body) && !(await p.locator("textarea#article_body_markdown, #article-form-title, [data-testid='article-form-title']").count());
    const editor = (await p.locator("#article-form-title, textarea#article_body_markdown, [name='title']").count()) > 0;
    const user = await p.locator("#nav-profile-image, .crayons-header__menu, a[href*='/settings']").count();
    return { loggedIn: editor || user > 0, editor, loginWall };
  });

  out.juejin = await probe(page, "juejin", "https://juejin.cn/editor/drafts/new", async (p) => {
    await p.waitForTimeout(2000);
    const url = p.url();
    const body = await p.locator("body").innerText().catch(() => "");
    const loginWall = /登录|手机号|验证码|GitHub/.test(body.slice(0, 1500)) && /login|sign/i.test(url + body.slice(0, 300));
    const editor = (await p.locator('.CodeMirror, .bytemd, textarea, [contenteditable="true"]').count()) > 0;
    return { loggedIn: editor && !/passport|login/i.test(url), editor, loginWall, finalUrl: url };
  });

  fs.writeFileSync(path.join(EVIDENCE, "probe-login-state.json"), JSON.stringify(out, null, 2));
  console.log("\nSUMMARY", out);
  await page.close();
  // do not browser.close() — would kill Chrome
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
