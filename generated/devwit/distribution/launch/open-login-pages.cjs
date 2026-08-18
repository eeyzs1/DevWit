const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];

  const hn = await ctx.newPage();
  await hn.goto("https://news.ycombinator.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  const logged = (await hn.locator("a[href^='logout']").count()) > 0;
  const user = logged
    ? await hn.locator("a[href^='user?id=']").first().innerText().catch(() => "?")
    : "";
  console.log(JSON.stringify({ hnLogged: logged, user }));

  if (logged) {
    // Log out so user can sign into an aged account
    const logout = hn.locator("a[href^='logout']").first();
    await logout.click();
    await hn.waitForTimeout(1500);
    console.log("logged_out", hn.url());
  }

  await hn.goto("https://news.ycombinator.com/login", { waitUntil: "domcontentloaded" });
  await hn.bringToFront();
  console.log("hn_login", hn.url(), await hn.title());

  const rd = await ctx.newPage();
  await rd.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await rd.bringToFront();
  console.log("reddit_login", rd.url(), await rd.title());

  // leave tabs open
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
