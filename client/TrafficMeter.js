/**
 * TrafficMeter.js — 代理流量计量 + GitHub 上报（Shadowrocket / Surge 兼容）
 * ---------------------------------------------------------------------------
 * 运行方式：cron 脚本，默认每 10 分钟一次（见 TrafficMeter.module）。
 *
 * 两种采集源，按运行环境自动选择：
 *
 *   [sub] Shadowrocket / 任意客户端
 *     轮询每个机场的订阅链接，读响应头 subscription-userinfo:
 *       upload=123; download=456; total=107374182400; expire=1735689600
 *     这是机场自己统计的账号用量，跨设备汇总，权威且不需要客户端配合。
 *     缺点：账号级数字，多设备共享同一订阅时无法再按设备拆开。
 *
 *   [node] Surge 系（有 $httpAPI 的客户端）
 *     调 /v1/metrics 拿 surge_policy_in/out_bytes_total{policy}，按节点名映射到机场，
 *     是本机真实流量，精确到设备。
 *
 * 两条路产出的都是「机场 → 字节增量」，写进同一份 days/hours 结构，
 * GitHub 那边的聚合脚本不用关心数据从哪来。
 *
 * 配置来源（优先级从高到低）：
 *   1. $persistentStore['TrafficMeter.config']  完整 JSON，进阶用法
 *   2. 仓库里的 config/meter.json（通过 Contents API 拉，缓存 1 小时）
 *   3. $argument 里的 key=value 覆盖项（device / repo / token / branch ...）
 */

/* ===========================================================================
 * 1. 默认配置
 * ========================================================================= */

var TM_SCHEMA = 1;
var TM_STATE_KEY = 'TrafficMeter.state';
var TM_CONFIG_KEY = 'TrafficMeter.config';
var TM_CFG_CACHE_KEY = 'TrafficMeter.configCache';
var TM_TOKEN_KEY = 'TrafficMeter.token';
var TM_NOTIFY_KEY = 'TrafficMeter.lastNotify';

var TM_DEFAULTS = {
  device: '',
  repo: '',
  branch: 'main',
  token: '',
  cfgPath: 'config/meter.json',
  dir: 'data/devices',
  interval: 10,          // 上传间隔（分钟）
  pollInterval: 10,      // 订阅轮询间隔（分钟）
  retention: 120,        // 保留天数
  hoursRetention: 72,    // 保留小时桶数
  airports: [],          // [{name, sub, quotaGB, resetDay, color, match:[regex]}]
  airportGroups: [],
  autoGroup: false,
  excludeGroups: ['Proxy', 'GLOBAL', 'SELECT', '节点选择', '手动选择', '手动切换',
    '国外流量', '国内流量', '其它流量', 'Final', '兜底', '自动选择', '故障转移', '负载均衡'],
  excludePolicies: ['DIRECT', 'REJECT', 'REJECT-TINYGIF', 'REJECT-DROP', 'REJECT-NO-DROP'],
  fallback: '未分组',
  notify: true,
  debug: false
};

/* ===========================================================================
 * 2. 小工具
 * ========================================================================= */

function tmPad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function tmNow(ts) {
  var d = ts ? new Date(ts) : new Date();
  var date = d.getFullYear() + '-' + tmPad2(d.getMonth() + 1) + '-' + tmPad2(d.getDate());
  var hour = tmPad2(d.getHours());
  return { ts: d.getTime(), date: date, hour: hour, hourKey: date + 'T' + hour };
}

function tmLog(cfg, msg) {
  if (cfg && cfg.debug && typeof console !== 'undefined' && console.log) {
    console.log('[TrafficMeter] ' + msg);
  }
}

function tmSafeNum(v) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function tmAdd(bucket, key, up, down) {
  var cur = bucket[key];
  if (!cur) { bucket[key] = [up, down]; return; }
  cur[0] += up;
  cur[1] += down;
}

function tmMergeMax(dst, src) {
  Object.keys(src || {}).forEach(function (k) {
    var a = dst[k], b = src[k];
    if (!Array.isArray(b)) return;
    if (!Array.isArray(a)) { dst[k] = [tmSafeNum(b[0]), tmSafeNum(b[1])]; return; }
    dst[k] = [Math.max(a[0], tmSafeNum(b[0])), Math.max(a[1], tmSafeNum(b[1]))];
  });
  return dst;
}

/* ---------------------------- base64（JSC 里没有 btoa/atob 保证） ---------- */

var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_INDEX = {};
(function () {
  for (var i = 0; i < B64_CHARS.length; i++) B64_INDEX[B64_CHARS.charAt(i)] = i;
})();

function tmUtf8Encode(str) {
  var bytes = [], i, c, c2, cp;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      c2 = str.charCodeAt(i + 1);
      cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      i++;
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return bytes;
}

function tmUtf8Decode(bytes) {
  var out = '', i = 0, b, cp;
  while (i < bytes.length) {
    b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
    } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    } else {
      cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    }
  }
  return out;
}

function tmBase64Encode(str) {
  var bytes = tmUtf8Encode(str);
  var out = [], i, b1, b2, b3;
  for (i = 0; i < bytes.length; i += 3) {
    b1 = bytes[i];
    b2 = bytes[i + 1];
    b3 = bytes[i + 2];
    out.push(B64_CHARS.charAt(b1 >> 2));
    out.push(B64_CHARS.charAt(((b1 & 3) << 4) | ((b2 === undefined ? 0 : b2) >> 4)));
    out.push(b2 === undefined ? '=' : B64_CHARS.charAt(((b2 & 15) << 2) | ((b3 === undefined ? 0 : b3) >> 6)));
    out.push(b3 === undefined ? '=' : B64_CHARS.charAt(b3 & 63));
  }
  return out.join('');
}

function tmBase64Decode(b64) {
  var s = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  var bytes = [], i, c1, c2, c3, c4;
  for (i = 0; i < s.length; i += 4) {
    c1 = B64_INDEX[s.charAt(i)];
    c2 = B64_INDEX[s.charAt(i + 1)];
    c3 = B64_INDEX[s.charAt(i + 2)];
    c4 = B64_INDEX[s.charAt(i + 3)];
    if (c1 === undefined) break;
    bytes.push((c1 << 2) | (c2 === undefined ? 0 : c2 >> 4));
    if (c3 !== undefined) bytes.push(((c2 & 15) << 4) | (c3 >> 2));
    if (c4 !== undefined) bytes.push(((c3 & 3) << 6) | c4);
  }
  return tmUtf8Decode(bytes);
}

/* ===========================================================================
 * 3. 配置
 * ========================================================================= */

/** 宽松解析单行 JSON：Surge/小火箭可能把含逗号的 argument 截断，尽量抢救完整键值 */
function tmParseLooseJson(str) {
  var out = {};
  try {
    var obj = JSON.parse(str);
    if (obj && typeof obj === 'object') return obj;
  } catch (e) { /* 继续宽松扫描 */ }
  var re = /"([A-Za-z0-9_]+)"\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?|\[[^\]]*\]|\{[^{}]*\})/g;
  var m;
  while ((m = re.exec(str))) {
    var raw = m[2], val;
    if (raw.charAt(0) === '"') {
      try { val = JSON.parse(raw); } catch (e2) { continue; }
    } else if (raw === 'true' || raw === 'false') {
      val = raw === 'true';
    } else if (raw === 'null') {
      val = null;
    } else if (raw.charAt(0) === '[' || raw.charAt(0) === '{') {
      try { val = JSON.parse(raw); } catch (e3) { continue; }
    } else {
      val = parseFloat(raw);
    }
    out[m[1]] = val;
  }
  return out;
}

/** key=value&key=value（值里不要带 & ，订阅链接请放进 config/meter.json） */
function tmParseKvConfig(str) {
  var cfg = {};
  String(str || '').split('&').forEach(function (part) {
    part = part.trim();
    if (!part) return;
    var idx = part.indexOf('=');
    if (idx < 0) return;
    var key = part.slice(0, idx).trim();
    var val = part.slice(idx + 1).trim();
    if (!key) return;
    if (key === 'autoGroup' || key === 'notify' || key === 'debug') {
      cfg[key] = val === '1' || val === 'true' || val === 'yes';
      return;
    }
    if (key === 'interval' || key === 'pollInterval' || key === 'retention' || key === 'hoursRetention') {
      var n = parseFloat(val);
      if (isFinite(n) && n > 0) cfg[key] = n;
      return;
    }
    cfg[key] = val;
  });
  return cfg;
}

function tmParseConfigString(str) {
  var s = String(str || '').trim();
  if (!s) return {};
  if (s.charAt(0) === '{') return tmParseLooseJson(s);
  if (s.indexOf('=') >= 0) return tmParseKvConfig(s);
  try { return tmParseLooseJson(tmBase64Decode(s)); } catch (e) { return {}; }
}

function tmMergeConfig(base, extra) {
  var out = {}, k;
  for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
  for (k in extra) {
    if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
    if (extra[k] === undefined || extra[k] === null || extra[k] === '') continue;
    out[k] = extra[k];
  }
  return out;
}

function tmNormalizeConfig(cfg) {
  cfg.interval = Math.max(1, Math.round(Number(cfg.interval) || TM_DEFAULTS.interval));
  cfg.pollInterval = Math.max(1, Math.round(Number(cfg.pollInterval) || TM_DEFAULTS.pollInterval));
  cfg.retention = Math.max(1, Math.round(Number(cfg.retention) || TM_DEFAULTS.retention));
  cfg.hoursRetention = Math.max(2, Math.round(Number(cfg.hoursRetention) || TM_DEFAULTS.hoursRetention));
  if (!Array.isArray(cfg.airports)) cfg.airports = [];
  cfg.airports = cfg.airports.filter(function (a) { return a && a.name; });
  return cfg;
}

/* ===========================================================================
 * 4. 采集源 A：订阅 subscription-userinfo（Shadowrocket 主用）
 * ========================================================================= */

/** 解析 subscription-userinfo: upload=1; download=2; total=3; expire=4 */
function tmParseUserInfo(str) {
  var out = {};
  if (!str) return out;
  var re = /([A-Za-z_-]+)\s*=\s*("?)([^;"]*)\2/g;
  var m;
  while ((m = re.exec(String(str)))) {
    var key = m[1].toLowerCase();
    var val = m[3].trim();
    if (key === 'upload' || key === 'download' || key === 'total' || key === 'expire') {
      out[key] = tmSafeNum(val);
    }
  }
  return out;
}

function tmFindHeader(headers, name) {
  if (!headers) return null;
  var lower = String(name).toLowerCase();
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lower) return headers[keys[i]];
  }
  return null;
}

/* -------------------- 非标准格式：部分机场不发送 subscription-userinfo ----------
 * 实测过的两种变体（都拿不到标准头，只能解析响应体）：
 *
 *   A) STATUS 行（base64 编码的节点列表，首行是明文 STATUS）
 *      STATUS=🚀↑:1.84GB,↓:14.48GB,TOT:100GB💡Expires:2026-11-08
 *      ↑ = 上传，↓ = 下载，TOT = 套餐总量，Expires = 到期日
 *
 *   B) 中文标注（Surge 配置的节点组名里塞用量）
 *      剩余流量：4.85 TB，套餐到期：长期有效
 *      这种只有"剩余"没有"已用"，需要配合 quotaGB 反推已用
 * ------------------------------------------------------------------------- */

/** 把 "1.84GB" / "4.85 TB" / "100GB" 解析成字节数 */
function tmParseSize(str) {
  if (!str) return 0;
  var m = String(str).match(/([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?)i?B/i);
  if (!m) return 0;
  var v = parseFloat(m[1]);
  if (!isFinite(v)) return 0;
  var unit = (m[2] || '').toUpperCase();
  var pow = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5 }[unit];
  return Math.round(v * Math.pow(1024, pow || 0));
}

/** 解析 "2026-11-08" / "长期有效" → unix 秒；无法解析返回 0 */
function tmParseExpireText(str) {
  if (!str) return 0;
  var s = String(str).trim();
  if (/长期|永久|无限|不过期/.test(s)) return 0;   // 长期有效 = 无到期日
  var m = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!m) return 0;
  var t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 16, 0, 0) / 1000;
  return isFinite(t) ? Math.round(t) : 0;
}

/** 格式 A：STATUS=🚀↑:1.84GB,↓:14.48GB,TOT:100GB💡Expires:2026-11-08 */
function tmParseStatusLine(text) {
  var out = {};
  if (!text) return out;
  var m = String(text).match(/STATUS\s*=\s*([^\r\n]+)/i);
  if (!m) return out;
  var line = m[1];

  var up = line.match(/[↑⬆]\s*[:：]?\s*([0-9.]+\s*[KMGTP]?i?B)/i);
  var down = line.match(/[↓⬇]\s*[:：]?\s*([0-9.]+\s*[KMGTP]?i?B)/i);
  var tot = line.match(/TOT\s*[:：]?\s*([0-9.]+\s*[KMGTP]?i?B)/i);
  var exp = line.match(/Expires?\s*[:：]?\s*([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2})/i);

  if (up) out.upload = tmParseSize(up[1]);
  if (down) out.download = tmParseSize(down[1]);
  if (tot) out.total = tmParseSize(tot[1]);
  if (exp) out.expire = tmParseExpireText(exp[1]);
  return out;
}

/** 格式 B：剩余流量：4.85 TB，套餐到期：长期有效（只有剩余量） */
function tmParseRemainText(text) {
  var out = {};
  if (!text) return out;
  var body = String(text);
  var rem = body.match(/剩余流量\s*[:：]\s*([0-9.]+\s*[KMGTP]?i?B)/i);
  var exp = body.match(/套餐到期\s*[:：]\s*([^\r\n,，|]+)/i);
  if (rem) out.remain = tmParseSize(rem[1]);
  if (exp) out.expire = tmParseExpireText(exp[1]);
  return out;
}

/**
 * 通用入口：从一次订阅响应里尽力提取用量。
 * 依次尝试 标准头 → STATUS 行 → base64 解码后再试 → 中文剩余量。
 * 返回 {upload, download, total, remain, expire}，取不到的字段不出现。
 */
function tmExtractUsage(headers, bodyText, isBase64) {
  var res = {};

  // 1. 标准头
  var std = tmParseUserInfo(tmFindHeader(headers, 'subscription-userinfo'));
  var hasStd = false;
  ['upload', 'download', 'total', 'expire'].forEach(function (k) {
    if (std[k] !== undefined && std[k] !== null) { res[k] = std[k]; hasStd = true; }
  });
  if (hasStd) return res;

  var body = String(bodyText || '');

  // 2. 响应体里的 STATUS 行（明文）
  var st = tmParseStatusLine(body);
  if (Object.keys(st).length) return tmMergeUsage(res, st);

  // 3. 中文"剩余流量"标注（明文）
  var rm = tmParseRemainText(body);
  if (Object.keys(rm).length) return tmMergeUsage(res, rm);

  // 4. base64 解一层再试（节点列表常见编码方式）
  if (isBase64 !== false && body.length > 20 && !/[\[{]/.test(body.slice(0, 40))) {
    var dec = '';
    try { dec = tmBase64Decode(body); } catch (e) { dec = ''; }
    if (dec) {
      var st2 = tmParseStatusLine(dec);
      if (Object.keys(st2).length) return tmMergeUsage(res, st2);
      var rm2 = tmParseRemainText(dec);
      if (Object.keys(rm2).length) return tmMergeUsage(res, rm2);
    }
  }
  return res;
}

function tmMergeUsage(a, b) {
  Object.keys(b || {}).forEach(function (k) {
    if (b[k] !== undefined && b[k] !== null) a[k] = b[k];
  });
  return a;
}

/* ===========================================================================
 * 5. 采集源 B：Surge 系 /v1/metrics（本机节点级）
 * ========================================================================= */

function tmParsePrometheus(text) {
  var out = {};
  if (!text || typeof text !== 'string') return out;
  var re = /surge_policy_(in|out)_bytes_total\{[^}]*?policy="((?:[^"\\]|\\.)*)"[^}]*\}\s+([0-9.eE+]+)/g;
  var m;
  while ((m = re.exec(text))) {
    var name = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    var val = tmSafeNum(m[3]);
    var cur = out[name] || (out[name] = { up: 0, down: 0 });
    if (m[1] === 'in') cur.down = val; else cur.up = val;
  }
  return out;
}

function tmExtractFromJson(obj, depth) {
  depth = depth || 0;
  var out = {};
  if (!obj || typeof obj !== 'object' || depth > 4) return out;
  Object.keys(obj).forEach(function (key) {
    var node = obj[key];
    if (!node || typeof node !== 'object') return;
    var up = node.up, down = node.down;
    if (up === undefined) up = node.out;
    if (down === undefined) down = node.in;
    if (up === undefined) up = node.upload;
    if (down === undefined) down = node.download;
    if (typeof up === 'number' || typeof down === 'number') {
      out[key] = { up: tmSafeNum(up), down: tmSafeNum(down) };
    } else {
      var sub = tmExtractFromJson(node, depth + 1);
      Object.keys(sub).forEach(function (k) { if (!out[k]) out[k] = sub[k]; });
    }
  });
  return out;
}

/* ===========================================================================
 * 6. 节点 → 机场 映射（仅 node 源需要）
 * ========================================================================= */

function tmCompileRules(airports) {
  var rules = [];
  (airports || []).forEach(function (a) {
    if (!a || !a.name) return;
    var patterns = [];
    (a.match || []).forEach(function (p) {
      if (!p) return;
      try { patterns.push(new RegExp(p, 'i')); } catch (e) { /* 坏正则忽略 */ }
    });
    rules.push({ name: String(a.name), patterns: patterns });
  });
  return rules;
}

function tmResolveAirport(policy, ctx) {
  var i, j, r;
  for (i = 0; i < ctx.rules.length; i++) {
    r = ctx.rules[i];
    for (j = 0; j < r.patterns.length; j++) {
      if (r.patterns[j].test(policy)) return r.name;
    }
  }
  var group = ctx.groupMap && ctx.groupMap[policy];
  if (group) {
    if ((ctx.config.airportGroups || []).indexOf(group) >= 0) return group;
    if (ctx.config.autoGroup && (ctx.config.excludeGroups || []).indexOf(group) < 0) return group;
  }
  return ctx.config.fallback || '未分组';
}

function tmIsExcluded(policy, cfg) {
  var list = cfg.excludePolicies || [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item) continue;
    if (item === policy) return true;
    if (item.indexOf('*') >= 0) {
      var re = new RegExp('^' + item.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      if (re.test(policy)) return true;
    }
  }
  return false;
}

/* ===========================================================================
 * 7. 状态与增量
 * ========================================================================= */

function tmEmptyState(device) {
  return {
    v: TM_SCHEMA,
    device: device || '',
    source: '',
    updatedAt: 0,
    lastUploadAt: 0,
    lastCounters: {},   // node 源：{policy: [up, down]}
    lastSub: {},        // sub 源：{airport: {u,d,t,e,at}}
    airports: {},       // 快照：{airport: {up, down, total, expire, at}}
    totals: {},         // 本机观测到的累计：[up, down]
    days: {},
    hours: {}
  };
}

function tmLoadState(raw, device) {
  var state = tmEmptyState(device);
  if (!raw) return state;
  var p;
  try { p = JSON.parse(raw); } catch (e) { return state; }
  if (!p || typeof p !== 'object') return state;
  state.device = p.device || device || '';
  state.source = p.source || '';
  state.updatedAt = tmSafeNum(p.updatedAt);
  state.lastUploadAt = tmSafeNum(p.lastUploadAt);
  state.lastCounters = p.lastCounters && typeof p.lastCounters === 'object' ? p.lastCounters : {};
  state.lastSub = p.lastSub && typeof p.lastSub === 'object' ? p.lastSub : {};
  state.airports = p.airports && typeof p.airports === 'object' ? p.airports : {};
  state.totals = p.totals && typeof p.totals === 'object' ? p.totals : {};
  state.days = p.days && typeof p.days === 'object' ? p.days : {};
  state.hours = p.hours && typeof p.hours === 'object' ? p.hours : {};
  return state;
}

/** 把一批 {机场: [up, down]} 增量写进 天/小时/总计 */
function tmApplyDeltas(state, deltas, nowInfo) {
  var moved = 0;
  Object.keys(deltas).forEach(function (airport) {
    var d = deltas[airport];
    if (!d[0] && !d[1]) return;
    moved += d[0] + d[1];
    var day = state.days[nowInfo.date] || (state.days[nowInfo.date] = {});
    tmAdd(day, airport, d[0], d[1]);
    var hour = state.hours[nowInfo.hourKey] || (state.hours[nowInfo.hourKey] = {});
    tmAdd(hour, airport, d[0], d[1]);
    tmAdd(state.totals, airport, d[0], d[1]);
  });
  return moved;
}

/** node 源：累计计数器差分 */
function tmDeltaFromCounters(state, counters, ctx, nowInfo) {
  var prev = state.lastCounters || {};
  var deltas = {};
  var baselineOnly = Object.keys(prev).length === 0;
  var policies = Object.keys(counters);

  for (var i = 0; i < policies.length; i++) {
    var policy = policies[i];
    var cur = counters[policy];
    var old = prev[policy];
    var up = 0, down = 0;
    if (old) {
      // 新值小于旧值 = 引擎重启，按从 0 重计
      up = cur.up >= old[0] ? cur.up - old[0] : cur.up;
      down = cur.down >= old[1] ? cur.down - old[1] : cur.down;
    }
    prev[policy] = [cur.up, cur.down];
    if ((!up && !down) || tmIsExcluded(policy, ctx.config)) continue;
    var airport = tmResolveAirport(policy, ctx);
    var slot = deltas[airport] || (deltas[airport] = [0, 0]);
    slot[0] += up;
    slot[1] += down;
  }
  state.lastCounters = prev;
  return { deltas: deltas, baselineOnly: baselineOnly };
}

/** sub 源：账号累计值差分（机场周期重置时新值会变小，此时按新值算） */
function tmDeltaFromSub(state, samples, nowInfo) {
  var deltas = {};
  var baselineOnly = Object.keys(state.lastSub || {}).length === 0;

  Object.keys(samples).forEach(function (airport) {
    var s = samples[airport];
    if (!s) return;
    var old = state.lastSub[airport];
    var up = 0, down = 0;
    if (old) {
      up = s.u >= (old.u || 0) ? s.u - (old.u || 0) : s.u;
      down = s.d >= (old.d || 0) ? s.d - (old.d || 0) : s.d;
    }
    state.lastSub[airport] = { u: s.u, d: s.d, t: s.t, e: s.e, at: nowInfo.ts };
    // 对外发布的快照用秒级时间戳，和 provider 的 expire 对齐
    state.airports[airport] = { up: s.u, down: s.d, total: s.t, expire: s.e, at: Math.floor(nowInfo.ts / 1000) };
    if (!up && !down) return;
    var slot = deltas[airport] || (deltas[airport] = [0, 0]);
    slot[0] += up;
    slot[1] += down;
  });
  return { deltas: deltas, baselineOnly: baselineOnly };
}

function tmPrune(state, cfg, nowInfo) {
  var keepDays = {};
  var cutoff = nowInfo.ts - cfg.retention * 86400000;
  Object.keys(state.days).sort().forEach(function (d) {
    var t = new Date(d + 'T00:00:00').getTime();
    if (!isFinite(t) || t >= cutoff) keepDays[d] = state.days[d];
  });
  if (state.days[nowInfo.date] && !keepDays[nowInfo.date]) keepDays[nowInfo.date] = state.days[nowInfo.date];
  state.days = keepDays;

  var hours = Object.keys(state.hours).sort();
  var keep = hours.slice(Math.max(0, hours.length - cfg.hoursRetention));
  var keepHours = {};
  keep.forEach(function (h) { keepHours[h] = state.hours[h]; });
  state.hours = keepHours;
  return state;
}

/* ===========================================================================
 * 8. GitHub
 * ========================================================================= */

function tmSlug(name) {
  var s = String(name || 'device').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-');
  s = s.replace(/^-|-$/g, '');
  return s || 'device';
}

function tmGithubRequest(httpClient, method, url, token, body, accept, cb) {
  var opts = {
    url: url,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TrafficMeter',
      'Content-Type': 'application/json'
    },
    timeout: 15
  };
  if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  var fn = httpClient[method] || httpClient.get;
  fn(opts, function (err, resp, data) {
    var status = resp && resp.status ? resp.status : 0;
    var json = null;
    if (typeof data === 'string' && data) {
      try { json = JSON.parse(data); } catch (e) { json = null; }
    } else if (data && typeof data === 'object') {
      json = data;
    }
    cb(err || null, status, json, data);
  });
}

function tmContentsUrl(cfg, path, ref) {
  var url = 'https://api.github.com/repos/' + cfg.repo + '/contents/' +
    path.split('/').map(encodeURIComponent).join('/');
  if (ref) url += '?ref=' + encodeURIComponent(ref);
  return url;
}

/** 拉仓库里的 config/meter.json（支持私有库），失败返回 null */
function tmFetchRemoteConfig(httpClient, cfg, cb) {
  if (!cfg.repo || !cfg.token) { cb(null); return; }
  tmGithubRequest(httpClient, 'get', tmContentsUrl(cfg, cfg.cfgPath, cfg.branch), cfg.token, null,
    'application/vnd.github.raw', function (err, status, json, data) {
      if (err || status !== 200) { cb(null, status); return; }
      var text = typeof data === 'string' ? data : (json && json.content ? tmBase64Decode(json.content) : '');
      var parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
      cb(parsed);
    });
}

function tmBuildDoc(state) {
  return {
    schema: TM_SCHEMA,
    device: state.device,
    source: state.source,
    updatedAt: state.updatedAt,
    airports: state.airports,
    totals: state.totals,
    days: state.days,
    hours: state.hours
  };
}

function tmMergeDoc(doc, remote) {
  if (!remote || typeof remote !== 'object') return doc;
  tmMergeMax(doc.totals, remote.totals);
  Object.keys(remote.days || {}).forEach(function (d) {
    if (!doc.days[d]) { doc.days[d] = remote.days[d]; return; }
    tmMergeMax(doc.days[d], remote.days[d]);
  });
  Object.keys(remote.hours || {}).forEach(function (h) {
    if (!doc.hours[h]) { doc.hours[h] = remote.hours[h]; return; }
    tmMergeMax(doc.hours[h], remote.hours[h]);
  });
  return doc;
}

function tmUpload(httpClient, cfg, state, cb) {
  if (typeof httpClient.put !== 'function') { cb('client-no-put'); return; }
  var file = tmSlug(state.device) + '.json';
  var path = (cfg.dir || 'data/devices').replace(/\/+$/, '') + '/' + file;
  var api = tmContentsUrl(cfg, path, cfg.branch);

  tmGithubRequest(httpClient, 'get', api, cfg.token, null, null, function (err, status, json) {
    if (err) { cb('get-failed: ' + err); return; }
    var sha = null, remote = null;
    if (status === 200 && json) {
      sha = json.sha;
      if (json.content) {
        try { remote = JSON.parse(tmBase64Decode(json.content)); } catch (e) { remote = null; }
      }
    } else if (status !== 404) {
      cb('get-status-' + status);
      return;
    }

    var doc = tmMergeDoc(tmBuildDoc(state), remote);
    var body = {
      message: 'traffic: ' + state.device + ' @ ' + new Date(state.updatedAt).toISOString(),
      content: tmBase64Encode(JSON.stringify(doc)),
      branch: cfg.branch || 'main'
    };
    if (sha) body.sha = sha;

    tmGithubRequest(httpClient, 'put', api, cfg.token, body, null, function (err2, status2, json2) {
      if (err2) { cb('put-failed: ' + err2); return; }
      if (status2 === 200 || status2 === 201) { cb(null, doc); return; }
      cb('put-status-' + status2 + (json2 && json2.message ? ' ' + json2.message : ''));
    });
  });
}

/* ===========================================================================
 * 9. 主流程
 * ========================================================================= */

function tmMain(env) {
  var httpClient = env.httpClient;
  var httpApi = env.httpApi;
  var storeRead = env.storeRead;
  var storeWrite = env.storeWrite;
  var notify = env.notify;
  var argument = env.argument || '';
  var environment = env.environment || {};
  var done = env.done || function () {};
  var nowTs = Date.now();
  var nowInfo = tmNow(nowTs);

  /* ---- 配置：默认 < 仓库 JSON < argument 覆盖 ---- */
  var argCfg = tmParseConfigString(argument);
  var cfg = tmMergeConfig(TM_DEFAULTS, {});
  cfg = tmMergeConfig(cfg, argCfg);

  var localCfg = storeRead(TM_CONFIG_KEY);
  if (localCfg) {
    cfg = tmMergeConfig(cfg, tmParseConfigString(localCfg));
  }
  if (!cfg.token) {
    var t = storeRead(TM_TOKEN_KEY);
    if (t) cfg.token = t;
  }
  cfg = tmNormalizeConfig(cfg);

  var state = null;

  function deviceName() {
    return cfg.device || environment['device-model'] || environment.system || 'device';
  }

  function save() {
    try { storeWrite(JSON.stringify(state), TM_STATE_KEY); } catch (e) { /* ignore */ }
  }

  function notifyOnce(title, subtitle, body) {
    if (!cfg.notify) return;
    var last = Number(storeRead(TM_NOTIFY_KEY) || 0);
    if (nowTs - last < 3600000) return;
    try { storeWrite(String(nowTs), TM_NOTIFY_KEY); } catch (e) { /* ignore */ }
    notify(title, subtitle, body);
  }

  function fail(reason) {
    tmLog(cfg, 'fail: ' + reason);
    notifyOnce('流量统计失败', deviceName(), String(reason).slice(0, 180));
    if (state) { state.updatedAt = nowTs; save(); }
    done();
  }

  /* ---- 配置来自仓库时先拉一次（带 1 小时缓存） ---- */
  function withRemoteConfig(next) {
    if (!cfg.repo || !cfg.token) { next(); return; }
    if (localCfg) { next(); return; }          // 本地已给完整配置，不再拉
    var cached = null;
    try { cached = JSON.parse(storeRead(TM_CFG_CACHE_KEY) || 'null'); } catch (e) { cached = null; }
    if (cached && cached.at && nowTs - cached.at < 3600000) {
      cfg = tmNormalizeConfig(tmMergeConfig(cfg, cached.data || {}));
      next();
      return;
    }
    tmFetchRemoteConfig(httpClient, cfg, function (remote) {
      if (remote) {
        cfg = tmNormalizeConfig(tmMergeConfig(cfg, remote));
        try { storeWrite(JSON.stringify({ at: nowTs, data: remote }), TM_CFG_CACHE_KEY); } catch (e) { /* ignore */ }
        tmLog(cfg, 'config loaded from ' + cfg.cfgPath + ', airports=' + cfg.airports.length);
      } else {
        tmLog(cfg, 'config fetch failed, using argument/defaults');
      }
      next();
    });
  }

  /* ---- 采集 ---- */
  function collectNode(next) {
    if (!httpApi) { next('no-http-api'); return; }
    try {
      httpApi('GET', '/v1/metrics', {}, function (result) {
        var text = result;
        if (result && typeof result === 'object') {
          text = result.metrics || result.text || result.body || result.data;
          if (typeof text !== 'string') { try { text = JSON.stringify(result); } catch (e) { text = ''; } }
        }
        var counters = tmParsePrometheus(text);
        if (Object.keys(counters).length) { next(null, counters); return; }
        httpApi('GET', '/v1/traffic', {}, function (t) {
          var alt = tmExtractFromJson(t || {});
          if (Object.keys(t).length) { next(null, alt); return; }
          next('no-metrics');
        });
      });
    } catch (e) {
      next('api-error: ' + e);
    }
  }

  function collectSub(next) {
    var airports = (cfg.airports || []).filter(function (a) { return a && a.sub; });
    if (!airports.length) { next('no-subscription-configured'); return; }

    var samples = {};
    var idx = 0;
    var failed = 0;

    function step() {
      if (idx >= airports.length) {
        if (!Object.keys(samples).length) { next('all-subscriptions-failed'); return; }
        next(null, samples, failed);
        return;
      }
      var airport = airports[idx++];
      // 同一个机场不必每轮都拉：距离上次拉取不足 pollInterval 就跳过
      var prev = state && state.lastSub && state.lastSub[airport.name];
      if (prev && prev.at && nowTs - prev.at < cfg.pollInterval * 60000) { step(); return; }

      var opts = { url: airport.sub, timeout: 20 };
      if (airport.ua) opts.headers = { 'User-Agent': airport.ua };
      httpClient.get(opts, function (err, resp, data) {
        var headers = (resp && resp.headers) || {};
        var body = typeof data === 'string' ? data : '';
        // 标准头优先，其次解析响应体里的 STATUS 行 / 中文剩余量，再退到 base64 解码
        var info = tmExtractUsage(headers, body);

        // 只有"剩余量"没"已用"的机场（如 Surge 配置里塞的「剩余流量：4.85 TB」）：
        // 套餐总量从 quotaGB 拿，已用 = 总量 - 剩余
        if (info.remain && !info.download && !info.upload && airport.quotaGB) {
          var quota = Number(airport.quotaGB) * 1024 * 1024 * 1024;
          if (quota > info.remain) {
            info.total = quota;
            info.download = quota - info.remain;
            info.upload = 0;
          }
        }

        if (err || (!info.upload && !info.download && !info.total)) {
          failed++;
          tmLog(cfg, 'sub failed: ' + airport.name + ' ' + (err || ('no usage found, status=' +
            (resp && resp.status) + ', bodyLen=' + body.length)));
          step();
          return;
        }
        samples[airport.name] = {
          u: info.upload || 0,
          d: info.download || 0,
          t: info.total || 0,
          e: info.expire || 0
        };
        tmLog(cfg, 'sub ok: ' + airport.name + ' u=' + (info.upload || 0) +
          ' d=' + (info.download || 0) + ' t=' + (info.total || 0) +
          (info.remain ? ' remain=' + info.remain : ''));
        step();
      });
    }
    step();
  }

  function finish(source, err, payload, failedCount) {
    if (err) { fail(err); return; }

    var result;
    var ctx = null;
    state.source = source;
    if (source === 'node') {
      var groupMap = {};
      try {
        if (env.selectGroupDetails) {
          var details = env.selectGroupDetails() || {};
          Object.keys(details.groups || {}).forEach(function (g) {
            (details.groups[g] || []).forEach(function (p) { if (!groupMap[p]) groupMap[p] = g; });
          });
        }
      } catch (e) { /* ignore */ }
      ctx = { rules: tmCompileRules(cfg.airports), groupMap: groupMap, config: cfg };
      result = tmDeltaFromCounters(state, payload, ctx, nowInfo);
    } else {
      result = tmDeltaFromSub(state, payload, nowInfo);
    }

    // 这一轮到底认出了哪些机场（首轮没有增量，得从计数器/快照里反推，用于启动通知）
    var names = [];
    if (source === 'node') {
      var seen = {};
      Object.keys(payload).forEach(function (p) {
        if (tmIsExcluded(p, cfg)) return;
        var a = tmResolveAirport(p, ctx);
        if (!seen[a]) { seen[a] = 1; names.push(a); }
      });
    } else {
      names = Object.keys(state.airports);
    }

    var moved = tmApplyDeltas(state, result.deltas, nowInfo);
    tmPrune(state, cfg, nowInfo);
    state.device = deviceName();
    state.updatedAt = nowTs;

    var due = (nowTs - (state.lastUploadAt || 0)) >= cfg.interval * 60000;
    if (!due) {
      tmLog(cfg, 'buffered +' + moved + 'B');
      save();
      done();
      return;
    }
    if (!cfg.repo || !cfg.token) {
      tmLog(cfg, 'no repo/token, local only (+' + moved + 'B)');
      save();
      done();
      return;
    }

    tmUpload(httpClient, cfg, state, function (err2) {
      if (err2) { fail('upload: ' + err2); return; }
      state.lastUploadAt = nowTs;
      save();
      if (result.baselineOnly) {
        notify('流量统计已启动', state.device,
          names.length ? '已接入：' + names.join(' / ') : '尚未识别到机场，请检查 config/meter.json');
      }
      tmLog(cfg, 'uploaded +' + moved + 'B, airports=' +
        names.join(',') + (failedCount ? ' (failed ' + failedCount + ')' : ''));
      done();
    });
  }

  /* ---- 选源：有 $httpAPI 走节点级实测，否则走订阅头 ---- */
  withRemoteConfig(function () {
    state = tmLoadState(storeRead(TM_STATE_KEY), deviceName());

    // 节点级实测和订阅观测不能混用：同一台设备两者会指向同一份流量，加起来就翻倍了。
    // 所以有 $httpAPI 就只用节点级，sub 仅在纯订阅客户端（小火箭）下参与。
    if (httpApi) {
      collectNode(function (err, counters) {
        if (err) { fail(err); return; }
        finish('node', null, counters, 0);
      });
      return;
    }
    if (httpClient) {
      collectSub(function (err, samples, failed) {
        if (err) { fail(err); return; }
        finish('sub', null, samples, failed || 0);
      });
      return;
    }
    fail('no-network-capability');
  });
}

/* ===========================================================================
 * 10. 入口 & 导出
 * ========================================================================= */

if (typeof $httpClient !== 'undefined' || typeof $httpAPI !== 'undefined') {
  tmMain({
    httpClient: typeof $httpClient !== 'undefined' ? $httpClient : null,
    httpApi: typeof $httpAPI !== 'undefined' ? $httpAPI : null,
    storeRead: function (k) { return typeof $persistentStore !== 'undefined' ? $persistentStore.read(k) : null; },
    storeWrite: function (v, k) { return typeof $persistentStore !== 'undefined' ? $persistentStore.write(v, k) : false; },
    notify: function (t, s, b) { if (typeof $notification !== 'undefined') $notification.post(t, s, b); },
    selectGroupDetails: typeof $surge !== 'undefined' && $surge.selectGroupDetails ? $surge.selectGroupDetails : null,
    argument: typeof $argument !== 'undefined' ? $argument : '',
    environment: typeof $environment !== 'undefined' ? $environment : {},
    done: function () { if (typeof $done !== 'undefined') $done(); }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULTS: TM_DEFAULTS,
    nowInfo: tmNow,
    parseUserInfo: tmParseUserInfo,
    findHeader: tmFindHeader,
    parseSize: tmParseSize,
    parseExpireText: tmParseExpireText,
    parseStatusLine: tmParseStatusLine,
    parseRemainText: tmParseRemainText,
    extractUsage: tmExtractUsage,
    parsePrometheus: tmParsePrometheus,
    extractFromJson: tmExtractFromJson,
    parseLooseJson: tmParseLooseJson,
    parseKvConfig: tmParseKvConfig,
    parseConfigString: tmParseConfigString,
    mergeConfig: tmMergeConfig,
    normalizeConfig: tmNormalizeConfig,
    base64Encode: tmBase64Encode,
    base64Decode: tmBase64Decode,
    compileRules: tmCompileRules,
    resolveAirport: tmResolveAirport,
    isExcluded: tmIsExcluded,
    emptyState: tmEmptyState,
    loadState: tmLoadState,
    applyDeltas: tmApplyDeltas,
    deltaFromCounters: tmDeltaFromCounters,
    deltaFromSub: tmDeltaFromSub,
    prune: tmPrune,
    buildDoc: tmBuildDoc,
    mergeDoc: tmMergeDoc,
    slug: tmSlug
  };
}
