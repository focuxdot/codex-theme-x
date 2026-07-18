# codex-theme-x

**发一张图给 Codex，它自己把自己变成这个主题。**

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
$theme-x list / switch / share / restore / doctor
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
```

装了本工具的人把文件拖进对话说"装这个主题"；没装的人把包内 `official.txt` 的
`codex-theme-v1:` 一行粘进 Settings → Appearance → Import，配色直接生效。

## FAQ

**Codex 更新后主题坏了？** `$theme-x doctor` 看诊断，`restore` 永远是安全出口；
颜色走官方系统不受影响。

**支持 Windows 吗？** 先 macOS，Windows 在路线图上。

## 许可

- 非 OpenAI 官方项目。Codex 是其权利人的商标。
- MIT License。
