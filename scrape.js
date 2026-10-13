// 自动完成在 DevTools Network 面板里手动抓链接的步骤，支持两种链接：
//
//   A. onelink 短链 (如 DramaBox: dramabox.onelink.me/dqUm/xxx)
//      手机模式打开 → 抓被拦截的 intent://open?... 请求
//
//   B. 落地页 (如 FlickReels: flickreels.net/landing_page/xxx)
//      手机模式打开 → 点击 “Continue Watching” → 抓随后出现的 xxx.onelink.me/...?af_js_web=true... 请求
//
// 用法:
//   node scrape.js <链接1> [链接2 ...]
//   node scrape.js -f links.txt          (每行一个链接)
// 结果打印到终端，并写入 results.csv

const fs = require('fs');
const { chromium, devices } = require('playwright-core');

const TIMEOUT_MS = 20000;
// A 类：抓到的链接以 intent:// 开头；也兼容直接跳 dramabox:// 的情况
const INTENT = /^(intent|dramabox):\/\//i;
// B 类：点击按钮后跳去的 onelink 地址
const ONELINK = /^https?:\/\/[^/?#]*onelink\.me\//i;
// B 类要点击的按钮文字；页面换了文案可以用环境变量 CLICK_TEXT 指定
const CLICK_TEXTS = process.env.CLICK_TEXT
  ? [process.env.CLICK_TEXT]
  : ['Continue Watching', 'Watch Now', 'Continue', 'Watch', '继续观看', '立即观看'];
// 默认和 DevTools 里的 Request URL 一样，去掉 #Intent;...;end 部分；设置 KEEP_FRAGMENT=1 可保留
const KEEP_FRAGMENT = !!process.env.KEEP_FRAGMENT;

function parseArgs(argv) {
  const links = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-f') {
      links.push(...fs.readFileSync(argv[++i], 'utf8').split(/\r?\n/));
    } else {
      links.push(argv[i]);
    }
  }
  return links
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^https?:\/\//i.test(l) ? l : `https://${l}`));
}

function isOnelink(link) {
  return ONELINK.test(link);
}

// 依次尝试按钮文字，点到第一个能点的
async function clickWatch(page) {
  for (const text of CLICK_TEXTS) {
    const el = page.getByText(text, { exact: false }).first();
    try {
      await el.waitFor({ state: 'visible', timeout: text === CLICK_TEXTS[0] ? TIMEOUT_MS / 2 : 1000 });
      await el.click({ timeout: 3000 });
      return true;
    } catch {}
  }
  return false;
}

async function capture(context, link) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const landing = !isOnelink(link);
  const target = landing ? ONELINK : INTENT;

  const popups = [];
  const onPage = (p) => popups.push(p);
  context.on('page', onPage);

  let onRequest;
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      const done = (url) => {
        if (url && target.test(url) && url !== link) {
          clearTimeout(timer);
          resolve(KEEP_FRAGMENT || landing ? url : url.split('#')[0]);
        }
      };
      // 和 DevTools Network 面板同一个数据源
      cdp.on('Network.requestWillBeSent', (e) => {
        done(e.request.url + (e.request.urlFragment || ''));
        // 302 跳转：Location 指向目标
        if (e.redirectResponse) done(e.redirectResponse.headers.location || e.redirectResponse.headers.Location);
      });
      page.on('framenavigated', (f) => done(f.url()));
      // 点击后如果在新标签页打开，也能抓到
      onRequest = (req) => done(req.url());
      context.on('request', onRequest);

      page
        .goto(link, { waitUntil: landing ? 'domcontentloaded' : 'commit', timeout: TIMEOUT_MS })
        .catch(() => {
          // intent:// 无法加载会报 ERR_ABORTED / ERR_UNKNOWN_URL_SCHEME，这里忽略
        })
        .then(async () => {
          if (landing && !(await clickWatch(page).catch(() => false))) {
            console.error(`  ! 没找到 “${CLICK_TEXTS[0]}” 按钮: ${link}`);
            // 再等 2 秒，给已经发出的跳转留时间，然后放弃
            setTimeout(() => { clearTimeout(timer); resolve(null); }, 2000);
          }
        });
    });
  } finally {
    context.off('page', onPage);
    if (onRequest) context.off('request', onRequest);
    for (const p of [page, ...popups]) await p.close().catch(() => {});
  }
}

async function launch() {
  const browser = await chromium.launch({
    headless: process.env.HEADFUL ? false : true,
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : 'chrome',
  }).catch(() => chromium.launch({ headless: !process.env.HEADFUL }));

  // 对应截图里的 Dimensions: Samsung 360 x 800
  const context = await browser.newContext({
    ...devices['Galaxy S9+'],
    viewport: { width: 360, height: 800 },
  });
  return { browser, context };
}

module.exports = { launch, capture };

if (require.main === module) (async () => {
  const links = parseArgs(process.argv.slice(2));
  if (!links.length) {
    console.error('用法: node scrape.js <链接...>  或  node scrape.js -f links.txt');
    process.exit(1);
  }

  const { browser, context } = await launch();

  const rows = [['short_link', 'intent_url']];
  for (const link of links) {
    const url = await capture(context, link);
    console.log(`${link}\n  -> ${url || '未抓到 (超时)'}\n`);
    rows.push([link, url || '']);
  }
  await browser.close();

  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  fs.writeFileSync('results.csv', '﻿' + csv);
  console.log('已保存到 results.csv');
})();
