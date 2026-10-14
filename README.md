# onelink → intent:// 自动抓取

自动完成在 Chrome 开发者工具里手动做的那几步，支持两种链接，脚本按链接自动判断：

- **onelink 短链**（如 DramaBox `dramabox.onelink.me/dqUm/xxx`）：手机模式打开 → 抓 `intent://open?...` 请求
- **落地页**（如 FlickReels `flickreels.net/landing_page/xxx`）：手机模式打开 → 点击 “Continue Watching” → 抓 `xxx.onelink.me/...?af_js_web=true...` 请求

## 使用

```bash
npm install
# 把短链写进 links.txt，每行一个
npm run scrape
# 或者直接传参
node scrape.js dramabox.onelink.me/dqUm/193078ko
```

结果打印在终端，同时保存到 `results.csv`（可以直接用 Excel 打开）。

- 默认使用本机安装的 Google Chrome；如果路径不同，设置 `CHROME_PATH=/path/to/chrome`
- 想看浏览器界面，设置 `HEADFUL=1`
- 默认输出和 DevTools 里的 Request URL 一致（到 `source_caller=api_v2` 为止）；如需保留 `#Intent;...;end` 部分，设置 `KEEP_FRAGMENT=1`

## 批量填表（Excel）

```bash
node fill-sheet.js 表格.xlsx                        # 默认从第 143 行开始，结果写入 G 列
node fill-sheet.js 表格.xlsx --start 143 --col G --sheet 工作表名
```

每行自动找含链接（onelink 短链或 flickreels.net 落地页）的单元格，抓到的链接写进 G 列，结果另存为 `表格_结果.xlsx`，原文件不改动。
- 落地页按钮支持多语言（英/西/葡/印尼/泰/越/法/德/日/韩/中等），都匹配不上时自动点底部的大按钮；也可用 `CLICK_TEXT=文字1|文字2` 指定
- 抓不到时加 `DEBUG=1` 运行，会显示点击情况和请求列表，并保存当前页面截图 `debug-*.png`

## 生成 CTA 投放链接（通过工具页面）

`fill-sheet.js` 抓到链接后，会自动打开工具 http://43.166.243.38:9090/ ：A 填该剧场的 CTA 模板（`templates.json`），B 填抓到的链接，点“生成链接”，读取“生成结果”作为 IOS 链接，再把 appid 换成包名得到 AOS 链接，两条一起写进 H 列。

```bash
node gen-tool.js "<抓到的链接>" DramaBox        # 测试一条
node gen-tool.js links_结果.xlsx                 # 给已抓完的表补生成（读 G 列，写 H 列）
node fill-sheet.js links.xlsx --no-gen           # 只抓不生成
```

模板或包名变了，改 `templates.json` 即可。
