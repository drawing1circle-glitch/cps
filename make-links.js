// 按固定规则，把 G 列抓到的链接转换成投放链接，写入 H 列（H 列已有内容的行不动）
//
// 用法:
//   node make-links.js links_new_结果.xlsx [--start 2] [--from G] [--to H] [--overwrite]
//
// 目前支持：GoodShort（按推广任务名称里的 IOS / AOS 区分）
//   投放链接 = 平台前缀 + 抓到链接的全部参数（原样）+ 固定后缀

const path = require('path');
const ExcelJS = require('exceljs');

const RULES = {
  GoodShort: {
    match: /goodshort/i,
    IOS: {
      prefix: 'https://app.appsflyer.com/id6448176203?',
      suffix: '&redirect=false&af_reengagement_window=lifetime&is_retargeting=true&pid={dynamicpid}&af_ip={ip}&af_model=iphone&af_os_version=26.6.1',
    },
    AOS: {
      prefix: 'https://app.appsflyer.com/com.newreading.goodreels?',
      suffix: '&redirect=false&af_reengagement_window=lifetime&is_retargeting=true&pid={dynamicpid}&af_ua={ua}&af_ip={ip}&af_model={device_model}&af_os_version={osv}&advertising_id={gaid}',
    },
  },
};

function text(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.hyperlink || v.text || (v.richText || []).map((t) => t.text).join('') || v.result || '');
  return String(v);
}

// 取抓到链接 ? 后面、# 前面的全部参数
function query(url) {
  const q = url.split('#')[0];
  const i = q.indexOf('?');
  return i < 0 ? '' : q.slice(i + 1);
}

function osOf(taskName) {
  const m = taskName.match(/(?:^|[-_{\s])(IOS|AOS)(?=[-_{}\s]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

function build(product, taskName, captured) {
  const rule = RULES[product];
  const os = osOf(taskName);
  if (!os) return { error: '推广任务名称里看不出 IOS / AOS' };
  const q = query(captured);
  if (!q) return { error: 'G 列链接没有参数' };
  return { os, url: rule[os].prefix + q + rule[os].suffix };
}

module.exports = { build, RULES };

if (require.main === module) (async () => {
  const argv = process.argv.slice(2);
  const opts = { file: null, start: 2, from: 'G', to: 'H', overwrite: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') opts.start = +argv[++i];
    else if (a === '--from') opts.from = argv[++i].toUpperCase();
    else if (a === '--to') opts.to = argv[++i].toUpperCase();
    else if (a === '--overwrite') opts.overwrite = true;
    else opts.file = a;
  }
  if (!opts.file) {
    console.error('用法: node make-links.js links_new_结果.xlsx [--start 2] [--overwrite]');
    process.exit(1);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(opts.file);
  const ws = wb.worksheets[0];
  let ok = 0, skip = 0;
  for (let r = opts.start; r <= ws.rowCount; r++) {
    const theater = text(ws.getCell(`A${r}`).value);
    const product = Object.keys(RULES).find((p) => RULES[p].match.test(theater));
    if (!product) continue;
    const captured = text(ws.getCell(`${opts.from}${r}`).value).trim();
    if (!/^\w+:\/\//.test(captured)) continue;
    if (!opts.overwrite && text(ws.getCell(`${opts.to}${r}`).value).trim()) { skip++; continue; }
    const res = build(product, text(ws.getCell(`C${r}`).value), captured);
    if (res.error) { console.log(`第 ${r} 行  ! ${res.error}`); continue; }
    ws.getCell(`${opts.to}${r}`).value = res.url;
    ok++;
    console.log(`第 ${r} 行  ${product} ${res.os}`);
  }
  const ext = path.extname(opts.file);
  const out = opts.file.slice(0, -ext.length) + '_投放.xlsx';
  await wb.xlsx.writeFile(out);
  console.log(`\n完成: 生成 ${ok} 条, H 列已有内容跳过 ${skip} 条。已保存到 ${out}`);
})();
