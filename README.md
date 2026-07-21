# codex-theme-x

**一个 Codex 桌面版的主题 skill：发一张图给 Codex，它自己把自己变成这个主题。**

[English](README.en.md) · [主题包格式](spec/codextheme-format.md) · [安装](#安装)

![应用主题后的空白会话页](public/hero.jpg)

## 安装

让 Codex 自己装（零终端）——把这句话发给 Codex：

```
帮我安装 codex-theme-x：https://github.com/focuxdot/codex-theme-x
```

或者自己在终端里装，一行：

```
git clone --depth 1 https://github.com/focuxdot/codex-theme-x /tmp/codex-theme-x && bash /tmp/codex-theme-x/install.sh
```

装完开个**新对话**（skill 在对话开始时扫描），`$theme-x` + 一张图，完事：

```
$theme-x ~/Pictures/miku.jpg     # 一张图 → AI 配色 → 完整主题
$theme-x 赛博朋克雨夜             # 一句话 → 先生图再成主题
$theme-x list / switch / share（导出/分享）/ restore / doctor
```

换主题也是一句话。`$theme-x switch <主题名>`，全程不用重启——同一个应用，两种世界。

**海风晴空**——从空白页到任务页，一套配色贯穿到底：

![海风主题的空白会话页](public/home-sea.jpg)

![海风主题的任务会话页](public/task-sea.jpg)

**换一张水墨**，整个应用跟着换气质——画面全幅呈现，会话文字坐在一条柔边的
"阅读纸带"上，两侧画面不打折：

![水墨主题的空白会话页](public/home-ink.jpg)

![水墨主题的任务会话页](public/task-ink.jpg)

## 你得到的不只是壁纸

- **AI 看图配色**，写入 Codex **官方外观系统**（原生持久，官方更新不影响）
- **默认随明暗模式自动切换**：一张图生成亮/暗两套配色与磨砂，系统或 Codex 切模式时
  整套主题实时跟随，无需重新应用
- **空白页 Hero**：横向主题画卷 + 主题标语，任务页保持原生全幅画面
- **文案层**：问候语、输入框提示、窗口标题与画面同一个声音——截图里的
  「沿着…的林间小径」「听着海风，随心输入」「松风入砚」都来自主题本身；
  功能文字永不改动
- **毛玻璃分区**：侧栏磨砂、会话区全透，密度用嘴调（"侧栏再实一点"，即时生效）
- **一个文件分享**：`.codextheme` 包；没装本工具的人也能用包内的官方颜色串
- **随时退出**：`$theme-x restore` 一句话回到官方原状

## 工作原理

1. **颜色、字体 → 官方外观系统。** 配色写入 `~/.codex/config.toml` 的官方
   `appearance*ChromeTheme` 表（写入前自动备份），重启后原生持久生效。
2. **背景图、Hero、毛玻璃、文案 → 可退化注入。** 通过仅绑定 127.0.0.1 的本机
   调试端口注入。软选择器失配时只退回原生页面，不影响任务页；`$theme-x doctor`
   一键自检。

不修改 `.app`、`app.asar`、不碰代码签名，完全可逆。

## 分享主题

```
$theme-x share            # 导出 <id>.codextheme（一个 zip）
# share / export / 导出 / 分享 均可触发
```

装了本工具的人把文件拖进对话说"装这个主题"；没装的人把包内 `official.txt` 的
`codex-theme-v1:` 一行粘进 Settings → Appearance → Import，配色直接生效。

## 赞助主题（可选）

主题分两类，由 `type` 字段区分：`standard`（默认，普通主题）和 `sponsored`
（广告主题）。广告主题在普通主题之上，把空白页 Hero 卡的三行文案变成**可点击、
跳转到广告主链接**的槽位——点击唤起系统浏览器，可选「Sponsored」披露角标。

- **默认永远是普通主题**：只有显式说「广告/赞助/sponsored」或 `$theme-x sponsor …`
  才会生成广告主题——普通用户完全不受影响。
- **制作对所有人开放**：流程和普通主题一样，只是多提供文案 + 跳转链接。
- **底线**：只在明确标注的槽位、点击才跳，永不自动/悬停跳、整块 Hero 永不作热区
  （与 adware 的分界线）；埋点只在本机、只记曝光/点击计数，绝不采链接内容、屏幕或键值。
  上传默认关闭，且只在三种事件驱动时机发生（缓冲满 10 条 / 正常退出前 / 下次启动补传），
  永不做定时轮询上传。
- **预算耗尽仍可继续使用**：平台在下一次事件上报响应中返回投放状态；主题保留原外观，
  Hero 显示“投放已结束 / 不再产生收益”，并停止新的广告曝光计量和广告跳转。
- **一样能分享**：广告主题包与普通包同一格式，导入无差别。

## FAQ

**Codex 更新后主题坏了？** `$theme-x doctor` 看诊断，`restore` 永远是安全出口；
颜色走官方系统不受影响。

**支持 Windows 吗？** 先 macOS，Windows 在路线图上。

## 许可

- 非 OpenAI 官方项目。Codex 是其权利人的商标。
- MIT License。
