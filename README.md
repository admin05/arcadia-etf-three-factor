# ETF Three-Factor Bark Runner

这是把 `etf-three-factor-v7` skill 改成的 Node.js/JavaScript 版本，适合放到 NAS 的 Arcadia 平台定时执行。

## 来源与致谢

本项目基于 [Jianguo99/etf-three-factor](https://github.com/Jianguo99/etf-three-factor) 的 skill 修改而来，在原有 ETF 三因子监测思路和实现基础上，增加了适配 Arcadia/NAS 定时运行的 JavaScript 版本和 Bark 文本推送能力。

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

脚本不生成 HTML、PDF、JSON 或其他报告文件。默认只在当前目录的 `workspace/` 保留计算份额变化所需的历史缓存：

- `etf_shares_history.json`

可用环境变量改变输出目录：

```bash
export ETF_WORKSPACE="/volume1/arcadia/etf-workspace"
```

## Bark 推送

脚本只推送“高确信”和“中等关注”的文本结果；如果当天没有这两类信号，则不推送。

Arcadia 平台里配置 `BARK` 环境变量即可。可以填 Bark key，也可以填完整 Bark endpoint：

```bash
export BARK="your_bark_key"
# 或
export BARK="https://api.day.app/your_bark_key"
```

## 建议定时

建议工作日 20:00 或 20:30 运行。这个时间点上交所/深交所 ETF 份额数据通常更完整。
