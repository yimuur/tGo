# tGo 赞助资源（不随发布包）

本目录存放管理页「添盏清茶」赞助卡片的远程配置与收款二维码。

## 文件约定

| 文件 | 用途 |
| --- | --- |
| `sponsor.json` | 远程配置（由前端从 GitHub 仓库加载） |
| `wechat_qr/8.png` | 微信 · 请作者尝杯清茶（8 元） |
| `wechat_qr/18.png` | 微信 · 请作者喝壶浓茶（18 元） |
| `alipay_qr/8.png` | 支付宝 · 请作者尝杯清茶（8 元） |
| `alipay_qr/18.png` | 支付宝 · 请作者喝壶浓茶（18 元） |

- 图片建议正方形 PNG（≥ 512×512），单张 ≤ 1MB。
- `sponsor.json` 使用相对路径；前端会按**成功加载配置的源**解析图片地址。
- 替换二维码图片后请递增 `sponsor.json` 的 `version`，用于穿透 jsDelivr/CDN 缓存。
- 默认加载顺序：`https://cdn.jsdelivr.net/gh/yimuur/tGo@main/frontend/sponsor/sponsor.json`
  → `https://raw.githubusercontent.com/yimuur/tGo/main/frontend/sponsor/sponsor.json`。
- `configUrl` / `baseUrl` **不写入** `sponsor.json`：前者是加载配置的自举入口（必须先知道地址才能取 JSON），
  后者由成功加载配置的源目录自动推导——这样 jsDelivr/raw 回退与 fork 镜像都能自然工作。
- fork/私有镜像请确保 `TGO_GITHUB_REPO` 指向的仓库公开可访问，并在其中维护本目录。

## 发布包边界

本目录**不在** `required-files.txt` 清单内，且位于 `frontend/static` 之外，因此不会进入
`tGo-Setup` 发布包或 Docker 镜像；赞助配置与图片始终从远程仓库动态加载。
