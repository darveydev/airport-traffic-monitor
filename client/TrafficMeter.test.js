/**
 * TrafficMeter 自测脚本
 * 用法：node TrafficMeter.test.js
 * 改采集/去重/差分逻辑后跑一遍，防止把流量算错（算错比不统计更糟）。
 */
const TM = require('./TrafficMeter.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const now = (ts) => TM.nowInfo(ts);

/* ---------- 1. subscription-userinfo 解析 ---------- */
{
  const raw = 'upload=1048576; download=1073741824; total=536870912000; expire=1798732800';
  const info = TM.parseUserInfo(raw);
  check('userinfo: upload', info.upload === 1048576, info.upload);
  check('userinfo: download', info.download === 1073741824, info.download);
  check('userinfo: total', info.total === 536870912000, info.total);
  check('userinfo: expire', info.expire === 1798732800, info.expire);
  check('userinfo: 空串安全', Object.keys(TM.parseUserInfo('')).length === 0);
  check('userinfo: 带引号', TM.parseUserInfo('upload="100"; download="200"').download === 200);

  const headers = { 'Content-Type': 'text/plain', 'Subscription-Userinfo': raw };
  check('header: 大小写不敏感', TM.findHeader(headers, 'subscription-userinfo') === raw);
  check('header: 缺失返回 null', TM.findHeader({}, 'subscription-userinfo') === null);
}

/* ---------- 2. sub 源差分（首轮只建基线 / 增量 / 周期重置） ---------- */
{
  const t1 = now(Date.parse('2026-10-25T10:00:00+08:00'));
  const state = TM.emptyState('iPhone');
  let r = TM.deltaFromSub(state, { 机场A: { u: 1000, d: 5000, t: 100000, e: 1798732800 } }, t1);
  check('sub: 首轮只建基线', r.baselineOnly === true && Object.keys(r.deltas).length === 0, r.deltas);
  check('sub: 快照已写入', state.airports['机场A'].down === 5000, state.airports['机场A']);

  const t2 = now(Date.parse('2026-10-25T10:10:00+08:00'));
  r = TM.deltaFromSub(state, { 机场A: { u: 1400, d: 7000, t: 100000, e: 1798732800 } }, t2);
  check('sub: 增量 up', r.deltas['机场A'][0] === 400, r.deltas);
  check('sub: 增量 down', r.deltas['机场A'][1] === 2000, r.deltas);
  check('sub: 第二轮不算基线', r.baselineOnly === false);

  const t3 = now(Date.parse('2026-11-01T00:05:00+08:00'));
  r = TM.deltaFromSub(state, { 机场A: { u: 10, d: 20, t: 100000, e: 1798732800 } }, t3);
  check('sub: 周期重置按新值算', r.deltas['机场A'][0] === 10 && r.deltas['机场A'][1] === 20, r.deltas);
}

/* ---------- 3. Prometheus 解析 ---------- */
{
  const text = [
    '# HELP surge_policy_in_bytes_total Downloaded bytes per policy',
    'surge_policy_in_bytes_total{policy="香港 01"} 1048576',
    'surge_policy_out_bytes_total{policy="香港 01"} 65536',
    'surge_policy_in_bytes_total{policy="DIRECT"} 999',
    'surge_policy_out_bytes_total{policy="DIRECT"} 111',
  ].join('\n');
  const counters = TM.parsePrometheus(text);
  check('prom: 节点数', Object.keys(counters).length === 2, Object.keys(counters));
  check('prom: down 取 in', counters['香港 01'].down === 1048576, counters['香港 01']);
  check('prom: up 取 out', counters['香港 01'].up === 65536, counters['香港 01']);
  check('prom: 中文节点名', !!counters['香港 01']);
}

/* ---------- 4. node 源差分 ---------- */
{
  const cfg = TM.normalizeConfig(Object.assign({}, TM.DEFAULTS, {
    airports: [{ name: '机场A', match: ['^A-'] }],
  }));
  const ctx = { rules: TM.compileRules(cfg.airports), groupMap: {}, config: cfg };
  const state = TM.emptyState('MacBook');
  const t1 = now(Date.parse('2026-10-25T10:00:00+08:00'));

  let r = TM.deltaFromCounters(state, { 'A-HK-01': { up: 100, down: 900 }, DIRECT: { up: 5, down: 5 } }, ctx, t1);
  check('node: 首轮只建基线', r.baselineOnly === true && Object.keys(r.deltas).length === 0);

  const t2 = now(Date.parse('2026-10-25T10:10:00+08:00'));
  r = TM.deltaFromCounters(state, { 'A-HK-01': { up: 300, down: 1900 }, DIRECT: { up: 7, down: 9 } }, ctx, t2);
  check('node: 增量按机场聚合', r.deltas['机场A'][0] === 200 && r.deltas['机场A'][1] === 1000, r.deltas);
  check('node: DIRECT 被排除', !r.deltas['未分组'], r.deltas);

  const t3 = now(Date.parse('2026-10-25T10:20:00+08:00'));
  r = TM.deltaFromCounters(state, { 'A-HK-01': { up: 10, down: 20 } }, ctx, t3);
  check('node: 引擎重启按新值算', r.deltas['机场A'][0] === 10 && r.deltas['机场A'][1] === 20, r.deltas);
}

/* ---------- 5. 节点 → 机场 映射 ---------- */
{
  const cfg = TM.normalizeConfig(Object.assign({}, TM.DEFAULTS, {
    airports: [{ name: '机场A', match: ['^A-', '香港'] }, { name: '机场B', match: ['^B-'] }],
    airportGroups: ['机场C'],
    autoGroup: true,
  }));
  const ctx = { rules: TM.compileRules(cfg.airports), groupMap: { 'X-01': '机场C', 'Y-01': '节点选择' }, config: cfg };
  check('map: 正则命中', TM.resolveAirport('A-HK-01', ctx) === '机场A');
  check('map: 正则大小写不敏感', TM.resolveAirport('b-jp-01', ctx) === '机场B');
  check('map: 策略组命中', TM.resolveAirport('X-01', ctx) === '机场C');
  check('map: 通用组被排除', TM.resolveAirport('Y-01', ctx) === '未分组');
  check('map: 兜底', TM.resolveAirport('Z-99', ctx) === '未分组');

  const cfg2 = TM.normalizeConfig(Object.assign({}, TM.DEFAULTS, { autoGroup: true }));
  const ctx2 = { rules: [], groupMap: { 'Y-01': '日本组' }, config: cfg2 };
  check('map: autoGroup 生效', TM.resolveAirport('Y-01', ctx2) === '日本组');
  const cfg3 = TM.normalizeConfig(Object.assign({}, TM.DEFAULTS, { autoGroup: false }));
  check('map: autoGroup 关闭时回落', TM.resolveAirport('Y-01', { rules: [], groupMap: { 'Y-01': '日本组' }, config: cfg3 }) === '未分组');

  check('exclude: 精确', TM.isExcluded('DIRECT', cfg) === true);
  check('exclude: 通配', TM.isExcluded('REJECT-TINYGIF', cfg) === true);
  check('exclude: 不误杀', TM.isExcluded('A-HK-01', cfg) === false);
}

/* ---------- 6. 落桶 / 清理 ---------- */
{
  const cfg = TM.normalizeConfig(Object.assign({}, TM.DEFAULTS, { retention: 3, hoursRetention: 2 }));
  const state = TM.emptyState('iPhone');
  const t1 = now(Date.parse('2026-10-25T10:00:00+08:00'));
  const moved = TM.applyDeltas(state, { 机场A: [100, 900] }, t1);
  check('bucket: 返回总增量', moved === 1000, moved);
  check('bucket: 写天', state.days['2026-10-25']['机场A'][1] === 900);
  check('bucket: 写小时', state.hours['2026-10-25T10']['机场A'][0] === 100);
  check('bucket: 写总计', state.totals['机场A'][1] === 900);

  const t2 = now(Date.parse('2026-10-25T11:00:00+08:00'));
  TM.applyDeltas(state, { 机场A: [10, 20] }, t2);
  check('bucket: 同机场累加', state.days['2026-10-25']['机场A'][0] === 110, state.days['2026-10-25']);

  state.days['2026-10-01'] = { 机场A: [1, 1] };
  state.hours['2026-10-24T08'] = { 机场A: [1, 1] };
  TM.prune(state, cfg, t2);
  check('prune: 过期天被删', !state.days['2026-10-01'], Object.keys(state.days));
  check('prune: 今天保留', !!state.days['2026-10-25']);
  check('prune: 小时只留 N 个', Object.keys(state.hours).length === 2, Object.keys(state.hours));
}

/* ---------- 7. base64（JSC 没有 btoa，自己实现） ---------- */
{
  const src = '{"device":"客厅 Mac","note":"机场A ✅"}';
  const enc = TM.base64Encode(src);
  check('base64: 可逆', TM.base64Decode(enc) === src, enc);
  check('base64: 无换行', enc.indexOf('\n') < 0);
  check('base64: ASCII 对照', TM.base64Encode('abc') === 'YWJj', TM.base64Encode('abc'));
  check('base64: 中文长度对齐', TM.base64Encode('中') === '5Lit', TM.base64Encode('中'));
}

/* ---------- 8. 配置解析 ---------- */
{
  const kv = TM.parseKvConfig('repo=me/repo&token=abc123&device=iPhone&interval=5&autoGroup=true&branch=dev');
  check('cfg: kv 解析', kv.repo === 'me/repo' && kv.token === 'abc123', kv);
  check('cfg: kv 数字', kv.interval === 5, kv.interval);
  check('cfg: kv 布尔', kv.autoGroup === true, kv.autoGroup);

  const loose = TM.parseLooseJson('{"device":"Mac","interval":7,"airports":[{"name":"A"}],"token":"t"');
  check('cfg: 截断 JSON 抢救', loose.device === 'Mac' && loose.interval === 7, loose);

  const merged = TM.mergeConfig({ a: 1, b: 2 }, { b: 3, c: '' });
  check('cfg: 合并覆盖', merged.b === 3 && merged.a === 1);
  check('cfg: 空值不覆盖', merged.c === undefined, merged);

  const norm = TM.normalizeConfig({ airports: [{ name: 'A' }, {}, null] });
  check('cfg: 过滤非法机场', norm.airports.length === 1, norm.airports);
}

/* ---------- 9. 文档合并（多设备/重装不丢历史） ---------- */
{
  const local = TM.buildDoc(TM.emptyState('iPhone'));
  local.days = { '2026-10-25': { 机场A: [100, 200] } };
  local.totals = { 机场A: [100, 200] };
  const remote = { days: { '2026-10-25': { 机场A: [50, 900] }, '2026-10-24': { 机场A: [1, 2] } }, totals: { 机场A: [999, 1] } };
  TM.mergeDoc(local, remote);
  check('merge: 同日取大 up', local.days['2026-10-25']['机场A'][0] === 100, local.days['2026-10-25']);
  check('merge: 同日取大 down', local.days['2026-10-25']['机场A'][1] === 900, local.days['2026-10-25']);
  check('merge: 补回缺失日期', !!local.days['2026-10-24']);
  check('merge: 总计取大', local.totals['机场A'][0] === 999);
  check('merge: 空远端安全', TM.mergeDoc(local, null) === local);
}

/* ---------- 10. 文件名 slug ---------- */
{
  check('slug: 中文保留', TM.slug('客厅 Mac') === '客厅-Mac', TM.slug('客厅 Mac'));
  check('slug: 去非法字符', TM.slug('a/b:c*d') === 'a-b-c-d', TM.slug('a/b:c*d'));
  check('slug: 空值兜底', TM.slug('') === 'device');
}

/* ---------- 11. 状态损坏容错 ---------- */
{
  check('state: 坏 JSON 返回空状态', TM.loadState('{oops', 'X').device === 'X');
  check('state: null 返回空状态', Object.keys(TM.loadState(null, 'X').days).length === 0);
  const good = TM.loadState(JSON.stringify({ device: 'iPad', days: { '2026-10-25': { A: [1, 2] } } }), 'X');
  check('state: 正常读取', good.device === 'iPad' && good.days['2026-10-25'].A[1] === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
