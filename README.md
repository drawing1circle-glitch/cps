# onelink → intent:// 自动抓取

自动完成在 Chrome 开发者工具里手动做的那几步：手机模式打开短链 → Network 里找到 `intent://open?...` 请求 → 复制 Request URL。

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

每行自动找含 `onelink.me` 的单元格，抓到的链接写进 G 列，结果另存为 `表格_结果.xlsx`，原文件不改动。
