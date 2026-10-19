// 按固定规则，把 G 列抓到的链接转换成投放链接，写入 H 列（H 列已有内容的行不动）
//
// 用法:
//   node make-links.js links_new_结果.xlsx [--start 2] [--from G] [--to H] [--overwrite] [--default-os IOS]
//
// 目前支持（按推广任务名称里的 IOS / AOS 区分；名称里看不出时用 --default-os IOS 指定）：
//   GoodShort IOS/AOS：平台前缀 + 抓到链接的全部参数（原样）+ 固定后缀
//   DramaBox  IOS    ：固定模板，只从抓到链接里取 chid / af_c_id / af_dp / campaign / deep_link_value / onelink_id / shortlink
//   DramaBox  AOS    ：同 IOS 模板结构，换成安卓包名，bid 取抓到链接里的值，设备参数换成 GAID
//   FlickReels IOS/AOS：平台前缀 + 抓到链接的参数（pid 换成 {dynamicpid}）+ 固定后缀

const path = require('path');
const ExcelJS = require('exceljs');

const DB_IOS =
  'https://app.appsflyer.com/id6445905219?bid=41000115299&cid=0&chid={{chid}}&media=op&af_c_id={{af_c_id}}' +
  '&af_click_lookback=30d&af_deeplink=true&af_dp={{af_dp}}&campaign={{campaign}}&deep_link_value={{deep_link_value}}' +
  '&is_retargeting=true&media_source=other&onelink_id={{onelink_id}}&shortlink={{shortlink}}&source_caller=api_v2' +
  '&af_reengagement_window=lifetime&redirect=false&pid={randompid}&af_ip={ip}&af_sub1={sendInfo}&af_sub3={deviceInfo}' +
  '&af_ua={ua}&af_model=iPhone&af_os_version=26.5.2&idfa={idfa}&idfv={idfv}';

const DB_AOS =
  'https://app.appsflyer.com/com.storymatrix.drama?bid={{bid}}&cid=0&chid={{chid}}&media=op&af_c_id={{af_c_id}}' +
  '&af_click_lookback=30d&af_deeplink=true&af_dp={{af_dp}}&campaign={{campaign}}&deep_link_value={{deep_link_value}}' +
  '&is_retargeting=true&media_source=other&onelink_id={{onelink_id}}&shortlink={{shortlink}}&source_caller=api_v2' +
  '&af_reengagement_window=lifetime&redirect=false&pid={randompid}&af_ip={ip}&af_sub1={sendInfo}&af_sub3={deviceInfo}' +
  '&af_ua={ua}&af_model={device_model}&af_os_version={osv}&advertising_id={gaid}&md5_advertising_id={md5_gaid}';

const RULES = {
  DramaBox: {
    match: /dramabox/i,
    IOS: { template: DB_IOS },
    AOS: { template: DB_AOS },
  },
  FlickReels: {
    match: /flickreels/i,
    IOS: {
      prefix: 'https://app.appsflyer.com/id6514312894?',
      suffix: '&af_sub1={sendInfo}&af_sub3={deviceInfo}&af_ua={ua}&af_ip={ip}&af_model=iPhone&af_os_version=26.5.2&idfa={idfa}&idfv={idfv}',
      pid: '{dynamicpid}',
    },
    AOS: {
      prefix: 'https://app.appsflyer.com/com.zyhwplatform.shortplay?',
      suffix: '&af_sub1={sendInfo}&af_sub3={deviceInfo}&af_ua={ua}&af_ip={ip}&af_model={device_model}&af_os_version={osv}&advertising_id={gaid}&md5_advertising_id={md5_gaid}',
      pid: '{dynamicpid}',
    },
  },
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

// 不解码，按原样取参数值
function params(url) {
  const out = {};
  for (const part of query(url).split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && !(part.slice(0, i) in out)) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function osOf(taskName) {
  const m = taskName.match(/(?:^|[-_{\s])(IOS|AOS)(?=[-_{}\s]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

function build(product, taskName, captured, defaultOs) {
  const rule = RULES[product];
  const os = osOf(taskName) || defaultOs;
  if (!os) return { error: '推广任务名称里看不出 IOS / AOS（可加 --default-os IOS）' };
  if (!rule[os]) return { error: `${product} 还没有 ${os} 的规则` };
  const q = query(captured);
  if (!q) return { error: 'G 列链接没有参数' };
  if (rule[os].template) {
    const p = params(captured);
    const missing = [];
    const url = rule[os].template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in p ? p[k] : (missing.push(k), '')));
    if (missing.length) return { error: `抓到的链接里缺少 ${missing.join(', ')}` };
    return { os, url };
  }
  const qq = rule[os].pid ? q.replace(/(^|&)pid=[^&]*/, `$1pid=${rule[os].pid}`) : q;
  return { os, url: rule[os].prefix + qq + rule[os].suffix };
}

module.exports = { build, RULES };

if (require.main === module) (async () => {
  const argv = process.argv.slice(2);
  const opts = { file: null, start: 2, from: 'G', to: 'H', overwrite: false, defaultOs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') opts.start = +argv[++i];
    else if (a === '--from') opts.from = argv[++i].toUpperCase();
    else if (a === '--to') opts.to = argv[++i].toUpperCase();
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--default-os') opts.defaultOs = argv[++i].toUpperCase();
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
    const res = build(product, text(ws.getCell(`C${r}`).value), captured, opts.defaultOs);
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
