<!--
Thanks for contributing! Please complete this template.
感谢贡献！请填完本模板后再提交。

Security / 安全边界: colors via the official appearance system; background via
loopback CDP only. Never patch the official .app / asar; never touch API settings.
颜色走官方外观系统；背景仅经本机回环 CDP。勿改官方安装包；勿碰 API 配置。
-->

## Summary / 摘要

<!-- What changed and why? 1–5 bullets. 改了什么、为什么？ -->

-

## Type / 类型

- [ ] Example theme fix / 示例主题修正（`themes/<id>/`）
- [ ] Bug fix / 缺陷修复
- [ ] Feature / 新功能
- [ ] Docs / 文档

## For theme PRs / 主题类 PR 必填

- [ ] `theme.json` uses `schema: "codextheme/1"` and packs cleanly:
      `node skill/theme-x/scripts/pack.mjs pack --theme themes/<id>`
- [ ] Background artwork license allows redistribution (state it below)
      / 背景图授权允许再分发（在下方注明）
- [ ] `ink`/`surface` contrast ≥ 7:1 for the declared `variant`
      / 声明的 `variant` 模式下对比度达标（应用时模式跟人不跟图）

Artwork license / 背景图授权：

## Checks / 自查

- [ ] `bash install.sh` works from this branch / 本分支安装可用
- [ ] `$theme-x doctor` passes after apply / 应用后自检通过
- [ ] `$theme-x restore` returns to stock / 还原正常
