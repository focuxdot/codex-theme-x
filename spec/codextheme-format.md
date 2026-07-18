# `.codextheme` 主题包格式 v1 / Theme Package Format v1

一个 `.codextheme` 文件是一个普通 zip 包，扁平结构（无子目录）：

```
<id>.codextheme
├── theme.json        # 主题定义（见下）
├── <background>      # 背景图：png / jpg / webp / svg，≤ 16 MB
├── <home-hero>       # 可选，空白会话页横向 Hero，≤ 16 MB
└── official.txt      # 官方 codex-theme-v1 颜色串（可独立使用，见下）
```

## theme.json

```jsonc
{
  "schema": "codextheme/1",          // 必填，固定值
  "id": "aurora-night",              // 必填，[a-z0-9-]，唯一标识
  "name": "Aurora Night",            // 展示名
  "variant": "dark",                 // "dark" | "light"：这套配色为哪种模式设计，
                                     // 决定写入哪张官方主题表；不会切换用户的模式
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

## official.txt

包内附带的官方 `codex-theme-v1:` 颜色串。**没有安装 codex-theme-x 的用户**也可以把这一行粘贴进 Codex 官方设置（Settings → Appearance → Import）直接使用配色部分——主题包对官方生态向下兼容。

## 设计约束

- 颜色必须保证可读性：`ink` 对 `surface` 的对比度 ≥ 7:1（正文），`accent` 对 `surface` ≥ 3:1（UI 元素）。
- **模式跟人，不跟图**：`variant` 只声明配色的目标模式，应用一个主题永远不会
  翻转用户当前的明暗模式（跟随图片切换模式会让整个 UI 在明暗间弹跳）。安装方
  发现 `variant` 与用户当前模式不符时，应为当前模式重新推导配色，而不是切换
  模式；仅在用户明确要求换模式时例外。图片明暗与 `variant` 相抗时，主题必须
  自带补偿：`laneOpacity ≥ 0.55`、`sidebarOpacity ≥ 0.85`，必要时
  `panelOpacity ≥ 0.3` 兜底，否则文字对比度会崩坏。
- 背景图版权必须允许再分发。
- `home.file` 推荐使用横向构图（约 3:1），人物/主体放在右侧，左侧留给原生问候文字。
- `home` 只改变空白会话页；进入任务后仍使用 `background.file` 和原生交互结构。
- **文案跟图与色一样是"生成物"，不是"设置项"**：主题设计者在设计配色的同时
  设计 `copy`（问候语/占位符/窗口标题与画面呼应），用户从不需要为文案多走一步；
  看到后一句话即可微调。`copy` 全部缺省时原生文案不受任何影响，`restore`/切换
  主题时原生文案完整还原。
- 主题包只允许扁平文件名，`background.file` / `home.file` 不允许路径或路径穿越。
