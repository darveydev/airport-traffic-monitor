#!/usr/bin/env node
/**
 * 聚合 data/devices/*.json → docs/data/aggregate.json + docs/assets/*.svg + README 数据区
 *
 * 去重规则（很关键，否则多设备会重复计数）：
 *   - source = "node" 的设备：数字是它自己实测的，按设备【相加】
 *   - source = "sub"  的设备：数字是同一个机场账号的累计值，多个观测者取【最大值】
 * 两者相加得到机场的真实用量。
 *
 * 用法：node scripts/aggregate.mjs [--check]
 *   --check  只检查数据、不写文件（CI 里做语法自检用）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GB = 1024 ** 3;
const CHECK_ONLY = process.argv.includes('--check');

/* ------------------------------------------------------------------ 工具 */

const pad2 = (n) => String(n).padStart(2, '0');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const cfg = readJson(path.join(ROOT, 'config', 'meter.json'), {});
const TZ = cfg.timezone || 'Asia/Shanghai';
const RESET_DAY = Math.min(Math.max(num(cfg.resetDay) || 1, 1), 28);

const PALETTE = ['#e5484d', '#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#0091ff', '#d6409f', '#f5d90a', '#12a594'];
const colorOf = (name, i) => {
  const found = (cfg.airports || []).find((a) => a.name === name);
  return (found && found.color) || PALETTE[i % PALETTE.length];
};

function localDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function localHour(d = new Date()) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d);
  return pad2(Number(h) % 24);
}
function localTimeString(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function fmtBytes(n) {
  n = num(n);
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`;
}

function cycleStartOf(today, resetDay) {
  const [y, m] = today.split('-').map(Number);
  const thisMonth = `${y}-${pad2(m)}-${pad2(resetDay)}`;
  if (today >= thisMonth) return thisMonth;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${pad2(pm)}-${pad2(resetDay)}`;
}

const addBucket = (dst, key, up, down) => {
  const cur = dst[key] || (dst[key] = { up: 0, down: 0 });
  cur.up += num(up);
  cur.down += num(down);
};

/* -------------------------------------------------------------- 读取设备 */

const devicesDir = path.join(ROOT, 'data', 'devices');
const deviceFiles = fs.existsSync(devicesDir)
  ? fs.readdirSync(devicesDir).filter((f) => f.endsWith('.json'))
  : [];

const devices = [];
const warnings = [];

for (const file of deviceFiles) {
  const doc = readJson(path.join(devicesDir, file), null);
  if (!doc || typeof doc !== 'object') { warnings.push(`${file}: 不是合法 JSON，已跳过`); continue; }
  const name = doc.device || file.replace(/\.json$/, '');
  devices.push({
    name,
    file,
    source: doc.source === 'node' ? 'node' : 'sub',
    updatedAt: num(doc.updatedAt),
    airports: doc.airports && typeof doc.airports === 'object' ? doc.airports : {},
    totals: doc.totals && typeof doc.totals === 'object' ? doc.totals : {},
    days: doc.days && typeof doc.days === 'object' ? doc.days : {},
    hours: doc.hours && typeof doc.hours === 'object' ? doc.hours : {},
  });
}

devices.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

/* ------------------------------------------------------------ 机场与周期 */

const today = localDate();
const nowHourKey = `${today}T${localHour()}`;
const cycleStart = cycleStartOf(today, RESET_DAY);

const airportNames = new Set();
for (const d of devices) {
  Object.keys(d.airports).forEach((n) => airportNames.add(n));
  Object.keys(d.totals).forEach((n) => airportNames.add(n));
  Object.values(d.days).forEach((bucket) => Object.keys(bucket).forEach((n) => airportNames.add(n)));
}

const cfgOrder = (cfg.airports || []).map((a) => a.name);
const orderedAirports = [...airportNames].sort((a, b) => {
  const ia = cfgOrder.indexOf(a);
  const ib = cfgOrder.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b, 'zh');
});

/** 每个机场：node 设备相加 + sub 设备取最大 */
function cycleBytesOf(name) {
  let up = 0, down = 0;
  for (const [date, bucket] of Object.entries(days)) {
    if (date < cycleStart) continue;
    const v = bucket[name];
    if (!v) continue;
    up += num(v.up);
    down += num(v.down);
  }
  return { up, down };
}

function airportTotals(name) {
  let nodeUp = 0, nodeDown = 0;
  let subUp = 0, subDown = 0;
  let total = 0, expire = 0;
  let lastAt = 0;
  let subObservers = 0;

  for (const d of devices) {
    if (d.source === 'node') {
      const t = d.totals[name];
      if (Array.isArray(t)) { nodeUp += num(t[0]); nodeDown += num(t[1]); }
    } else {
      const s = d.airports[name];
      if (s) {
        subObservers++;
        subUp = Math.max(subUp, num(s.up));
        subDown = Math.max(subDown, num(s.down));
        total = Math.max(total, num(s.total));
        expire = Math.max(expire, num(s.expire));
        lastAt = Math.max(lastAt, num(s.at));
      }
    }
  }

  const meta = (cfg.airports || []).find((a) => a.name === name) || {};
  if (!total && meta.quotaGB) total = num(meta.quotaGB) * GB;

  const used = nodeUp + nodeDown + subUp + subDown;
  // 订阅口径下 provider 的累计值就是本周期用量；纯节点口径只能用自己记的天数累加
  const cycle = subObservers ? { up: nodeUp + subUp, down: nodeDown + subDown } : cycleBytesOf(name);

  return {
    name,
    up: nodeUp + subUp,
    down: nodeDown + subDown,
    used,
    cycleUp: cycle.up,
    cycleDown: cycle.down,
    cycleBytes: cycle.up + cycle.down,
    total,
    expire,
    at: lastAt,
    color: colorOf(name, orderedAirports.indexOf(name)),
    shared: subObservers > 1,
  };
}

const airports = orderedAirports.map(airportTotals);

/* ------------------------------------------------------- 天 / 小时（去重） */

function mergeBuckets(pick) {
  const out = {};
  for (const d of devices) {
    const bucketMap = pick(d);
    for (const [key, bucket] of Object.entries(bucketMap || {})) {
      const slot = out[key] || (out[key] = {});
      for (const [airport, pair] of Object.entries(bucket)) {
        if (!Array.isArray(pair)) continue;
        const cur = slot[airport] || (slot[airport] = { up: 0, down: 0 });
        if (d.source === 'node') {
          cur.up += num(pair[0]);
          cur.down += num(pair[1]);
        } else {
          cur.up = Math.max(cur.up, num(pair[0]));
          cur.down = Math.max(cur.down, num(pair[1]));
        }
      }
    }
  }
  return out;
}

const days = mergeBuckets((d) => d.days);
const hours = mergeBuckets((d) => d.hours);

const sumBucket = (bucket, filterFn) => {
  let up = 0, down = 0;
  for (const [airport, v] of Object.entries(bucket || {})) {
    if (filterFn && !filterFn(airport)) continue;
    // 设备原始文件里是 [up, down] 数组，合并后的桶是 {up, down}
    if (Array.isArray(v)) { up += num(v[0]); down += num(v[1]); }
    else { up += num(v.up); down += num(v.down); }
  }
  return { up, down };
};

/* ---------------------------------------------------------------- 设备行 */

function pickDeviceBucket(d, date) {
  return (d.days && d.days[date]) || {};
}

const deviceRows = devices.map((d) => {
  const todaySum = sumBucket(pickDeviceBucket(d, today));
  const cycle = Object.entries(d.days || {})
    .filter(([date]) => date >= cycleStart)
    .reduce((acc, [, bucket]) => {
      const s = sumBucket(bucket);
      return { up: acc.up + s.up, down: acc.down + s.down };
    }, { up: 0, down: 0 });

  const own = new Set([
    ...Object.keys(d.airports),
    ...Object.keys(d.totals),
    ...Object.values(d.days || {}).flatMap((b) => Object.keys(b)),
  ]);

  // 只要有一个机场是「只有这台设备在观测」，设备级数字就是可信的
  const exclusive = d.source === 'node' ||
    Object.keys(d.airports).some(
      (a) => devices.filter((x) => x.source === 'sub' && x.airports[a]).length === 1
    );

  return {
    name: d.name,
    source: d.source,
    updatedAt: Math.round(d.updatedAt / 1000),
    todayBytes: todaySum.up + todaySum.down,
    cycleBytes: cycle.up + cycle.down,
    exclusive,
    airports: [...own],
  };
});

/* ------------------------------------------------------------ 矩阵 & 序列 */

const matrix = airports.map((a) => ({
  airport: a.name,
  used: a.used,
  cells: devices
    .filter((d) => d.source === 'node' ? d.totals[a.name] : d.airports[a.name])
    .map((d) => {
      const sharedCount = devices.filter((x) => x.source === 'sub' && x.airports[a.name]).length;
      let bytes = 0;
      if (d.source === 'node') {
        const t = d.totals[a.name] || [0, 0];
        bytes = num(t[0]) + num(t[1]);
      } else {
        const s = d.airports[a.name];
        bytes = num(s.up) + num(s.down);
      }
      return {
        device: d.name,
        source: d.source,
        bytes,
        shared: d.source === 'sub' && sharedCount > 1,
      };
    }),
}));

const dailySeries = Object.entries(days)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .slice(-14)
  .map(([date, bucket]) => {
    const byAirport = {};
    let total = 0;
    for (const [airport, v] of Object.entries(bucket)) {
      const b = num(v.up) + num(v.down);
      byAirport[airport] = b;
      total += b;
    }
    return { date, total, byAirport };
  });

const hourlySeries = Object.keys(hours)
  .sort()
  .slice(-24)
  .map((key) => {
    const bucket = hours[key];
    const byAirport = {};
    let total = 0;
    for (const [airport, v] of Object.entries(bucket)) {
      const b = num(v.up) + num(v.down);
      byAirport[airport] = b;
      total += b;
    }
    return { key, label: key.slice(11) + ':00', total, byAirport };
  });

const cycleTotals = airports.reduce(
  (acc, a) => ({ up: acc.up + a.cycleUp, down: acc.down + a.cycleDown }),
  { up: 0, down: 0 }
);

const aggregate = {
  generatedAt: new Date().toISOString(),
  generatedAtLocal: localTimeString(),
  timezone: TZ,
  today,
  cycleStart,
  resetDay: RESET_DAY,
  nowHourKey,
  staleMinutes: 60,
  totals: {
    up: cycleTotals.up,
    down: cycleTotals.down,
    cycle: cycleTotals.up + cycleTotals.down,
    today: dailySeries.find((d) => d.date === today)?.total || 0,
    last24h: hourlySeries.reduce((a, b) => a + b.total, 0),
  },
  airports,
  devices: deviceRows,
  matrix,
  daily: dailySeries,
  hourly: hourlySeries,
  warnings,
};

/* ------------------------------------------------------------------- SVG */

const SVG_STYLE = `<style>
text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif}
.bg{fill:#ffffff}.fg{fill:#1f2328}.muted{fill:#6e7781}.track{fill:#eaeef2}.grid{stroke:#eaeef2}
@media (prefers-color-scheme:dark){
.bg{fill:#0d1117}.fg{fill:#e6edf3}.muted{fill:#8b949e}.track{fill:#21262d}.grid{stroke:#21262d}}
</style>`;

function svgOpen(w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${SVG_STYLE}<rect class="bg" width="${w}" height="${h}"/>`;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderBars({ title, subtitle, rows, unit = fmtBytes }) {
  const W = 760;
  const rowH = 42;
  const top = 58;
  const H = top + rows.length * rowH + 14;
  const labelW = 132;
  const valueW = 132;
  const barX = labelW;
  const barW = W - labelW - valueW - 16;
  const max = Math.max(1, ...rows.map((r) => r.value));

  let out = svgOpen(W, H);
  out += `<text class="fg" x="16" y="28" font-size="15" font-weight="600">${esc(title)}</text>`;
  if (subtitle) out += `<text class="muted" x="16" y="45" font-size="11">${esc(subtitle)}</text>`;

  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const w = Math.max(2, Math.round((r.value / max) * barW));
    const pct = r.total ? Math.min(1, r.value / r.total) : null;
    out += `<text class="fg" x="16" y="${y + 15}" font-size="13">${esc(truncate(r.label, 12))}</text>`;
    out += `<rect class="track" x="${barX}" y="${y + 4}" width="${barW}" height="14" rx="4"/>`;
    out += `<rect x="${barX}" y="${y + 4}" width="${w}" height="14" rx="4" fill="${r.color}"/>`;
    if (pct !== null) {
      out += `<rect x="${barX}" y="${y + 20}" width="${barW}" height="3" rx="1.5" class="track"/>`;
      out += `<rect x="${barX}" y="${y + 20}" width="${Math.max(2, Math.round(pct * barW))}" height="3" rx="1.5" fill="${r.color}" opacity="0.55"/>`;
    }
    out += `<text class="fg" x="${W - 16}" y="${y + 16}" font-size="13" text-anchor="end">${esc(unit(r.value))}</text>`;
    if (r.note) {
      out += `<text class="muted" x="${barX}" y="${y + 35}" font-size="10.5">${esc(r.note)}</text>`;
    }
  });
  return out + '</svg>';
}

function renderStacked({ title, series, keys, colors, valueKey = 'total' }) {
  const W = 760;
  const H = 250;
  const padL = 16;
  const padR = 16;
  const top = 56;
  const bottom = 34;
  const plotW = W - padL - padR;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...series.map((s) => s[valueKey]));
  const slot = plotW / Math.max(1, series.length);
  const barW = Math.max(3, Math.min(28, slot * 0.66));

  let out = svgOpen(W, H);
  out += `<text class="fg" x="${padL}" y="26" font-size="15" font-weight="600">${esc(title)}</text>`;

  // 图例
  let lx = padL + 260;
  keys.forEach((k, i) => {
    out += `<circle cx="${lx}" cy="21" r="4" fill="${colors[k]}"/>`;
    out += `<text class="muted" x="${lx + 9}" y="25" font-size="11">${esc(truncate(k, 10))}</text>`;
    lx += 14 + Math.min(80, String(k).length * 12 + 14);
  });

  // 网格
  for (let g = 0; g <= 2; g++) {
    const y = top + (plotH * g) / 2;
    out += `<line class="grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
    out += `<text class="muted" x="${W - padR}" y="${y - 4}" font-size="10" text-anchor="end">${esc(fmtBytes((max * (2 - g)) / 2))}</text>`;
  }

  series.forEach((s, i) => {
    const cx = padL + slot * i + slot / 2;
    let y = top + plotH;
    keys.forEach((k) => {
      const v = num(s.byAirport?.[k]);
      if (!v) return;
      const h = (v / max) * plotH;
      y -= h;
      out += `<rect x="${cx - barW / 2}" y="${y.toFixed(1)}" width="${barW}" height="${Math.max(0.6, h).toFixed(1)}" fill="${colors[k]}" rx="1.5"/>`;
    });
    const showLabel = series.length <= 14 || i % 2 === 0;
    if (showLabel) {
      const label = s.date ? s.date.slice(5) : s.label;
      out += `<text class="muted" x="${cx}" y="${H - 12}" font-size="10" text-anchor="middle">${esc(label)}</text>`;
    }
  });
  return out + '</svg>';
}

const colors = {};
orderedAirports.forEach((n, i) => { colors[n] = colorOf(n, i); });

const svgAirports = renderBars({
  title: '各机场用量',
  rows: airports.map((a) => ({
    label: a.name,
    value: a.used,
    total: a.total,
    color: a.color,
    note: a.total ? `${Math.round((a.used / a.total) * 100)}% · 剩 ${fmtBytes(Math.max(0, a.total - a.used))}` : '',
  })),
});

const svgDevices = renderBars({
  title: '各设备用量（本周期）',
  subtitle: '共享同一机场账号的设备，只能看到账号总量，此处为其观测增量',
  rows: deviceRows.map((d, i) => ({
    label: d.name,
    value: d.cycleBytes,
    color: PALETTE[(i + 2) % PALETTE.length],
    note: d.source === 'node' ? '节点实测' : (d.exclusive ? '独立订阅' : '共享账号 · 仅供参考'),
  })),
});

const svgDaily = renderStacked({
  title: '每日用量（近 14 天）',
  series: dailySeries,
  keys: orderedAirports,
  colors,
});

const svgHourly = renderStacked({
  title: '每小时用量（近 24 小时）',
  series: hourlySeries,
  keys: orderedAirports,
  colors,
});

/* ------------------------------------------------------------- README 区块 */

function fmtExpire(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function buildReadmeBlock() {
  const lines = [];
  lines.push(`> 数据更新时间：**${aggregate.generatedAtLocal}**（${TZ}）｜本周期起算：${cycleStart}｜每次设备上报后自动刷新`);
  lines.push('');
  lines.push(`**本周期总用量 ${fmtBytes(aggregate.totals.cycle)}**　·　今日 ${fmtBytes(aggregate.totals.today)}　·　近 24 小时 ${fmtBytes(aggregate.totals.last24h)}`);
  lines.push('');

  if (!airports.length) {
    lines.push('_还没有数据。确认设备端模块已启用、`config/meter.json` 里配了机场订阅，并且 GitHub 令牌有写权限。_');
    return lines.join('\n');
  }

  lines.push('### 各机场');
  lines.push('');
  lines.push('| 机场 | 已用 | 套餐 | 剩余 | 到期 |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const a of airports) {
    const pct = a.total ? ` (${Math.round((a.used / a.total) * 100)}%)` : '';
    lines.push(
      `| ${a.name}${a.shared ? ' <sub>共享</sub>' : ''} | ${fmtBytes(a.used)}${pct} | ${a.total ? fmtBytes(a.total) : '—'} | ${a.total ? fmtBytes(Math.max(0, a.total - a.used)) : '—'} | ${fmtExpire(a.expire)} |`
    );
  }
  lines.push('');

  lines.push('### 机场 × 设备');
  lines.push('');
  const devNames = deviceRows.map((d) => d.name);
  lines.push(`| 机场 | ${devNames.join(' | ')} | 机场总计 |`);
  lines.push(`| --- | ${devNames.map(() => '---:').join(' | ')} | ---: |`);
  for (const row of matrix) {
    const cells = devNames.map((dn) => {
      const cell = row.cells.find((c) => c.device === dn);
      if (!cell) return '·';
      if (cell.shared) return '共享';
      return fmtBytes(cell.bytes);
    });
    lines.push(`| ${row.airport} | ${cells.join(' | ')} | ${fmtBytes(row.used)} |`);
  }
  lines.push('');
  lines.push('<sub>「共享」= 多台设备用同一个机场账号，机场只给出账号总量，无法再按设备拆开；想要设备级精确数字，让每台设备用独立订阅，或换用能读节点计数的客户端（Surge 等）。</sub>');
  lines.push('');

  lines.push('### 趋势');
  lines.push('');
  lines.push('<img src="docs/assets/airports.svg" width="760" alt="各机场用量">');
  lines.push('');
  lines.push('<img src="docs/assets/daily.svg" width="760" alt="每日用量">');
  lines.push('');
  lines.push('<img src="docs/assets/hourly.svg" width="760" alt="每小时用量">');
  lines.push('');
  lines.push('<img src="docs/assets/devices.svg" width="760" alt="各设备用量">');
  lines.push('');

  if (warnings.length) {
    lines.push('<details><summary>数据告警</summary>');
    lines.push('');
    warnings.forEach((w) => lines.push(`- ${w}`));
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------- 输出 */

if (!CHECK_ONLY) {
  const docsData = path.join(ROOT, 'docs', 'data');
  const assets = path.join(ROOT, 'docs', 'assets');
  fs.mkdirSync(docsData, { recursive: true });
  fs.mkdirSync(assets, { recursive: true });

  fs.writeFileSync(path.join(docsData, 'aggregate.json'), JSON.stringify(aggregate, null, 1));
  fs.writeFileSync(path.join(assets, 'airports.svg'), svgAirports);
  fs.writeFileSync(path.join(assets, 'devices.svg'), svgDevices);
  fs.writeFileSync(path.join(assets, 'daily.svg'), svgDaily);
  fs.writeFileSync(path.join(assets, 'hourly.svg'), svgHourly);

  const readmePath = path.join(ROOT, 'README.md');
  const START = '<!-- TRAFFIC:START -->';
  const END = '<!-- TRAFFIC:END -->';
  let readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
  const block = `${START}\n${buildReadmeBlock()}\n${END}`;
  if (readme.includes(START) && readme.includes(END)) {
    readme = readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
  } else {
    readme = `${readme.trimEnd()}\n\n${block}\n`;
  }
  fs.writeFileSync(readmePath, readme);

  console.log(`聚合完成：${devices.length} 台设备 / ${airports.length} 个机场`);
  airports.forEach((a) => console.log(`  ${a.name}: ${fmtBytes(a.used)}${a.total ? ` / ${fmtBytes(a.total)}` : ''}`));
} else {
  console.log(`检查通过：${devices.length} 台设备 / ${airports.length} 个机场`);
}
