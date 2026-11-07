### 🆕 New Features
  * none

### 🛠️ Bug Fixes
  * 为 Loon 模板补上 `/api/v2/weather/` 与 `/api/v3/weather/` 的 http-request 规则：此前仅有 response 规则，上游 dev 插件则有 9 条规则（含这两条请求规则），我们只有 6 条。本次先在 Loon 上补齐，测试缺失的请求规则是否为 NextHour 面板在我们这边不出现、而在上游 dev 出现的原因。request.bundle.js 本身已含 v2/v3 请求处理代码（macOS 补 country 参数），本次不改脚本，只补规则。

### 🔣 Dependencies
  * none

### ‼️ Breaking Changes
  * none

### 🔄 Other Changes
  * mapOverlay（`weather-map2.apple.com/v1/mapOverlay/`）规则本次未加：它管的是 AQ 图层，与 NextHour 面板无关，且需要 MITM 增加 `weather-*.apple.com` 与 request.bundle.js 增加处理代码，属另一项工作。
