# TrafficMeter

代理流量计量模块：**按机场统计用量 → 自动推到 GitHub → GitHub 上出图表和在线面板**。
为 Shadowrocket（小火箭）设计，同时兼容 Surge 等有本地 API 的客户端。

---

## 先说清楚能测到什么

这一点决定了整个方案，别跳过。

**Shadowrocket 没有「按节点累计字节」的接口。** 它不像 Surge 那样能通过 `/v1/metrics` 读到
`surge_policy_in_bytes_out{policy="香港01"}` 这种分节点计数器，脚本里也拿不到本机流量。
所以在小火箭上，**没有任何办法**直接知道「这台手机在这个节点上跑了多少字节」。

小火箭上唯一可靠的流量数字来自另一头 —— **机场自己的账本**：每个机场的订阅链接响应头里有

```
subscription-userinfo: upload=2147483648; download=68257000000; total=536870912000; expire=1798732800
```

这是机场统计的账号已用/总量/到期，跨设备汇总，比任何本地估算都准。本模块就是靠轮询这个头来记账的。

由此得到一个明确的边界：

| 维度 | 能不能测 | 说明 |
| --- | --- | --- |
| 每个机场用了多少 | ✅ 精确 | 机场账单口径，含所有设备 |
| 每天/每小时用了多少 | ✅ 精确 | 相邻两次轮询的差值 |
| 哪个设备用了多少 | ⚠️ 有条件 | 一台设备独占一个机场订阅 → 精确；多设备共用一个账号 → 机场只给账号总量，拆不开，面板标「共享」 |
| 哪个节点用了多少 | ❌ 小火箭做不到 | 换 Surge 等客户端可自动启用节点级采集（见文末） |

如果「设备级精确」是硬需求，两条路：**每台设备用独立机场订阅**，或者**换客户端**。其余场景下，
本模块给出的机场维度数字是完全可信的，设备维度作为参考。

---

## 它怎么跑

```
手机/电脑（小火箭模块，每 10 分钟）
   │
   ├─ 拉 config/meter.json（机场列表 + 订阅链接，缓存 1 小时）
   ├─ 逐个 GET 订阅链接 → 读 subscription-userinfo
   ├─ 和上一轮的累计值做差 → 得到这段区间每个机场的增量
   ├─ 增量累加到 天 / 小时 / 总计
   └─ 攒够上传间隔 → 用 Contents API 写 data/devices/<设备名>.json
                          │
GitHub Actions（收到 push 就跑）                      
   ├─ 聚合 data/devices/*.json（去重：节点实测相加、订阅观测取最大）
   ├─ 生成 docs/data/aggregate.json
   ├─ 重绘 docs/assets/*.svg
   └─ 回写 README 的数据区（表格 + 图表）
```

几个刻意的设计：

- **一台设备一个文件**，设备只写自己那份，多设备并发不会互相覆盖（不需要加锁）。
- **上传前先读远端再合并**，取逐项最大值，所以重装 App / 清数据不会把历史冲掉。
- **首轮只建基线不记账**，否则会把「开机至今」的整段算成一次暴涨。
- **机场周期重置会被识别**（新值比旧值小 → 按新值算），不会算出负数。
- 图表是**提交时生成好的 SVG**，不依赖任何外部图表服务，GitHub 直接渲染，私有库也能用。

---

## 快速开始

### 1. 建仓库，放模板

新建一个仓库（建议**私有**，里面会存订阅链接），把本目录 `traffic-meter-repo/` 里的内容原样推上去：

```
config/meter.json           ← 机场列表 + 订阅链接 + 配额
data/devices/               ← 设备数据，空的
scripts/aggregate.mjs       ← 聚合 + 绘图
docs/index.html             ← 在线面板
.github/workflows/traffic.yml
README.md
```

### 2. 填 config/meter.json

```json
{
  "timezone": "Asia/Shanghai",
  "resetDay": 1,
  "airports": [
    {
      "name": "机场A",
      "sub": "https://sub.example-a.com/api/v1/client/subscribe?token=xxx",
      "quotaGB": 500,
      "color": "#e5484d"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 面板上显示的名字，随便起 |
| `sub` | 机场给你的订阅地址，脚本靠它读 `subscription-userinfo` |
| `quotaGB` | 套餐总量（GB）。机场的 `total` 字段有值时以机场为准，这里作兜底 |
| `color` | 图表颜色，可省 |
| `resetDay` | 每月几号重置流量，用于算「本周期」，默认 1 |
| `timezone` | 统计时区，默认 `Asia/Shanghai` |
| `interval` / `pollInterval` | 上传间隔 / 订阅轮询间隔（分钟），默认 10 |

> 订阅链接是敏感信息。仓库设为私有，令牌只给这一个仓库。

### 3. 建 GitHub 令牌

Settings → Developer settings → **Fine-grained tokens** → Generate new token：

- **Repository access**：Only select repositories → 只选这一个仓库
- **Permissions**：Contents → **Read and write**（其余全部 No access）
- **Expiration**：设个 90 天，到期换新的

拿到的 `github_pat_...` 待会儿填进模块。

### 4. 装模块

1. 把 `TrafficMeter.js` 和 `TrafficMeter.module` 放到同一目录（或把 `.js` 推到自己的仓库，模块里用 raw 链接）。
2. 小火箭 → 配置 → 模块 → 添加模块 → 选 `TrafficMeter.module`。
3. 编辑模块里的 `argument`，改三处：

```
argument=repo=你的用户名/仓库名&token=github_pat_xxx&device=iPhone&branch=main
```

- `device` 每台设备**必须不同**（`iPhone` / `MacBook` / `iPad`），撞名会写到同一个文件里。
- `branch` 默认 `main`，仓库主分支叫 `master` 的话改掉。

4. 等 10 分钟，仓库里出现 `data/devices/iPhone.json` 就成了；README 也会被 Actions 自动填上数据。

### 5. （可选）开在线面板

Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`、目录 `/docs`。
之后访问 `https://<用户名>.github.io/<仓库名>/`，页面每 30 秒自动拉一次数据，比 README 及时。

---

## 参数

模块 `argument` 支持的键（`key=value` 用 `&` 连接）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `repo` | 空 | `owner/repo`，留空则只本地统计不上报 |
| `token` | 空 | GitHub PAT |
| `device` | 设备型号 | 设备名，**必须唯一** |
| `branch` | `main` | 分支 |
| `dir` | `data/devices` | 设备文件目录 |
| `interval` | 10 | 上传间隔（分钟） |
| `pollInterval` | 10 | 订阅轮询间隔（分钟），被机场限流时调大 |
| `retention` | 120 | 保留天数 |
| `debug` | false | 在脚本日志里输出每轮增量与上传结果 |

`config/meter.json` 里还能配 `excludePolicies` / `excludeGroups` / `autoGroup` / `fallback`，
这些只在节点级采集（Surge 系）时生效。

> 配置优先级：`$persistentStore['TrafficMeter.config']` > `config/meter.json` > `argument` 里的同名键 > 内置默认值。
> 想让配置立刻生效，把 `$persistentStore` 里的 `TrafficMeter.configCache` 删掉即可。

---

## 排障

| 现象 | 排查 |
| --- | --- |
| 仓库里一直没文件 | 模块没启用 / 令牌没写权限（Contents 必须是 Read and write）/ `device` 撞名 |
| 面板一直「还没有数据」 | Actions 没跑起来：仓库 Settings → Actions 是否允许；或 push 路径不是 `data/devices/**` |
| 机场那栏是空的 | `config/meter.json` 里没配这个机场，或 `sub` 链接失效（浏览器里直接打开订阅链接，看响应头有没有 `subscription-userinfo`） |
| 数字不涨 | 机场限流了订阅拉取。把 `pollInterval` 调到 30；部分机场要求 UA 与客户端一致 |
| 只涨一次就停 | 小火箭没执行 cron。把模块里那行换成注释掉的 `http-request` 触发版本 |
| `argument` 好像没生效 | 有些版本对 `argument` 支持不完整：直接把 `repo`/`token`/`device` 写进 `TrafficMeter.js` 顶部的 `TM_DEFAULTS`，然后用自己仓库的 raw 链接加载脚本 |
| 设备全标「共享」 | 多台设备配了同一个机场订阅。这是账号级的物理限制，见下一节 |

调试开关：`argument` 里加 `&debug=true`，小火箭的脚本日志会输出
`[TrafficMeter] uploaded +1234B, airports=机场A,机场B`。

---

## 想要设备级精确

**方案一：一台设备一个订阅。** 很多机场支持开子账号 / 多订阅。给每台设备配不同的订阅链接，
矩阵里就会各自显示真实数字，`shared` 标记消失。这是最省事的做法。

**方案二：换客户端。** Surge（Mac 6.9.0+ / iOS 5.22.0+）有 `/v1/metrics`，提供分策略累计字节。
同一个脚本会自动识别 `$httpAPI` 并切到节点级采集：读 `surge_policy_in/out_bytes_total{policy}`，
按节点名或策略组映射到机场，**每台设备各测各的，相加即总量**，精确到设备。
只需要在 `config/meter.json` 的机场里加 `match`（节点名前缀正则）：

```json
{ "name": "机场A", "match": ["^A-", "^香港"] }
```

节点级模式下 `sub` 不参与（同一台设备两条源指向同一份流量，混算会翻倍），配额用 `quotaGB` 兜底。
面板和聚合脚本一行都不用改 —— 它只认 `source` 字段。

---

## 文件清单

| 文件 | 作用 |
| --- | --- |
| `TrafficMeter.module` | 小火箭模块，声明 cron 脚本与参数 |
| `TrafficMeter.js` | 采集 + 差分 + 上传，双源（订阅头 / 节点计数） |
| `TrafficMeter.test.js` | 自测，`node TrafficMeter.test.js`，62 项用例 |
| `traffic-meter-repo/` | 推到 GitHub 的仓库模板（Actions + 聚合脚本 + 面板） |
| `traffic-meter-preview/` | 用样例数据跑出来的面板截图版，看效果用，可删 |

## 数据格式

`data/devices/<设备名>.json`：

```json
{
  "schema": 1,
  "device": "iPhone",
  "source": "sub",
  "updatedAt": 1792901007749,
  "airports": {
    "机场A": { "up": 2254857830, "down": 68075231641, "total": 536870912000, "expire": 1798732800, "at": 1792901007 }
  },
  "totals": { "机场A": [2254857830, 68075231641] },
  "days": { "2026-10-25": { "机场A": [2254857830, 68075231641] } },
  "hours": { "2026-10-25T12": { "机场A": [1048576, 9437184] } }
}
```

- `airports`：订阅口径的**累计快照**（机场账单），用于配额进度和到期日。
- `totals` / `days` / `hours`：**增量累加**，单位字节，`[上传, 下载]`。
- `source`：`sub` = 订阅观测，`node` = 本机节点实测。聚合脚本按这个决定「相加」还是「取最大」。
