# `.codextheme` 主题包格式 v1 / Theme Package Format v1

一个 `.codextheme` 文件是一个普通 zip 包，扁平结构（无子目录）：

```
<id>.codextheme
├── theme.json        # 主题定义（见下）
├── <background>      # 背景图：png / jpg / webp / svg，≤ 16 MB
├── <home-hero>       # 可选，空白会话页横向 Hero，≤ 16 MB
├── official.txt      # 官方 codex-theme-v1 颜色串（可独立使用，见下）
└── adsmarket-distribution.json # 可选；平台下载包的公开收益归属（见下）
```

## theme.json

```jsonc
{
  "schema": "codextheme/1",          // 必填，固定值
  "id": "aurora-night",              // 必填，[a-z0-9-]，唯一标识
  "name": "Aurora Night",            // 展示名
  "variant": "auto",                 // "auto"（默认，推荐）| "dark" | "light"。
                                     // auto = 双模式：带 modes.{light,dark} 两套配色，
                                     // 两张官方表都写，跟随用户明暗模式自动切换（详见「主题
                                     // 模式」节）。dark/light = 单模式，只写一张表。
                                     // 任何情况都不切换用户当前的明暗模式
  "type": "standard",               // "standard"（默认）| "sponsored"：主题类型。
                                     // standard = 普通个性化主题；sponsored = 广告主题，
                                     // 必须带 sponsor 块、渲染可点击 Hero 链接。缺省 =
                                     // standard，所有旧主题自动归为普通类型。type 是
                                     // 渲染的权威依据：只有 sponsored 才渲染 sponsor 层，
                                     // 普通主题上的 sponsor 块被忽略（详见下文 sponsor 节）
  "author": "your-name",

  // 走官方外观系统的部分（写入 ~/.codex/config.toml，重启后原生持久生效）
  "official": {
    "accent":  "#2ee6a8",            // 必填，6 位 hex
    "ink":     "#e6edf7",            // 必填，前景/文字色
    "surface": "#10173a",            // 必填，表面/背景色
    "contrast": 60,                  // 0–100
    "opaqueWindows": false,
    "codeThemeId": "one",            // 官方导入暂不接受自定义 id，复用内置 id
    "semanticColors": {              // 语义色（官方字段）
      "diffAdded":   "#2ee6a8",
      "diffRemoved": "#ff6b81",
      "skill":       "#9d8cff"
    },
    "fonts": {}                      // { "ui": "...", "code": "..." } 可选
  },

  // 空白会话页的主题首页（全部可选）
  "home": {
    "file": "home-hero.webp",       // 独立横向 Hero；省略时复用 background.file
    "height": 252,                   // Hero 高度 200–360 px
    "focalPoint": "72% center",     // CSS background-position 的安全子集
    "overlay": 0.88,                 // 文字侧遮罩强度 0–1
    "cardOpacity": 0.88,             // 原生建议卡背景不透明度 0.55–1
    "backdrop": 0.38,                // 空白页轻纱强度 0–1。默认 0.38 + 轻模糊：画面保持
                                     // 可辨识（认得出的场景是氛围，认不出的团块是污渍），
                                     // Hero/卡片/输入框各自带磨砂保读性。避开半遮半掩区
                                     // （约 0.55–0.9）：图片大尺度明暗块任何模糊都抹不掉，
                                     // 会糊成一团。1 = 不透明 surface 画布 + accent 色晕
                                     // （最安静，画面完全退场）
    "backdropBlur": 20,              // 轻纱模糊 px 0–120（backdrop=1 时无效果）
    "kicker": "Aurora Night",       // 问候语上方的主题标识，最多 48 字符
    "tagline": "A quiet horizon for deep work." // 主题标语，最多 96 字符
  },

  // 文案层（全部可选）：只做"氛围文案"，缺省 = 原生文案原样保留。
  // 功能性文字（按钮、导航、建议卡标签、运行状态动词）永不主题化——
  // 那是 UI，不是氛围。
  "copy": {
    "greeting": "在 {project} 的极光下，今晚点亮什么？",
                                     // 空白页问候语模板，≤64 字符。{project} 必须保留，
                                     // 它标记原生项目切换按钮的位置（按钮原样保留、可点）。
                                     // 页面结构不匹配（无项目按钮/应用改版）时自动跳过，
                                     // 显示原生问候语
    "placeholder": "落笔如极光，随心输入",
                                     // 输入框占位符，≤32 字符。原生应用全局同一句
                                     // （"随心输入"），主题版也全局生效。建议保留
                                     // "随心输入"等原生提示词，只加氛围前缀
    "title": "Codex · Aurora Night"  // 窗口标题（cmd-tab / Mission Control），≤48 字符
  },

  // 走注入层的部分（官方做不到的：背景图 + 毛玻璃）
  "background": {
    "file": "background.svg",        // 必填，包内文件名（禁止路径）
    "dim": 0.9,                      // 背景亮度 0–1
    "blur": 0,                       // 背景模糊 px
    "panelOpacity": 0,               // 主面板不透明度 0–1（默认 0 全透明，画面全强度呈现；
                                     // 图面繁密影响阅读时可升到 0.25–0.35 并配 blur 4–8）
    "sidebarOpacity": 0.6,           // 侧栏磨砂密度 0–1（默认 0.6）。侧栏是磨砂玻璃而非
                                     // 平涂色板：画面色彩透过磨砂渗入侧栏（整体统一），
                                     // 磨砂↔清透的材质落差让分区一目了然。浅色界面配
                                     // 深色繁密画面时升到 0.85+ 保读性（密度=可读性旋钮，
                                     // 模糊=统一感旋钮）。注意：无模糊的平涂面板仍然
                                     // 忌讳 0.4–0.7 的中间值（像渲染故障）；磨砂面板则
                                     // 恰恰适合中间密度
    "sidebarBlur": 40,               // 侧栏磨砂模糊 px（0 = 退回旧的平涂色板样式）
    "glassBlur": 18,                 // 毛玻璃 backdrop blur px
    "floatOpacity": 0.75,            // 浮层不透明度 0–1（环境信息/下拉菜单等，
                                     // 文字压在任意内容上，需保留可读面纱）
    "composerOpacity": 0.8,          // 输入框磨砂密度 0–1。官方本身就把输入框设计为
                                     // 半透明磨砂（被 Electron 深色覆盖成了实心板），
                                     // 这里用主题 surface 色找回玻璃意图。打字表面
                                     // 对可读性要求最高，暗色缩放（×0.78）比浮层
                                     // （×0.6）保守，是玻璃家族里底衬最厚的一块
    "laneOpacity": 0.45,             // 阅读纸带密度 0–1：详情页文字栏背后一条纵贯会话、
                                     // 两侧渐隐的 surface 色纸带。文字保持原生渲染不动，
                                     // 纸带在文字底下恢复接近原生的对比条件，栏外画面
                                     // 保持全强度。深色/繁密画面配浅色界面时升到 0.55；
                                     // 0 = 关闭
    "textHalo": 0                    // 传统文字光晕 0–1。默认关闭：改变字体观感会破坏
                                     // 用户原有的阅读习惯，可读性交给 laneOpacity；
                                     // 仅在用户明确要求发光字时开启
  }
}
```

## 主题模式 —— `variant` / `modes`

`variant` 决定这套主题如何应对用户的明暗模式：

| variant | 含义 | 写入的官方表 |
|---|---|---|
| `auto`（默认，推荐） | 双模式：带 `modes.{light,dark}` 两套配色 + 各自磨砂密度 | **两张都写**，跟随用户模式实时切换 |
| `dark` / `light` | 单模式：顶层 `official` + `background` 一套 | 只写对应的那一张 |

**为什么默认 auto**：单模式主题在用户切到另一种模式时，配色落到没被写过的另一张表 →
主题“消失/错位”，且磨砂密度是为原模式调的、换模式后不再匹配。auto 两张表都写、注入层
（`inject.mjs` 的 `syncMode`）在每次明暗翻转时实时切 surface 采样、accent 与
sidebar/lane/dim/panel 密度，因此无需重新应用即可两种模式都好看。

`auto` 的 `modes` 块（`official` 分模式；`background` 顶层放共享的图与各 `*Blur`，
分模式只放需要区分的密度）：

```jsonc
"variant": "auto",
"modes": {
  "light": {
    "official":   { "surface": "#F2EFE7", "ink": "#232527", "accent": "#B13B24", "contrast": 58, "semanticColors": {…} },
    "background": { "panelOpacity": 0, "sidebarOpacity": 0.6,  "dim": 1,    "laneOpacity": 0.45 }
  },
  "dark": {
    "official":   { "surface": "#0D1B2A", "ink": "#F3F9FF", "accent": "#41B6F3", "contrast": 68, "semanticColors": {…} },
    "background": { "panelOpacity": 0, "sidebarOpacity": 0.85, "dim": 0.72, "laneOpacity": 0.62 }
  }
},
"background": { "file": "background.jpg", "sidebarBlur": 40, "glassBlur": 20, "blur": 0 }
```

- **合并规则**：某模式的有效 `background` = 顶层 `background` **合并** `modes.<mode>.background`
  （后者覆盖）；有效 `official` = `modes.<mode>.official`。
- **分模式**：`official` 调色板 + 不随 `veil-scale` 自动缩放的密度（`dim`/`sidebarOpacity`/
  `laneOpacity`/`panelOpacity`）。**共享**：背景图文件、各 `*Blur`、`home`、`copy`、
  `sponsor`、`type`。
- **向下兼容**：无 `modes`、`variant` 为 `dark`/`light` 的旧单模式包行为完全不变。
- **official.txt**：单模式颜色串（给没装工具的人用），auto 默认导出 dark 那套
  （`write-colors export --mode light` 可改）。

## 主题类型 —— `type`

主题分两类，由顶层 `type` 字段声明，在**生成、导入、渲染**三处区分处理：

| type | 含义 | 生成触发 | 渲染 |
|---|---|---|---|
| `standard`（默认） | 普通个性化主题 | 图片/描述即可，无需触发词 | 背景 + 配色 + 文案层 |
| `sponsored` | 广告主题 | 需显式指令/关键词（广告/赞助/sponsored） | 额外渲染可点击 Hero 链接层 |

- **默认与向下兼容**：`type` 缺省 = `standard`。所有已有主题自动归为普通类型，
  行为与 v1 完全一致——大部分普通用户零影响。
- **type 是渲染的权威依据**：`sponsor` 层**只有** `type: "sponsored"` 才渲染。
  普通主题上即使误带 `sponsor` 块也被忽略——普通用户的主题永远不会变成广告。
- **sponsored 的硬校验**：`type: "sponsored"` 但没有可用的 `sponsor` 槽位 →
  加载即失败（拦住空壳广告主题）。
- **导入无差别**：`.codextheme` 包内 `theme.json` 已携带 `type`，解包时识别、
  按类型渲染，广告包与普通包走同一条导入路径（无独立命令）。

## sponsor —— 赞助广告层（type: "sponsored" 时生效）

广告主题在 `theme.json` 顶层附一个 `sponsor` 块，把空白会话页 Hero 卡的三行文案
（kicker / greeting / tagline）变成**可独立点击、跳转到广告主落地页**的链接槽。
仅当 `type: "sponsored"` 时解析并渲染（见上节）。

```jsonc
{
  "schema": "codextheme/1",
  "type": "sponsored",                 // 必须为 sponsored，sponsor 层才会渲染

  "sponsor": {
    "disclosure": "Sponsored",         // kicker 上的披露角标，≤16 字符。平台可强制
                                       // 签发（广告主文案删不掉）；缺省 = 不渲染角标
    "slots": {                         // 三槽位全部可选；只有带合法 url 的槽位可点
      "kicker":   { "text": "ACME AI",              "url": "https://acme.example/" },
      "greeting": { "text": "一个 API，接入所有大模型", "url": "https://acme.example/models" },
      "tagline":  { "text": "免费额度 · 立即体验",      "url": "https://acme.example/start" }
    }
  }
}
```

**槽位映射**（三行文案 = Hero 卡左栏纵向堆叠的三个元素）：

| 槽位 | 位置 | 原生形态（无法挂链接的原因） | 赞助形态 |
|---|---|---|---|
| `kicker` | 顶标签（accent 色小字） | `[data-feature=game-source]::before` 伪元素 | 真实 `<a>`，可选披露角标 |
| `greeting` | 大标题 | game-source 子 `span`（含项目切换按钮） | 真实 `<a>`（原生 span 隐藏） |
| `tagline` | 副标题（muted 小字） | `[data-feature=game-source]::after` 伪元素 | 真实 `<a>` |

渲染器把这三处替换成真实锚点，点击调用渲染进程 `window.open(url,'_blank')` —— 经
Electron `deny + openExternal` 直达系统浏览器（实测见 `research/jump-feasibility.md`），
无需宿主进程或 CDP 桥。

**两条红线（渲染器强制，不随槽位放开而放开）**：

1. **可点的看起来可点**：带 url 的槽位才有链接感（accent 悬停下划线 + 手型；
   tagline 额外带 `↗` 跳转标记），**只在点击触发**，永不自动/悬停跳转，整块 Hero
   永不作热区。这是与 adware 的分界线。
2. **URL 白名单**：`url` 只接受 `http(s)`。`javascript:` / `data:` / `app:` /
   自定义 scheme 一律丢弃——该槽位文案保留但不可点。跳转 URL 应由平台签发，宿主
   跳转前应再向平台校验 campaign 有效性（杜绝过审后改跳）。

**greeting 槽的取舍**：广告主接管大标题时，原本嵌在其中的项目切换按钮被隐藏
（改用输入框上方的 Select project 入口）。是否把 greeting 开放给广告主是平台侧
per-slot 策略开关，改动极便宜（不改客户端、不用户重装）。

## 展现计量与埋点

### adsmarket-distribution.json（可选）

adsMarket 登录用户下载广告主题时，浏览器在基础包中加入：

```json
{
  "v": 1,
  "beneficiaryUserId": "usr_<uuid>",
  "themeId": "acme",
  "source": "gallery",
  "adsApiBase": "https://ads.example"
}
```

`beneficiaryUserId` 是公开的分发收益归属，不是登录 token；转发该主题包后，朋友安装产生的
有效曝光仍归分发者。归属随当前主题包走，不永久绑定 `installId`。`themeId` 必须等于
`theme.json.id`，`adsApiBase` 必须是 http(s) origin，否则加载失败。应用成功后 theme-x 把
平台地址保存到本地上报配置；重新导出主题时保留该文件。

埋点是 **广告主题的属性**：整个计量+上报子系统只在 `type: "sponsored"` 的注入
payload 内运行，**standard 主题零埋点、零 marker、零上报**（无论本地生成还是导入）。
口径对齐 `research/impression-feasibility.md`。

**四类事件**（emit 方 = skill）：

| type | 键 | 触发 | 计费 |
|---|---|---|---|
| `impression` | s,t,type,slot,campaign,theme,beneficiary? | L3 四门全过 → 每个可见会话一次，离屏重入再计 | ✅ 唯一计费 |
| `click` | s,t,type,slot,campaign,theme,beneficiary? | 用户真实点击可链接槽位 | ❌ |
| `active_day` | s,t,type,theme | 广告主题当日首次加载（每日一次，L1 留存） | ❌ |
| `switch_away` | s,t,type,theme | 离开某广告主题（切走/restore/卸载，广告 payload 谢幕时发） | ❌ |

**L3 曝光口径（四门）**：① Hero 在场（`section[home-suggestions]`）② 窗口聚焦
（`document.hasFocus()`）③ 该槽 `IntersectionObserver` ≥50% 可见 ④ 持续 ≥1s。
任一门失配 → 不 emit（**只少计不虚计**）。点击率 `clicks/impressions` 逐槽独立。

**字段白名单（隐私死线）**：事件对象**只允许** `{s,t,type,slot,campaign,theme,beneficiary}`，
多一个键平台整批拒收。`slot`/`campaign`/`beneficiary` 仅 impression/click 携带；
`theme` = 主题 id，`beneficiary` = 包内公开收益归属（存在时）。
**绝不**采集 URL 内容、屏幕内容、键值。

**两段式上报**（页内直连外网被 CSP 拦截，故渲染层只写缓冲，宿主侧读取上传）：

```
渲染进程（注入 payload 内）                    宿主侧（Node，无 CSP 限制）
事件 → localStorage 缓冲（__ctxAdEvents）      ──►  inject.mjs report 读取/上传/删已确认
  单调 seq + 时钟戳 + 匿名 installId，上限 10 条     POST {ADS_API_BASE}/api/ingest
  满则丢新（不覆盖旧未确认）                          （report.lock 排他，三路触发互斥）
满 10 / 正常退出 → __ctxAdFlush 一次性信号  ──►  keeper 探针原子取走 → 恰好一次 report
```

事件信封（`localStorage["__ctxAdEvents"]`，上传 body 即整个信封）：

```jsonc
{
  "v": 1,
  "installId": "<uuid>",               // 匿名安装 ID（RFC 4122 v4），首次生成后持久、跨主题共用
  "seq": 6,                            // 单调高水位；每事件 s 唯一递增 = 平台去重键
  "events": [
    { "s": 1, "t": 1784438053607, "type": "impression",
      "slot": "kicker", "campaign": "cmp-acme-2026q3", "theme": "acme",
      "beneficiary": "usr_<uuid>" },
    { "s": 5, "t": 1784438055000, "type": "active_day", "theme": "acme" }
  ]
}
```

**上传节奏（事件驱动，无定时）**：有且只有三种自动触发，**禁止任何按秒/分/固定周期的上传**：

1. **满 10 立即传**——第 10 条事件落缓冲后，渲染层把一次性信号写进
   `localStorage["__ctxAdFlush"]` 并 `console.log("__CTX_AD_FLUSH__:buffer-full")`；
   resident keeper 的 CDP 探针（`inject.mjs flush-signal`）原子读清该 flag，
   恰好触发一次 `report`。缓冲满后继续来事件：丢新不覆盖旧、并重武装信号
   （前一次 report 失败也有下一次触发），永不靠轮询缓冲长度。
2. **正常退出前尽力传**——`pagehide`/`beforeunload` 时缓冲非空则写
   `normal-exit` 信号；keeper 在 injected→unreachable 边沿抢一次探针
   （进程未死透时 CDP 仍有响应窗口）。崩溃/强退不写信号。
3. **下次启动补传**——keeper（resident 首次 tick；`--oneshot` 兼容模式亦可）在 Codex 启动时
   `report` 一次，清掉上次失败/崩溃/强退留下的持久缓冲。注意：这次上传
   带走**整个当前缓冲**，含本次启动刚写的 `active_day`，不只历史遗留；
   平台按 `(installId, s)` 幂等，重复安全。

上传前先按同一字段协议检查本地事件。历史版本或本地篡改产生的非法事件会先从主缓冲移除，
再 best-effort 写入 `__ctxAdEventsQuarantine`；隔离区只保留 `seq`、原因和隔离时间，
最多 50 条，旧记录也会按这三个字段重建。即使隔离区因容量限制无法写入，坏事件也不会继续阻塞合法事件上传。

成功后**只删本批已确认**（`s ≤ 批次最大 seq`；上传中新增事件 seq 更大故不误删），
合法批次失败则全留、下次触发重试。单批 ≤10 条。三路触发（resident signal bridge、启动补传、
手动 `report`）可能并发，由 `~/.codex/codex-theme-x/report.lock`（`O_EXCL` 创建、
60s stale 回收、失败路径必释放）保证同一时刻只有一个上传。渲染层**永不直连平台**，
信号与上传一一对应——没有 flag 的轮询什么都不做。

平台成功响应会为本批涉及的 Campaign 返回权威状态：

```jsonc
{
  "accepted": 1,
  "eligible": 1,
  "campaignStates": [
    { "campaign": "cmp-acme-2026q3", "status": "exhausted", "earning": false,
      "reason": "budget_exhausted" }
  ]
}
```

宿主在删除已确认事件的同一个渲染事务里，把状态写入
`localStorage["__ctxAdCampaignStates"]`。当前 Campaign 为 `exhausted` 后：保留壁纸、
Hero 文案和整体主题；停止生成该 Campaign 的曝光/点击事件；禁用广告跳转；在 Hero
显示“投放已结束，此主题后续曝光不再产生收益”，并提供返回主题画廊的入口。状态只能
来自平台响应，不能根据客户端事件数或预算自行推断，也不为状态增加定时请求。若应用在
写入响应前退出，事件仍留在缓冲；下次幂等重传会重新得到相同权威状态。

**`ADS_API_BASE`（上报默认关闭）**：端点根由 `ADS_API_BASE` 环境变量、
`~/.codex/codex-theme-x/config.json` 的 `adsApiBase`，或已应用平台包中的 `adsApiBase` 提供。
三者都无则 `report` 空操作、零上传——自制/开源主题永不上报；画廊包应用时自动激活其平台地址。

宿主侧命令：

```bash
node scripts/inject.mjs events                # 按槽位/类型汇总 impressions/clicks/ctr + 留存计数
node scripts/inject.mjs events --clear         # 只清事件、保留 installId+seq（身份跨上传周期稳定）
node scripts/inject.mjs report                 # 读缓冲 → POST /api/ingest → 删已确认（未配置则 no-op）
node scripts/inject.mjs report --json          # 机读上传汇总（含 quarantined 数量）
node scripts/inject.mjs flush-signal           # keeper 专用：原子读清 __ctxAdFlush，非通用 eval
```

## official.txt

包内附带的官方 `codex-theme-v1:` 颜色串。**没有安装 codex-theme-x 的用户**也可以把这一行粘贴进 Codex 官方设置（Settings → Appearance → Import）直接使用配色部分——主题包对官方生态向下兼容。

## 设计约束

- 颜色必须保证可读性：`ink` 对 `surface` 的对比度 ≥ 7:1（正文），`accent` 对 `surface` ≥ 3:1（UI 元素）。
- **模式跟人，不跟图**：应用一个主题永远不会翻转用户当前的明暗模式（跟随图片
  切换模式会让整个 UI 在明暗间弹跳）。默认 `variant: "auto"` 双模式两张表都写、
  两种模式都备好，因此天然匹配、无需适配。单模式包（`dark`/`light`）遇到 `variant`
  与用户当前模式不符时，安装方应为当前模式重新推导配色而不是切换模式；仅在用户
  明确要求换模式时例外。图片明暗与某模式相抗时，该模式必须自带补偿：
  `laneOpacity ≥ 0.55`、`sidebarOpacity ≥ 0.85`，必要时 `panelOpacity ≥ 0.3` 兜底
  （放进该模式的 `modes.<mode>.background`），否则文字对比度会崩坏。
- 背景图版权必须允许再分发。
- `home.file` 推荐使用横向构图（约 3:1），人物/主体放在右侧，左侧留给原生问候文字。
- `home` 只改变空白会话页；进入任务后仍使用 `background.file` 和原生交互结构。
- **文案跟图与色一样是"生成物"，不是"设置项"**：主题设计者在设计配色的同时
  设计 `copy`（问候语/占位符/窗口标题与画面呼应），用户从不需要为文案多走一步；
  看到后一句话即可微调。`copy` 全部缺省时原生文案不受任何影响，`restore`/切换
  主题时原生文案完整还原。
- 主题包只允许扁平文件名，`background.file` / `home.file` 不允许路径或路径穿越。
