#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKSPACE = path.resolve(process.env.ETF_WORKSPACE || path.join(__dirname, "workspace"));
const SHARES_OUT = path.join(WORKSPACE, "etf_shares_history.json");

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

function fmt(n, digits = 1, sign = false) {
  if (n == null || Number.isNaN(Number(n))) return "-";
  const x = Number(n).toFixed(digits);
  return sign && Number(n) > 0 ? `+${x}` : x;
}

function getStats() {
  const shares = loadJson(SHARES_OUT, {});
  console.log("ETF JS runner status");
  console.log(`workspace: ${WORKSPACE}`);
  console.log(`shares history days: ${Object.keys(shares).length}`);
}

function signalLevel(cp) {
  if (cp >= 70) return "高确信";
  if (cp >= 50) return "中等关注";
  return null;
}

function formatSignalLine(code, item) {
  const info = ETFS[code];
  const share = item.delta_yi == null ? "" : ` 份额${fmt(item.delta_yi, 2, true)}亿/${fmt(item.delta_pct, 2, true)}%`;
  return `${code} ${info.n} CP=${fmt(item.cp, 1)}% 涨跌${fmt(item.chg, 2, true)}% 倍量${fmt(item.vr, 2)}x${share}`;
}

function buildBarkMessage(actualDate, latest) {
  const entries = Object.entries(latest)
    .filter(([, x]) => signalLevel(x.cp))
    .sort(([, a], [, b]) => b.cp - a.cp);
  if (!entries.length) return `ETF三因子 ${actualDate}\n今日无高确信或中等关注信号`;

  const high = entries.filter(([, x]) => x.cp >= 70);
  const mid = entries.filter(([, x]) => x.cp >= 50 && x.cp < 70);
  const lines = [`ETF三因子 ${actualDate}`];
  if (high.length) {
    lines.push("高确信:");
    for (const [code, item] of high) lines.push(formatSignalLine(code, item));
  }
  if (mid.length) {
    lines.push("中等关注:");
    for (const [code, item] of mid) lines.push(formatSignalLine(code, item));
  }
  return lines.join("\n");
}

function barkEndpoint() {
  const value = process.env.BARK;
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value.replace(/\/$/, "");
  return `https://api.day.app/${encodeURIComponent(value)}`;
}

async function maybeSendBark(actualDate, latest) {
  const endpoint = barkEndpoint();
  if (!endpoint) {
    console.log("未设置 BARK 环境变量，跳过 Bark 推送");
    return;
  }
  const body = buildBarkMessage(actualDate, latest);
  const res = await fetch(`${endpoint}/${encodeURIComponent(`ETF三因子 ${actualDate}`)}/${encodeURIComponent(body)}`);
  if (!res.ok) throw new Error(`Bark push failed: ${res.status} ${res.statusText}`);
  console.log("Bark 文本结果已发送");
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
    console.log(`${code} ${info.n}: ${target.chg >= 0 ? "+" : ""}${target.chg}% CP=${target.cp}%`);
  }

  await maybeSendBark(actualTarget, latest);
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
