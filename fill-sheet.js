// 读取 Excel 表格，从指定行开始逐行抓取 onelink 短链对应的 intent:// 链接，写入指定列。
//
// 用法:
//   node fill-sheet.js 表格.xlsx                 (默认从第 143 行开始，写入 G 列)
//   node fill-sheet.js 表格.xlsx --start 143 --col G --sheet 工作表名 --to H
//
// 抓到后在工具页面生成 CTA 投放链接，写入 H 列 (AOS、IOS 两行)；加 --no-gen 只抓不生成
//
// 每一行会自动找含有链接 (onelink 短链或落地页，如 flickreels.net) 的单元格；结果另存为 “原文件名_结果.xlsx”，原文件不改动。

const path = require('path');
const ExcelJS = require('exceljs');
const { launch, capture } = require('./scrape');
const { openTool, generateOnTool } = require('./gen-tool');

// 优先认 onelink 短链和已知落地页，找不到再取单元格里第一个 http 链接
const KNOWN = /(https?:\/\/)?[\w.-]*(onelink\.me|flickreels\.net)\/[^\s"'<>]+/i;
const ANY = /https?:\/\/[^\s"'<>]+/i;

function parseArgs(argv) {
  const opts = { file: null, start: 2, col: 'G', sheet: null, to: 'H', gen: true, redo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') opts.start = parseInt(argv[++i], 10);
    else if (a === '--col') opts.col = argv[++i].toUpperCase();
    else if (a === '--sheet') opts.sheet = argv[++i];
    else if (a === '--to') opts.to = argv[++i].toUpperCase();
    else if (a === '--no-gen') opts.gen = false;
    else if (a === '--redo') opts.redo = true;
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
  let outFile = opts.file.slice(0, -ext.length) + '_结果.xlsx';
  // 结果文件被 Excel/WPS 打开时会被锁住，改存成带时间的新文件名，不中途崩溃
  const save = async () => {
    try {
      await wb.xlsx.writeFile(outFile);
    } catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      const alt = opts.file.slice(0, -ext.length) + `_结果_${Date.now()}.xlsx`;
      console.error(`  ! ${outFile} 被占用（可能在 Excel 里打开着），改存为 ${alt}`);
      outFile = alt;
      await wb.xlsx.writeFile(outFile);
    }
  };
  const { browser, context } = await launch();
  let tool = null;
  if (opts.gen) {
    tool = await openTool(browser).catch((e) => {
      console.error(`! 打不开生成工具 (${e.message.split('\n')[0]})，本次只抓链接不生成`);
      return null;
    });
  }

  let ok = 0, fail = 0, skipped = 0;
  try {
    for (let r = opts.start; r <= ws.rowCount; r++) {
      const link = findLink(ws.getRow(r), opts.col);
      if (!link) continue;
      // G 列已经抓到过的行跳过（“未抓到”的会重试）
      const done = cellText(ws.getCell(`${opts.col}${r}`));
      if (!opts.redo && /^(intent|dramabox|https?):\/\//i.test(done.trim())) { skipped++; continue; }
      const url = await capture(context, link);
      ws.getCell(`${opts.col}${r}`).value = url || '未抓到';
      url ? ok++ : fail++;
      console.log(`第 ${r} 行  ${link}\n  -> ${url || '未抓到 (超时)'}`);
      if (url && tool) {
        const g = await generateOnTool(tool, url, link).catch((e) => ({ error: e.message.split('\n')[0] }));
        if (g.error) console.log(`  ! 生成投放链接失败: ${g.error}`);
        else {
          const cell = ws.getCell(`${opts.to}${r}`);
          cell.value = g.text;
          cell.alignment = { ...cell.alignment, wrapText: true };
          console.log(`  投放链接已生成 (${g.product} AOS/IOS)`);
        }
      }
      // 每 10 行保存一次，中途断掉也不会全丢
      if ((ok + fail) % 10 === 0) await save();
    }
  } finally {
    await browser.close();
    await save();
  }
  console.log(`\n完成: 成功 ${ok} 条, 失败 ${fail} 条, 已有链接跳过 ${skipped} 条。已保存到 ${outFile}`);
})();
