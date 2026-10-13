// 读取 Excel 表格，从指定行开始逐行抓取 onelink 短链对应的 intent:// 链接，写入指定列。
//
// 用法:
//   node fill-sheet.js 表格.xlsx                 (默认从第 143 行开始，写入 G 列)
//   node fill-sheet.js 表格.xlsx --start 143 --col G --sheet 工作表名
//
// 每一行会自动找含有链接 (onelink 短链或落地页，如 flickreels.net) 的单元格；结果另存为 “原文件名_结果.xlsx”，原文件不改动。

const path = require('path');
const ExcelJS = require('exceljs');
const { launch, capture } = require('./scrape');

// 优先认 onelink 短链和已知落地页，找不到再取单元格里第一个 http 链接
const KNOWN = /(https?:\/\/)?[\w.-]*(onelink\.me|flickreels\.net)\/[^\s"'<>]+/i;
const ANY = /https?:\/\/[^\s"'<>]+/i;

function parseArgs(argv) {
  const opts = { file: null, start: 143, col: 'G', sheet: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') opts.start = parseInt(argv[++i], 10);
    else if (a === '--col') opts.col = argv[++i].toUpperCase();
    else if (a === '--sheet') opts.sheet = argv[++i];
    else opts.file = a;
  }
  return opts;
}

function cellText(cell) {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.hyperlink) return `${v.hyperlink} ${v.text || ''}`;
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text) return String(v.text);
    if (v.result) return String(v.result);
  }
  return String(v);
}

function findLink(row, outCol) {
  for (const re of [KNOWN, ANY]) {
    let found = null;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (found || cell.address.replace(/\d+/g, '') === outCol) return;
      const m = cellText(cell).match(re);
      if (m) found = /^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`;
    });
    if (found) return found;
  }
  return null;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) {
    console.error('用法: node fill-sheet.js 表格.xlsx [--start 143] [--col G] [--sheet 工作表名]');
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(opts.file);
  const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
  if (!ws) {
    console.error(`找不到工作表: ${opts.sheet}`);
    process.exit(1);
  }

  const ext = path.extname(opts.file);
  const outFile = opts.file.slice(0, -ext.length) + '_结果.xlsx';
  const { browser, context } = await launch();

  let ok = 0, fail = 0;
  try {
    for (let r = opts.start; r <= ws.rowCount; r++) {
      const link = findLink(ws.getRow(r), opts.col);
      if (!link) continue;
      const url = await capture(context, link);
      ws.getCell(`${opts.col}${r}`).value = url || '未抓到';
      url ? ok++ : fail++;
      console.log(`第 ${r} 行  ${link}\n  -> ${url || '未抓到 (超时)'}`);
      // 每 10 行保存一次，中途断掉也不会全丢
      if ((ok + fail) % 10 === 0) await wb.xlsx.writeFile(outFile);
    }
  } finally {
    await browser.close();
    await wb.xlsx.writeFile(outFile);
  }
  console.log(`\n完成: 成功 ${ok} 条, 失败 ${fail} 条。已保存到 ${outFile}`);
})();
