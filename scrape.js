// 自动完成截图里的步骤：
//   1. 用手机模式 (Samsung, 360x800) 打开 onelink 短链
//   2. 在 Network 面板里找到被拦截的 intent://open?... 请求
//   3. 复制它的 Request URL
//
// 用法:
//   node scrape.js <链接1> [链接2 ...]
//   node scrape.js -f links.txt          (每行一个链接)
// 结果打印到终端，并写入 results.csv

const fs = require('fs');
const { chromium, devices } = require('playwright-core');

const TIMEOUT_MS = 20000;
// 截图里抓到的链接以 intent:// 开头；也兼容直接跳 dramabox:// 的情况
const TARGET = /^(intent|dramabox):\/\//i;
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

async function capture(context, link) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      const done = (url) => {
        if (url && TARGET.test(url)) {
          clearTimeout(timer);
          resolve(KEEP_FRAGMENT ? url : url.split('#')[0]);
        }
      };
      // 和 DevTools Network 面板同一个数据源
      cdp.on('Network.requestWillBeSent', (e) => {
        done(e.request.url + (e.request.urlFragment || ''));
        // 302 跳转：Location 指向 intent://
        if (e.redirectResponse) done(e.redirectResponse.headers.location || e.redirectResponse.headers.Location);
      });
      page.on('framenavigated', (f) => done(f.url()));

      page.goto(link, { waitUntil: 'commit', timeout: TIMEOUT_MS }).catch(() => {
        // intent:// 无法加载会报 ERR_ABORTED / ERR_UNKNOWN_URL_SCHEME，这里忽略
      });
    });
  } finally {
    await page.close();
  }
}

(async () => {
  const links = parseArgs(process.argv.slice(2));
  if (!links.length) {
    console.error('用法: node scrape.js <链接...>  或  node scrape.js -f links.txt');
    process.exit(1);
  }

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
