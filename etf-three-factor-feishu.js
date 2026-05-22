#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKSPACE = path.resolve(process.env.ETF_WORKSPACE || path.join(__dirname, "workspace"));
const HTML_OUT = path.join(WORKSPACE, "ETF三因子分析-v7.html");
const PDF_OUT = path.join(WORKSPACE, "ETF三因子分析-v7.pdf");
const JSON_OUT = path.join(WORKSPACE, "ETF三因子分析-v7.json");
const SHARES_OUT = path.join(WORKSPACE, "etf_shares_history.json");
const HISTORY_OUT = path.join(WORKSPACE, "etf_history.jsonl");

const CJK_FONT_CANDIDATES = [
  process.env.ETF_CJK_FONT_FILE,
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/arphic/uming.ttc",
  "/usr/share/fonts/truetype/arphic/ukai.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/Library/Fonts/Arial Unicode.ttf",
].filter(Boolean);

const ETFS = {
  "510300": { n: "华泰柏瑞沪深300ETF", idx: "沪深300" },
  "510310": { n: "易方达沪深300ETF", idx: "沪深300" },
  "510330": { n: "华夏沪深300ETF", idx: "沪深300" },
  "159919": { n: "嘉实沪深300ETF", idx: "沪深300" },
  "510050": { n: "华夏上证50ETF", idx: "上证50" },
  "510500": { n: "华泰柏瑞中证500ETF", idx: "中证500" },
  "512100": { n: "南方中证1000ETF", idx: "中证1000" },
};

const SPECIAL = {
  "2026-04-30": "五一前",
  "2026-05-06": "五一后",
};

const sseCache = new Map();
const szseCache = new Map();

function ensureWorkspace() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function ymd8(d) {
  return d.replaceAll("-", "");
}

function ymd10(d8) {
  return `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
}

function addDays(date10, offset) {
  const d = new Date(`${date10}T00:00:00+08:00`);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function marketPrefix(code) {
  if (code.startsWith("sh") || code.startsWith("sz")) return { pfx: code.slice(0, 2), num: code.slice(2) };
  return { pfx: code.startsWith("51") || code.startsWith("56") || code.startsWith("58") || code.startsWith("0") ? "sh" : "sz", num: code };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBuffer(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchKline(code, limit = 60) {
  const { pfx, num } = marketPrefix(code);
  const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${pfx}${num},day,,,${limit},qfq`;
  try {
    const data = await fetchJson(url, { timeoutMs: 15000 });
    const item = data?.data?.[`${pfx}${num}`] || {};
    const rows = item.day || item.qfqday || [];
    return rows
      .filter((r) => r.length >= 6 && r[0])
      .map((r) => ({
        date: r[0],
        o: Number(r[1]),
        c: Number(r[2]),
        h: Number(r[3]),
        l: Number(r[4]),
        v: Number(r[5]),
      }));
  } catch {
    return [];
  }
}

async function fetchSseShares(date10) {
  if (sseCache.has(date10)) return sseCache.get(date10);
  const statDate = date10;
  const params = new URLSearchParams({
    isPagination: "true",
    "pageHelp.pageSize": "10000",
    "pageHelp.pageNo": "1",
    "pageHelp.beginPage": "1",
    "pageHelp.cacheSize": "1",
    "pageHelp.endPage": "1",
    sqlId: "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",
    STAT_DATE: statDate,
  });
  const url = `https://query.sse.com.cn/commonQuery.do?${params}`;
  try {
    const json = await fetchJson(url, {
      timeoutMs: 15000,
      headers: { Referer: "https://www.sse.com.cn/" },
    });
    const map = {};
    for (const row of json.result || []) {
      const code = String(row.SEC_CODE || "").padStart(6, "0");
      const totVol = Number(row.TOT_VOL);
      if (code && Number.isFinite(totVol)) map[code] = Math.round((totVol / 10000) * 10000) / 10000;
    }
    sseCache.set(date10, map);
    return map;
  } catch {
    sseCache.set(date10, {});
    return {};
  }
}

async function fetchSzseSharesRange(start10, end10) {
  const key = `${start10}_${end10}`;
  if (szseCache.has(key)) return szseCache.get(key);
  const params = new URLSearchParams({
    SHOWTYPE: "xlsx",
    CATALOGID: "scsj_fund_jjgm",
    TABKEY: "tab1",
    txtStart: start10,
    txtEnd: end10,
    jjlb: "ETF",
    random: String(Math.random()),
  });
  const url = `https://www.szse.cn/api/report/ShowReport?${params}`;
  try {
    const XLSX = await import("xlsx");
    const buf = await fetchBuffer(url, {
      timeoutMs: 20000,
      headers: { Referer: "https://www.szse.cn/market/fund/volume/etf/index.html" },
    });
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    const result = {};
    for (const row of rows) {
      const rawCode = row["基金代码"];
      const rawDate = row["日期"];
      const rawShares = row["基金规模(份)"] ?? row["基金份额"];
      if (rawCode == null || rawDate == null || rawShares == null) continue;
      const code = String(Number(rawCode)).padStart(6, "0");
      const date10 = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : String(rawDate).slice(0, 10).replaceAll("/", "-");
      const shares = Number(String(rawShares).replaceAll(",", ""));
      if (!Number.isFinite(shares)) continue;
      result[date10] ||= {};
      result[date10][code] = Math.round((shares / 1e8) * 10000) / 10000;
    }
    szseCache.set(key, result);
    return result;
  } catch {
    szseCache.set(key, {});
    return {};
  }
}

async function fetchFundShares(code, targetDate = todayIso()) {
  if (code.startsWith("159") || code.startsWith("16")) {
    const start = addDays(targetDate, -7);
    const map = await fetchSzseSharesRange(start, targetDate);
    for (let i = 0; i >= -6; i--) {
      const d = addDays(targetDate, i);
      if (map[d]?.[code] != null) return { shares_yi: map[d][code], data_date: d };
    }
    return null;
  }
  for (let i = 0; i >= -2; i--) {
    const d = addDays(targetDate, i);
    const map = await fetchSseShares(d);
    if (map[code] != null) return { shares_yi: map[code], data_date: d };
  }
  return null;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function saveSharesHistory(history) {
  const dates = Object.keys(history).sort();
  for (const old of dates.slice(0, Math.max(0, dates.length - 60))) delete history[old];
  saveJson(SHARES_OUT, history);
}

function getHistoricalShare(code, targetDate, history) {
  const target = history[targetDate]?.[code]?.shares_yi;
  if (target == null) return {};
  const dates = Object.keys(history).sort();
  const idx = dates.indexOf(targetDate);
  let prev = null;
  for (let i = idx - 1; i >= 0; i--) {
    const p = history[dates[i]]?.[code]?.shares_yi;
    if (p != null) {
      prev = p;
      break;
    }
  }
  if (prev == null) return { shares_yi: target, delta_yi: null, delta_pct: null };
  const delta = Math.round((target - prev) * 100) / 100;
  return { shares_yi: target, delta_yi: delta, delta_pct: Math.round((delta / prev) * 10000) / 100 };
}

async function backfillSharesHistory(history, dates) {
  const toFetch = dates.filter((d) => !history[d]).slice(-20);
  if (!toFetch.length) return 0;
  let count = 0;
  console.log(`  回补最近 ${toFetch.length} 个交易日份额...`);
  for (const d of toFetch) {
    const sse = await fetchSseShares(d);
    for (const code of Object.keys(ETFS)) {
      if (code.startsWith("159")) continue;
      if (sse[code] != null) {
        history[d] ||= {};
        history[d][code] = { shares_yi: sse[code], ts: `${d}T19:00:00` };
      }
    }
    if (history[d]) count += 1;
  }
  const min = toFetch[0];
  const max = toFetch[toFetch.length - 1];
  const szse = await fetchSzseSharesRange(min, max);
  for (const [d, codes] of Object.entries(szse)) {
    for (const [code, shares] of Object.entries(codes)) {
      if (ETFS[code]) {
        history[d] ||= {};
        history[d][code] = { shares_yi: shares, ts: `${d}T19:00:00` };
      }
    }
  }
  saveSharesHistory(history);
  return count;
}

function vprob(r) {
  if (r < 0.5) return Math.max(0, (r / 0.5) * 5);
  if (r < 1.0) return 5 + ((r - 0.5) / 0.5) * 12;
  if (r < 1.3) return 17 + ((r - 1) / 0.3) * 18;
  if (r < 1.5) return 35 + ((r - 1.3) / 0.2) * 20;
  if (r < 2.0) return 55 + ((r - 1.5) / 0.5) * 25;
  if (r < 3.0) return 80 + (r - 2) * 15;
  if (r < 5.0) return 95 + ((r - 3) / 2) * 3;
  return Math.min(100, 98 + ((r - 5) / 5) * 2);
}

function dprob(chg, t5Etf, t5Idx, vr, idxChg) {
  let rallyDiscount = 1.0;
  if (idxChg > 2.0) rallyDiscount = 0.6;
  else if (idxChg > 1.5) rallyDiscount = 0.7;
  else if (idxChg > 1.0) rallyDiscount = 0.8;
  else if (idxChg > 0.5) rallyDiscount = 0.9;

  let f1;
  if (chg > 0.3 && t5Idx < -1) f1 = 95;
  else if (chg > 0 && t5Idx < -0.5) f1 = 85;
  else if (chg > 0 && t5Idx < 0) f1 = 70;
  else if (Math.abs(chg) < 0.15 && t5Idx < -1) f1 = 80;
  else if (Math.abs(chg) < 0.3 && t5Idx < -0.5) f1 = 65;
  else if (chg > 1 && vr > 1.5 && idxChg > 1) f1 = 25;
  else if (chg > 1 && vr > 1.5) f1 = 45;
  else if (chg > 0.5 && vr > 1.3 && idxChg > 1) f1 = 35;
  else if (chg > 0.5 && vr > 1.3) f1 = 50;
  else if (chg > 0) f1 = 40;
  else if (chg < -1.5 && vr > 2) f1 = 8;
  else if (chg < -0.5 && vr > 1.5) f1 = 15;
  else f1 = 25;

  const gap = t5Etf - t5Idx;
  let f2;
  if (gap > 3) f2 = 95;
  else if (gap > 2) f2 = 85;
  else if (gap > 1.2) f2 = 75;
  else if (gap > 0.6) f2 = 60;
  else if (gap > 0.2) f2 = 50;
  else if (gap > -0.2) f2 = 40;
  else if (gap > -0.6) f2 = 30;
  else f2 = 15;

  let f3;
  if (t5Idx < -4) f3 = 95;
  else if (t5Idx < -3) f3 = 90;
  else if (t5Idx < -2) f3 = 80;
  else if (t5Idx < -1) f3 = 70;
  else if (t5Idx < -0.5) f3 = 55;
  else if (t5Idx < 0) f3 = 45;
  else if (t5Idx < 1) f3 = 35;
  else if (t5Idx < 3) f3 = 20;
  else f3 = 10;

  return Math.round((f1 * 0.4 + f2 * 0.3 + f3 * 0.2 + 35 * 0.1) * rallyDiscount * 10) / 10;
}

function sprob(deltaPct) {
  if (deltaPct == null) return null;
  if (deltaPct > 10) return 95;
  if (deltaPct > 5) return 80 + ((deltaPct - 5) / 5) * 15;
  if (deltaPct > 3) return 65 + ((deltaPct - 3) / 2) * 15;
  if (deltaPct > 1) return 45 + ((deltaPct - 1) / 2) * 20;
  if (deltaPct > 0) return 30 + deltaPct * 15;
  if (deltaPct > -1) return 15 + (deltaPct + 1) * 15;
  if (deltaPct > -5) return 5 + ((deltaPct + 5) / 4) * 10;
  return Math.max(0, 5 + ((deltaPct + 5) / 5) * 5);
}

function alignIdx(data, idxData) {
  const map = new Map(idxData.map((d, i) => [d.date, i]));
  return data.map((d) => map.get(d.date));
}

function analyzeAll(data, idxData, sharesByDate, days = 35) {
  if (data.length < 22) return [];
  const aligned = alignIdx(data, idxData);
  const res = [];
  for (let i = Math.max(21, data.length - days); i < data.length; i++) {
    const d = data[i];
    const v = d.v / 10000;
    const prior = data.slice(i - 20, i).map((x) => x.v / 10000);
    const ma = prior.reduce((a, b) => a + b, 0) / 20;
    if (!ma) continue;
    const vr = v / ma;
    const pc = data[i - 1].c;
    const chg = pc > 0 ? ((d.c - pc) / pc) * 100 : 0;
    const t5 = i >= 6 && data[i - 5].c > 0 ? ((d.c - data[i - 5].c) / data[i - 5].c) * 100 : 0;
    let t5i = t5;
    let idxChg = 0;
    const ii = aligned[i];
    if (ii != null) {
      idxChg = ii > 0 && idxData[ii - 1].c > 0 ? Math.round(((idxData[ii].c - idxData[ii - 1].c) / idxData[ii - 1].c) * 1000) / 10 : 0;
      if (i >= 6 && aligned[i - 5] != null) {
        const j5 = aligned[i - 5];
        t5i = idxData[j5].c > 0 ? ((idxData[ii].c - idxData[j5].c) / idxData[j5].c) * 100 : 0;
      }
    }
    const share = sharesByDate[d.date] || {};
    const vp = vprob(vr);
    const dp = dprob(chg, t5, Math.round(t5i * 100) / 100, vr, idxChg);
    const sp = sprob(share.delta_pct);
    const cp = sp == null ? Math.round((vp * 0.7 + dp * 0.3) * 10) / 10 : Math.round((vp * 0.5 + dp * 0.2 + sp * 0.3) * 10) / 10;
    res.push({
      d: d.date,
      c: d.c,
      chg: Math.round(chg * 100) / 100,
      v: Math.round(v * 100) / 100,
      vma: Math.round(ma * 100) / 100,
      vr: Math.round(vr * 100) / 100,
      vp: Math.round(vp * 10) / 10,
      dp,
      sp,
      cp,
      share_delta_yi: share.delta_yi ?? null,
      share_delta_pct: share.delta_pct ?? null,
      has_shares: sp != null,
      tag: SPECIAL[d.date] || "",
    });
  }
  return res;
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function findCjkFont() {
  for (const file of CJK_FONT_CANDIDATES) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

function fontMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".otf") return "font/otf";
  if (ext === ".ttf") return "font/ttf";
  if (ext === ".ttc") return "font/collection";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".woff") return "font/woff";
  return "application/octet-stream";
}

function cjkFontFaceCss() {
  const fontFile = findCjkFont();
  if (!fontFile) return "";
  console.log(`CJK font: ${fontFile}`);
  const ext = path.extname(fontFile).toLowerCase();

  // Chromium/PDF 对 TTC 字体的 data: URL 支持不稳定，容易生成空白 PDF。
  // TTC 交给系统 fontconfig 通过字体族名加载；TTF/OTF/WOFF 才显式引用文件。
  if (ext === ".ttc") {
    return `
@font-face{
  font-family:"EtfCjk";
  src:local("Noto Sans CJK SC"),local("Noto Sans CJK"),local("WenQuanYi Micro Hei"),local("PingFang SC");
  font-weight:400 900;
  font-style:normal;
  font-display:block;
}`;
  }

  const fileUrl = `file://${fontFile.replaceAll("\\", "/").replaceAll(" ", "%20")}`;
  return `
@font-face{
  font-family:"EtfCjk";
  src:url("${fileUrl}") format("${fontMime(fontFile).split("/").at(-1)}");
  font-weight:400 900;
  font-style:normal;
  font-display:block;
}`;
}

function genHtml({ actualDate, latest, signalDates, sharesData }) {
  const rows = Object.entries(ETFS).map(([code, info]) => {
    const p = latest[code] || {};
    const sh = sharesData[code] || {};
    const cp = p.cp ?? 0;
    const level = cp >= 70 ? "high" : cp >= 50 ? "mid" : "low";
    return `<tr class="${level}">
      <td><b>${htmlEscape(info.n)}</b><span>${code}</span></td>
      <td>${htmlEscape(info.idx)}</td>
      <td class="${p.chg > 0 ? "up" : p.chg < 0 ? "down" : ""}">${fmt(p.chg, 2, true)}%</td>
      <td>${fmt(p.v, 0)}万</td>
      <td>${fmt(p.vr, 2)}x</td>
      <td>${sh.shares_yi == null ? "-" : `${fmt(sh.shares_yi, 1)}亿`}</td>
      <td>${sh.delta_yi == null ? "-" : `${fmt(sh.delta_yi, 2, true)}亿 (${fmt(sh.delta_pct, 2, true)}%)`}</td>
      <td>${fmt(p.vp, 0)}%</td>
      <td>${fmt(p.dp, 0)}%</td>
      <td>${p.sp == null ? "-" : `${fmt(p.sp, 0)}%`}</td>
      <td><strong>${fmt(cp, 0)}%</strong></td>
    </tr>`;
  }).join("\n");

  const high = Object.values(latest).filter((x) => x.cp >= 70).length;
  const mid = Object.values(latest).filter((x) => x.cp >= 50 && x.cp < 70).length;
  const covered = Object.values(sharesData).filter((x) => x.shares_yi != null).length;
  const verdict = high > 0 ? `${high} 只高确信信号` : mid > 0 ? `${mid} 只中等关注信号` : "全市场正常，未见明显同步信号";
  const sigHtml = signalDates.length
    ? signalDates.map((s) => `<li>${s.date}: ${s.high} 高 + ${s.mid} 中 ${s.codes?.join(", ") || ""}</li>`).join("")
    : "<li>近 30 日无多 ETF 同步强信号</li>";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETF三因子分析 ${actualDate}</title>
<style>
${cjkFontFaceCss()}
@page{size:A4 landscape;margin:10mm}
body{margin:0;background:#f7f8fb;color:#1f2937;font:14px/1.5 "EtfCjk","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px}
.head{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:18px}
h1{font-size:26px;margin:0}.sub{color:#64748b}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px}.num{font-size:28px;font-weight:800}
.ok{color:#16a34a}.warn{color:#dc2626}.midc{color:#d97706}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:10px;border-bottom:1px solid #eef2f7;white-space:nowrap}th{font-size:12px;color:#64748b;background:#f8fafc}
td span{display:block;color:#94a3b8;font-size:12px}.high{background:#fff1f2}.mid{background:#fffbeb}.low{background:#fff}
.up{color:#dc2626}.down{color:#16a34a}strong{font-size:16px}.signals{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-top:16px}
</style>
</head>
<body><main class="wrap">
<section class="head"><div><h1>ETF三因子监测报告</h1><div class="sub">量能 50% + 方向 20% + 份额 30% · 分析日 ${actualDate}</div></div><div class="sub">生成时间 ${new Date().toLocaleString("zh-CN", { hour12: false })}</div></section>
<section class="cards">
<div class="card"><div class="num ${high ? "warn" : "ok"}">${high}</div><div>高确信</div></div>
<div class="card"><div class="num ${mid ? "midc" : "ok"}">${mid}</div><div>中等关注</div></div>
<div class="card"><div class="num">${covered}/7</div><div>份额覆盖</div></div>
<div class="card"><div class="num">${verdict}</div><div>综合判断</div></div>
</section>
<table><thead><tr><th>ETF</th><th>指数</th><th>涨跌</th><th>成交量</th><th>倍量</th><th>份额</th><th>份额日变</th><th>量能P</th><th>方向P</th><th>份额P</th><th>综合</th></tr></thead><tbody>${rows}</tbody></table>
<section class="signals"><h2>30日同步信号</h2><ul>${sigHtml}</ul></section>
</main></body></html>`;
}

function fmt(n, digits = 1, sign = false) {
  if (n == null || Number.isNaN(Number(n))) return "-";
  const x = Number(n).toFixed(digits);
  return sign && Number(n) > 0 ? `+${x}` : x;
}

function writeHistoryLine(actualDate, latest, sharesData) {
  const line = JSON.stringify({ run_time: new Date().toISOString(), target_date: actualDate, latest, sharesData });
  fs.appendFileSync(HISTORY_OUT, `${line}\n`, "utf8");
}

function executableExists(bin) {
  if (!bin) return false;
  if (bin.includes("/") || bin.includes("\\")) return fs.existsSync(bin);
  const paths = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return paths.some((dir) => fs.existsSync(path.join(dir, bin)));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getChromeCandidates() {
  return unique([
    process.env.CHROME_BIN,
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);
}

async function renderPdfWithPlaywright(htmlPath, pdfPath, executablePath = null) {
  const { chromium } = await import("playwright");
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      landscape: true,
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
  } finally {
    await browser.close();
  }
}

function renderPdfWithChromeCli(htmlPath, pdfPath) {
  const errors = [];
  for (const bin of getChromeCandidates()) {
    if (!executableExists(bin)) {
      errors.push(`${bin}: 不存在或不在 PATH`);
      continue;
    }
    const result = spawnSync(bin, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ], { encoding: "utf8" });
    if (result.status === 0 && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0) return true;
    errors.push(`${bin}: ${result.error?.message || result.stderr?.trim() || `退出码 ${result.status}`}`);
  }
  if (errors.length) console.warn(`系统 Chrome PDF 生成失败：${errors.join("；")}`);
  return false;
}

function assertPdfLooksNonEmpty(pdfPath) {
  const stat = fs.statSync(pdfPath);
  if (stat.size < 5000) {
    throw new Error(`PDF 文件过小，可能为空白: ${pdfPath} (${stat.size} bytes)`);
  }
  const head = fs.readFileSync(pdfPath).subarray(0, 4).toString("utf8");
  if (head !== "%PDF") {
    throw new Error(`PDF 文件头异常: ${pdfPath}`);
  }
}

async function renderPdf(htmlPath, pdfPath) {
  const warnings = [];
  try {
    await renderPdfWithPlaywright(htmlPath, pdfPath);
    assertPdfLooksNonEmpty(pdfPath);
    return pdfPath;
  } catch (err) {
    warnings.push(`Playwright bundled Chromium: ${err.message}`);
  }

  for (const bin of getChromeCandidates()) {
    if (!executableExists(bin)) continue;
    try {
      await renderPdfWithPlaywright(htmlPath, pdfPath, bin);
      assertPdfLooksNonEmpty(pdfPath);
      return pdfPath;
    } catch (err) {
      warnings.push(`Playwright with ${bin}: ${err.message}`);
    }
  }

  console.warn(`Playwright PDF 生成失败，尝试系统 Chrome: ${warnings.join("；")}`);
  if (renderPdfWithChromeCli(htmlPath, pdfPath)) {
    assertPdfLooksNonEmpty(pdfPath);
    return pdfPath;
  }
  throw new Error([
    "PDF 生成失败：未找到可用的 Playwright Chromium 或系统 Chrome/Chromium。",
    "请在 NAS 上运行 `npm install && npx playwright install chromium`，",
    "或安装 chromium/chrome 后把 CHROME_BIN 设置为真实可执行文件路径。",
    "如果曾设置 CHROME_BIN=/usr/bin/chromium 但该文件不存在，请先取消或修正该环境变量。",
  ].join(""));
}

function getStats() {
  const shares = loadJson(SHARES_OUT, {});
  let lines = [];
  try {
    lines = fs.readFileSync(HISTORY_OUT, "utf8").trim().split("\n").filter(Boolean);
  } catch {}
  const last = lines.length ? JSON.parse(lines.at(-1)) : null;
  console.log("ETF JS runner status");
  console.log(`workspace: ${WORKSPACE}`);
  console.log(`shares history days: ${Object.keys(shares).length}`);
  console.log(`run records: ${lines.length}`);
  if (last) console.log(`last target date: ${last.target_date}`);
}

async function feishuTenantToken() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  const res = await fetchJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (res.code !== 0) throw new Error(`Feishu token failed: ${res.msg || res.code}`);
  return res.tenant_access_token;
}

async function sendFeishuFile(filePath, summary) {
  const receiveId = process.env.FEISHU_RECEIVE_ID;
  const receiveIdType = process.env.FEISHU_RECEIVE_ID_TYPE || "chat_id";
  const token = await feishuTenantToken();
  if (!token || !receiveId) return false;

  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file_type", "stream");
  form.append("file_name", path.basename(filePath));
  form.append("file", new Blob([bytes], { type: "application/pdf" }), path.basename(filePath));
  const uploadRes = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const upload = await uploadRes.json();
  if (upload.code !== 0) throw new Error(`Feishu upload failed: ${upload.msg || upload.code}`);

  await fetchJson(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text: summary }),
    }),
  });

  const msg = await fetchJson(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: "file",
      content: JSON.stringify({ file_key: upload.data.file_key }),
    }),
  });
  if (msg.code !== 0) throw new Error(`Feishu send file failed: ${msg.msg || msg.code}`);
  return true;
}

async function sendFeishuWebhook(summary) {
  const webhook = process.env.FEISHU_WEBHOOK;
  if (!webhook) return false;
  const body = {
    msg_type: "text",
    content: { text: `${summary}\n\nPDF 报告已生成：${PDF_OUT}` },
  };
  const res = await fetchJson(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.code && res.code !== 0) throw new Error(`Feishu webhook failed: ${res.msg || res.code}`);
  return true;
}

async function maybeSendFeishu(actualDate, latest, reportPath) {
  const high = Object.entries(latest).filter(([, x]) => x.cp >= 70).map(([c]) => c);
  const mid = Object.entries(latest).filter(([, x]) => x.cp >= 50 && x.cp < 70).map(([c]) => c);
  const summary = [
    `ETF三因子分析报告 ${actualDate}`,
    `高确信: ${high.length ? high.join(", ") : "无"}`,
    `中等关注: ${mid.length ? mid.join(", ") : "无"}`,
    `报告: ${path.basename(reportPath)}`,
  ].join("\n");

  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_RECEIVE_ID) {
    await sendFeishuFile(reportPath, summary);
    console.log("飞书 PDF 文件已发送");
    return;
  }
  if (process.env.FEISHU_WEBHOOK) {
    await sendFeishuWebhook(summary);
    console.log("飞书 webhook 摘要已发送");
  }
}

async function run(targetDate = null) {
  ensureWorkspace();
  console.log("ETF三因子 JS runner");
  console.log(`workspace: ${WORKSPACE}`);
  const idx300 = await fetchKline("sh000300", 60);
  if (!idx300.length) throw new Error("沪深300指数数据获取失败");
  const actualTarget = targetDate || idx300.at(-1).date || todayIso();

  const sharesHistory = loadJson(SHARES_OUT, {});
  const allDates = new Set(idx300.map((x) => x.date));
  for (const code of Object.keys(ETFS)) {
    const data = await fetchKline(code, 60);
    for (const d of data) allDates.add(d.date);
  }
  if (Object.keys(sharesHistory).length < 50) await backfillSharesHistory(sharesHistory, [...allDates].sort());

  console.log(`采集 ${actualTarget} 份额数据...`);
  for (const code of Object.keys(ETFS)) {
    const sh = await fetchFundShares(code, actualTarget);
    if (sh) {
      sharesHistory[sh.data_date] ||= {};
      sharesHistory[sh.data_date][code] = { shares_yi: sh.shares_yi, ts: new Date().toISOString() };
      console.log(`  ${code}: ${sh.shares_yi}亿份 (${sh.data_date})`);
    } else {
      console.log(`  ${code}: 份额暂不可用`);
    }
  }
  saveSharesHistory(sharesHistory);

  const latest = {};
  const sharesData = {};
  const dateSig = {};
  for (const [code, info] of Object.entries(ETFS)) {
    const data = await fetchKline(code, 60);
    const sharesByDate = {};
    for (const d of Object.keys(sharesHistory).sort()) sharesByDate[d] = getHistoricalShare(code, d, sharesHistory);
    const hist = analyzeAll(data, idx300, sharesByDate, 35);
    const target = hist.find((h) => h.d === actualTarget) || hist.at(-1);
    if (!target) continue;
    const sh = sharesByDate[target.d] || {};
    sharesData[code] = sh;
    latest[code] = {
      d: target.d,
      c: target.c,
      chg: target.chg,
      cp: target.cp,
      vr: target.vr,
      vp: target.vp,
      dp: target.dp,
      sp: target.sp,
      v: target.v,
      vma: target.vma,
      shares_yi: sh.shares_yi ?? null,
      delta_yi: sh.delta_yi ?? null,
      delta_pct: sh.delta_pct ?? null,
    };
    for (const h of hist) {
      dateSig[h.d] ||= { high: 0, mid: 0, codes: [] };
      if (h.cp >= 70) {
        dateSig[h.d].high += 1;
        dateSig[h.d].codes.push(`${code}(${Math.round(h.cp)}%)`);
      } else if (h.cp >= 50) {
        dateSig[h.d].mid += 1;
      }
    }
    console.log(`${code} ${info.n}: ${target.chg >= 0 ? "+" : ""}${target.chg}% CP=${target.cp}%`);
  }

  const signalDates = Object.entries(dateSig)
    .filter(([, v]) => v.high >= 2 || v.high + v.mid >= 4)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 10)
    .map(([date, v]) => ({ date, ...v }));

  const payload = {
    run_time: new Date().toISOString(),
    model: "三因子: 量能50%+方向20%+份额30%",
    target_date: actualTarget,
    signal_dates: signalDates,
    latest,
    shares_data: sharesData,
  };
  const html = genHtml({ actualDate: actualTarget, latest, signalDates, sharesData });
  fs.writeFileSync(HTML_OUT, html, "utf8");
  const pdfPath = await renderPdf(HTML_OUT, PDF_OUT);
  saveJson(JSON_OUT, payload);
  writeHistoryLine(actualTarget, latest, sharesData);
  console.log(`HTML: ${HTML_OUT}`);
  console.log(`PDF: ${pdfPath}`);
  console.log(`JSON: ${JSON_OUT}`);
  await maybeSendFeishu(actualTarget, latest, pdfPath);
}

const args = process.argv.slice(2);
if (args.includes("--stats")) {
  getStats();
} else {
  const dateArg = args.includes("--date") ? args[args.indexOf("--date") + 1] : null;
  run(dateArg).catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}
