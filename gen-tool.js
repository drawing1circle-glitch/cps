// 在工具页面 (templates.json 里的 tool 地址) 生成 CTA 投放链接：
//   A·模板链接 ← 该剧场的 CTA 模板     B·对比链接 ← 抓到的链接
//   点 “生成链接” → 读 “生成结果” (IOS) → 把 appid 换成包名得到 AOS
//
// 单独使用:
//   node gen-tool.js "<抓到的链接>" [剧场名]           测试一条，打印结果
//   node gen-tool.js links_结果.xlsx [--start 143] [--from G] [--to H]
//                                                     给已抓完的表补生成，结果写入 H 列 (AOS、IOS 两行)

const path = require('path');
const config = require('./templates.json');

const TOOL_URL = process.env.TOOL_URL || config.tool;
const DEBUG = !!process.env.DEBUG;
const log = (...a) => DEBUG && console.log('  [debug]', ...a);

// 根据短链 / 抓到的链接判断剧场，用来选模板
const PRODUCTS = [
  ['DramaBox', /dramabox/i],
  ['FlickReels', /flickreels|playletszyhw|zyhw/i],
  ['ReelShort', /reelshort/i],
  ['GoodShort', /goodshort|goodreels/i],
  ['Saily', /saily/i],
];

function detectProduct(...texts) {
  const t = texts.filter(Boolean).join(' ');
  const hit = PRODUCTS.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

// 读 “生成结果” 里的链接：取 “生成结果” 标题之后第一个以 http 开头的文本块 (不含 A/B 输入框)
function readResult() {
  const heading = [...document.querySelectorAll('body *')].find(
    (el) => el.children.length === 0 && el.textContent.trim() === '生成结果'
  );
  const inputs = [...document.querySelectorAll('textarea')].slice(0, 2);
  const textOf = (el) => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText || '').trim();
  const cands = [...document.querySelectorAll('textarea, input, pre, code, div, p, span, output')].filter((el) => {
    if (inputs.includes(el)) return false;
    if (heading && !(heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const t = textOf(el);
    if (!/^https?:\/\/\S+$/.test(t)) return false;
    // 取最内层的那个元素
    return ![...el.children].some((c) => textOf(c) === t);
  });
  return cands.length ? textOf(cands[0]) : '';
}

async function openTool(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto(TOOL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('textarea').nth(1).waitFor({ timeout: 15000 });
  return page;
}

// 返回 { product, ios, aos, text } ；失败返回 { error }
async function generateOnTool(page, captured, hint) {
  const product = detectProduct(hint, captured);
  if (!product) return { error: '认不出是哪个剧场' };
  const template = config.CTA[product];
  if (!template) return { error: `${product} 还没有 CTA 模板 (templates.json)` };
  const app = config.apps[product];

  const before = await page.evaluate(readResult);
  const boxes = page.locator('textarea');
  await boxes.nth(0).fill(template);
  await boxes.nth(1).fill(captured);
  await page.getByRole('button', { name: '立即对比' }).click({ timeout: 3000 }).catch(() => log('没点到 “立即对比”'));
  await page.getByRole('button', { name: '生成链接' }).click({ timeout: 5000 });

  // 等结果出现 / 变化
  let ios = '';
  for (let i = 0; i < 30; i++) {
    ios = await page.evaluate(readResult);
    if (ios && ios !== before) break;
    await page.waitForTimeout(200);
  }
  if (!ios) {
    if (DEBUG) await page.screenshot({ path: `debug-tool-${Date.now()}.png`, fullPage: true });
    return { error: '工具没有生成结果' };
  }
  log('工具结果', ios.slice(0, 100));
  if (!ios.includes(`/${app.IOS}`)) return { error: `工具结果里没找到 ${app.IOS}，无法替换成 AOS: ${ios.slice(0, 80)}` };
  const aos = ios.replace(`/${app.IOS}`, `/${app.AOS}`);
  return { product, ios, aos, text: `${aos}\n${ios}` };
}

module.exports = { openTool, generateOnTool, detectProduct };

if (require.main === module) (async () => {
  const { launch } = require('./scrape');
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.error('用法: node gen-tool.js "<抓到的链接>" [剧场名]   或   node gen-tool.js links_结果.xlsx [--start 143] [--from G] [--to H]');
    process.exit(1);
  }
  const { browser } = await launch();
  try {
    const page = await openTool(browser);

    if (!/\.xlsx$/i.test(argv[0])) {
      const res = await generateOnTool(page, argv[0], argv[1]);
      if (res.error) console.log('失败:', res.error);
      else console.log(`${res.product}\nAOS: ${res.aos}\n\nIOS: ${res.ios}`);
      return;
    }

    const ExcelJS = require('exceljs');
    const opts = { file: argv[0], start: 143, from: 'G', to: 'H' };
    for (let i = 1; i < argv.length; i++) {
      const k = argv[i].replace(/^--/, '');
      opts[k] = k === 'start' ? +argv[++i] : argv[++i].toUpperCase();
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(opts.file);
    const ws = wb.worksheets[0];
    let ok = 0, fail = 0;
    for (let r = opts.start; r <= ws.rowCount; r++) {
      const v = ws.getCell(`${opts.from}${r}`).value;
      const captured = String((v && typeof v === 'object' ? v.hyperlink || v.text : v) || '');
      if (!/^\w+:\/\/\S+\?/.test(captured)) continue;
      const rowText = [];
      ws.getRow(r).eachCell((c) => rowText.push(typeof c.value === 'object' ? JSON.stringify(c.value) : String(c.value)));
      const res = await generateOnTool(page, captured, rowText.join(' '));
      if (res.error) { fail++; console.log(`第 ${r} 行  ! ${res.error}`); continue; }
      const cell = ws.getCell(`${opts.to}${r}`);
      cell.value = res.text;
      cell.alignment = { ...cell.alignment, wrapText: true };
      ok++;
      console.log(`第 ${r} 行  ${res.product}  已生成 AOS/IOS`);
    }
    const ext = path.extname(opts.file);
    const out = opts.file.slice(0, -ext.length) + '_CTA.xlsx';
    await wb.xlsx.writeFile(out);
    console.log(`\n完成: 成功 ${ok} 行, 失败 ${fail} 行。已保存到 ${out}`);
  } finally {
    await browser.close();
  }
})();
