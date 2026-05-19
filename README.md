# ETF Three-Factor Feishu Runner

这是把 `etf-three-factor-v7` skill 改成的 Node.js/JavaScript 版本，适合放到 NAS 的 Arcadia 平台定时执行。

## 来源与致谢

本项目基于 [Jianguo99/etf-three-factor](https://github.com/Jianguo99/etf-three-factor) 的 skill 修改而来，在原有 ETF 三因子监测思路和实现基础上，增加了适配 Arcadia/NAS 定时运行的 JavaScript 版本、PDF 报告生成和飞书发送能力。

感谢原作者 Jianguo99 对 ETF 三因子监测模型、数据源接入和报告生成流程的整理与分享。

## 安装

```bash
npm install
```

要求 Node.js 18+。

## 运行

```bash
node etf-three-factor-feishu.js
```

指定分析日期：

```bash
node etf-three-factor-feishu.js --date 2026-05-18
```

只查看本地状态：

```bash
node etf-three-factor-feishu.js --stats
```

## 输出

默认输出到当前目录的 `workspace/`：

- `ETF三因子分析-v7.html`
- `ETF三因子分析-v7.pdf`
- `ETF三因子分析-v7.json`
- `etf_shares_history.json`
- `etf_history.jsonl`

可用环境变量改变输出目录：

```bash
export ETF_WORKSPACE="/volume1/arcadia/etf-workspace"
```

## 飞书发送

### 方式一：发送 PDF 文件附件，推荐

需要飞书自建应用，并开通机器人/IM 权限。配置：

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export FEISHU_RECEIVE_ID="oc_xxx"
export FEISHU_RECEIVE_ID_TYPE="chat_id"
```

脚本会先把 HTML 报告渲染成 PDF，再上传 PDF 报告到飞书并发送文件消息。

PDF 生成需要可用的浏览器环境。推荐安装 Playwright：

```bash
npm install
npx playwright install chromium
```

如果 NAS 已经有 Chromium/Chrome，也可以指定：

```bash
export CHROME_BIN="/usr/bin/chromium"
```

如果 PDF 里的中文显示为空心方框，说明 NAS/容器缺少中文字体。安装一种 CJK 字体即可：

```bash
# Debian/Ubuntu
apt update
apt install -y fonts-noto-cjk

# Alpine
apk add font-noto-cjk
```

也可以手动指定字体文件：

```bash
export ETF_CJK_FONT_FILE="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
```

### 方式二：普通自定义机器人 webhook

```bash
export FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
```

普通 webhook 不能直接上传本地 HTML 附件，所以脚本会发送日报摘要和本地报告路径。
普通 webhook 不能直接上传本地 PDF 附件，所以脚本会发送日报摘要和本地报告路径。

## 建议定时

建议工作日 20:00 或 20:30 运行。这个时间点上交所/深交所 ETF 份额数据通常更完整。
