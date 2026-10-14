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
// B 类要点击的按钮文字（多语言，越靠前越优先）；页面换了文案可以用环境变量 CLICK_TEXT 指定（多个用 | 分隔）
const CLICK_TEXTS = process.env.CLICK_TEXT
  ? process.env.CLICK_TEXT.split('|')
  : [
      // 英语
      'Continue Watching', 'Keep Watching', 'Watch Now', 'Watch Full', 'Play Now',
      // 西班牙语 / 葡萄牙语
      'Seguir viendo', 'Continuar viendo', 'Ver ahora', 'Continuar assistindo', 'Continuar a ver', 'Assistir agora',
      // 印尼语 / 马来语 / 菲律宾语
      'Lanjutkan menonton', 'Lanjut nonton', 'Tonton sekarang', 'Teruskan menonton', 'Tonton', 'Ituloy ang panonood', 'Manood ngayon',
      // 泰语 / 越南语
      'ดูต่อ', 'รับชมต่อ', 'ดูเลย', 'ดูตอนนี้', 'Tiếp tục xem', 'Xem ngay', 'Xem tiếp',
      // 法 / 德 / 意 / 土 / 俄 / 波兰
      'Continuer à regarder', 'Continuer', 'Regarder maintenant', 'Weiterschauen', 'Weiter ansehen', 'Jetzt ansehen',
      'Continua a guardare', 'Guarda ora', 'İzlemeye devam et', 'Şimdi izle', 'Продолжить просмотр', 'Смотреть', 'Oglądaj dalej',
      // 日 / 韩 / 中 / 阿拉伯 / 印地
      '続きを見る', '視聴を続ける', '今すぐ見る', '계속 보기', '이어보기', '지금 보기',
      '继续观看', '繼續觀看', '立即观看', '立即觀看', '继续看', 'متابعة المشاهدة', 'شاهد الآن', 'देखना जारी रखें', 'अभी देखें',
      // 很短的词只在按钮文字完全等于它时才点，避免点错
      '=Continue', '=Watch', '=Ver', '=Xem', '=ดู', '=Assistir', '=Play',
    ];
// 文字都匹配不上时，是否兜底点击页面底部最大的按钮 (设 NO_FALLBACK_CLICK=1 关闭)
const FALLBACK_CLICK = !process.env.NO_FALLBACK_CLICK;
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

const DEBUG = !!process.env.DEBUG;
const log = (...a) => DEBUG && console.log('  [debug]', ...a);

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const textRe = (t) => (t.startsWith('=') ? new RegExp(`^\\s*${escapeRe(t.slice(1))}\\s*$`, 'i') : new RegExp(escapeRe(t), 'i'));

// 兜底：点页面底部最宽的那个按钮（落地页的 CTA 一般是底部通栏黄按钮），排除 “Open/打开” 这类顶部按钮
async function clickBottomButton(page) {
  const idx = await page.evaluate(() => {
    const skip = /^\s*(open|abrir|buka|打开|打開|開く|열기|ouvrir|öffnen|เปิด|mở|download|下载|install)\s*$/i;
    const els = [...document.querySelectorAll('button, a, [role=button], div, span')];
    let best = -1, bestBottom = -1;
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const clickable = /^(BUTTON|A)$/.test(el.tagName) || el.getAttribute('role') === 'button' || st.cursor === 'pointer' || el.onclick;
      if (!clickable || st.visibility === 'hidden' || st.display === 'none') return;
      if (r.width < innerWidth * 0.5 || r.height < 30 || r.height > 200) return;
      if (skip.test(el.innerText || '')) return;
      const bottom = r.bottom + scrollY;
      if (bottom > bestBottom) { best = i; bestBottom = bottom; }
    });
    if (best >= 0) document.querySelectorAll('button, a, [role=button], div, span')[best].setAttribute('data-capture-cta', '1');
    return best;
  });
  if (idx < 0) return false;
  const el = page.locator('[data-capture-cta="1"]').first();
  await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await el.click({ timeout: 5000 });
  log(`按文字没找到，已兜底点击底部按钮 “${(await el.innerText().catch(() => '')).trim().slice(0, 30)}”`);
  return true;
}

// 等任意一种语言的按钮出现，再按优先级点第一个看得见的；都没有就兜底点底部按钮
async function clickWatch(page) {
  const any = new RegExp(CLICK_TEXTS.map((t) => (t.startsWith('=') ? `^\\s*${escapeRe(t.slice(1))}\\s*$` : escapeRe(t))).join('|'), 'i');
  await page.getByText(any).filter({ visible: true }).first().waitFor({ timeout: TIMEOUT_MS }).catch(() => log('等待按钮超时'));
  for (const text of CLICK_TEXTS) {
    const el = page.getByText(textRe(text)).filter({ visible: true }).first();
    if (!(await el.count().catch(() => 0))) continue;
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await el.click({ timeout: 5000 });
      log(`已点击 “${text}”`);
      return true;
    } catch (e) {
      log(`没点到 “${text}”: ${e.message.split('\n')[0]}`);
    }
  }
  if (FALLBACK_CLICK) return clickBottomButton(page).catch((e) => (log('兜底点击失败', e.message), false));
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

  let found = null;
  let notify = () => {};
  const done = (url) => {
    if (!found && url && target.test(url) && url !== link) {
      found = KEEP_FRAGMENT || landing ? url : url.split('#')[0];
      notify();
    }
  };
  // 等到抓到目标，或超时
  const waitFound = (ms) =>
    new Promise((resolve) => {
      if (found) return resolve();
      const t = setTimeout(resolve, ms);
      notify = () => { clearTimeout(t); resolve(); };
    });

  // 和 DevTools Network 面板同一个数据源
  cdp.on('Network.requestWillBeSent', (e) => {
    log('请求', e.request.url.slice(0, 120));
    done(e.request.url + (e.request.urlFragment || ''));
    // 302 跳转：Location 指向目标
    if (e.redirectResponse) done(e.redirectResponse.headers.location || e.redirectResponse.headers.Location);
  });
  page.on('framenavigated', (f) => done(f.url()));
  // 点击后如果在新标签页打开，也能抓到
  const onRequest = (req) => done(req.url());
  context.on('request', onRequest);

  try {
    const nav = page
      .goto(link, { waitUntil: landing ? 'domcontentloaded' : 'commit', timeout: TIMEOUT_MS * 2 })
      .catch((e) => log('打开页面:', e.message.split('\n')[0])); // intent:// 无法加载会报错，忽略

    if (!landing) {
      await Promise.race([nav, waitFound(TIMEOUT_MS)]);
      await waitFound(TIMEOUT_MS);
      return found;
    }

    await Promise.race([nav, waitFound(TIMEOUT_MS * 2)]);
    if (found) return found;
    const clicked = await clickWatch(page).catch(() => false);
    if (!clicked) console.error(`  ! 没找到观看按钮: ${link}`);
    // 点击后再等一段时间（页面可能先发统计请求再跳转）
    await waitFound(clicked ? TIMEOUT_MS : 2000);
    if (!found && DEBUG) {
      const shot = `debug-${Date.now()}.png`;
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      log(`当前页面 ${page.url()}，截图已保存 ${shot}`);
    }
    return found;
  } finally {
    context.off('page', onPage);
    context.off('request', onRequest);
    for (const p of [page, ...popups]) await p.close().catch(() => {});
  }
}

async function launch() {
  const browser = await chromium.launch({
    headless: process.env.HEADFUL ? false : true,
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  }).catch(() => chromium.launch({ headless: !process.env.HEADFUL, args: ['--disable-blink-features=AutomationControlled'] }));

  // 对应截图里的 Dimensions: Samsung 360 x 800
  const context = await browser.newContext({
    ...devices['Galaxy S9+'],
    viewport: { width: 360, height: 800 },
    // 浏览器语言设成英文，支持多语言的落地页会优先显示英文按钮；可用 LOCALE 改
    locale: process.env.LOCALE || 'en-US',
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
