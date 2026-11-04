# WK3 / iOS 27.3 beta 1 实验分支说明

> 状态：实验探针，不是修复。合并到日常使用的插件前，请先读完本页的“不是什么”。

## 观察到的事实（2026-11-04，真机抓包，已脱敏）

- 系统：iOS 27.3 beta 1，build 24C5037i，WeatherKit_Weather_iOS_Version 27.3。
- 主天气请求已从 `/api/v2/weather/` 变成 `/api/v3/weather/`。
- 响应头：`Content-Type: application/vnd.apple.flatbuffer;messageType=WK3.Weather`，
  `x-schema-version: lib-rc-3.0.0-b66`。
- 请求 `dataSets` 的名字没有变，仍是：
  `airQuality,currentWeather,dataNotice,forecastDaily,forecastHourly,forecastNextHour,forecastPeriodic,news,historicalComparisons,weatherAlerts,weatherChanges`。
- 脱敏后的请求示例（已去掉 Authorization、clientMetadata、x-request-id 等字段）：
  - 北京：`GET https://weatherkit.apple.com/api/v3/weather/zh-Hans-US/39.921/116.443?timezone=Asia/Shanghai&dataSets=airQuality,currentWeather,dataNotice,forecastDaily,forecastHourly,forecastNextHour,forecastPeriodic,news,historicalComparisons,weatherAlerts,weatherChanges&country=CN`
  - 东京：`GET https://weatherkit.apple.com/api/v3/weather/zh-Hans-US/35.775/139.805?timezone=Asia/Tokyo&dataSets=（同上）&country=JP`
- 这两份包体经字串检查是 Apple 原生数据：北京含 `HJ6332012.2604`（和风天气归因），
  东京含 BreezoMeter 归因与 `party=apple` 的预警详情链接；均不含 ColorfulClouds / EU.EAQI 等插件替换痕迹。
- 同一窗口里没有出现 `v1/availability`、`v1/airQualityScale`、`v1/weatherAlerts`，
  也没有第三方上游请求。这只能证明它们在该窗口、那两个城市没有触发，
  不能证明它们在 27.3 下已被改名或删除。
- 底部仍显示彩云 / 和风标识的那次图标请求，来自之前已注入数据的缓存，
  不是当次 v3 包体返回的标识。

## 本分支改了什么

1. `template/loon.handlebars`：在 v2 规则旁并行加了一条 v3 规则，v2 保留不动（向后兼容）。
2. `src/process/Response.mjs`：v3 主请求只做探针——记录 messageType、schema 版本、
   dataSets、country，然后原样透传，**不解码、不重编码、不替换任何数据集**。
3. `src/process/Request.mjs`：v3 主请求沿用 v2 的 macOS country 补齐逻辑（仅在缺 country 时补）。
4. `src/function/parseWeatherKitURL.mjs`：**未改**。它对 availability / weather 的正则
   本来就接受 `v1|v2|v3`，v3 解析不是这里的瓶颈。
5. `tests/wk3-routing.test.mjs`：只做源码层面的路由守卫（v2 规则仍在、v3 规则已加、
   v3 透传探针存在、parse 正则接受 v3），不依赖私有包，也不能证明 WK3 解码正确。

## 本分支不是什么

- 不是 WK3 修复：`src/class/WeatherKit2.mjs` 用的仍是 WK2 时代的
  `@nsringo/weatherkit` 表结构，WK3.Weather 的 root slot 映射尚未拿到，
  直接用 WK2 编解码器去解 WK3 包体是不可靠的，所以本分支刻意不解码。
- 不是可直接安装的插件：模板里的 script-path 仍指向 NSRingo 的 release bundle，
  只有重新构建并发布一个包含本分支源码的 bundle 后，Loon 端的 v3 规则才会真正跑到新代码。
  直接把本分支的模板当插件装，不会立刻恢复下一小时、预警、空气质量替换。
- 不覆盖通知渠道：`severeWeatherNotificationChannels/global` 是 weatherd 的另一套订阅体系，
  本分支没有、也不应在这里顺带改它。那次抓包里该接口的全球列表中没有 `cn`，
  但这只是单次快照，不是“中国大陆通知已被取消”的结论。

## 真机验证方法（只做一次就够，不必重复抓同一城市）

1. 用包含本分支代码构建的 bundle 装插件，LogLevel 设为 DEBUG/ALL，杀掉天气 App 重开。
2. 预期看到的日志：`WK3 weather response passthrough (experiment, not a fix)`，
   以及对应的 messageType / schema 版本 / dataSets / country。
3. 预期看到的界面：天气仍是 Apple 原生（因为透传），下一小时、预警、空气质量
   仍未被替换——这正是探针的预期结果，不是又一次“失效”。
4. 若连这条日志都没有，说明 v3 规则仍未触发，问题在规则 / MITM / 传输层，
   而不是编解码层。

## 下一步（不在本分支里做）

1. 补抓有预警、有降水、空气质量齐全的城市，让 v3 包体里的下一小时、预警、
   空气质量 slot 都是有内容的样本。
2. 补抓新增城市 / 首次打开流程，确认 v3 下 availability / airQualityScale /
   weatherAlerts 是否出现、路径和格式是什么。
3. 拿到 WK3 的 root slot 映射后，复用 flatbuffer-root 的 overlay 思路：
   只重写实际改动的数据集，未改动 slot 保持 opaque，不要全量重编码
   （这是 iOS 27 时 PR #69 已经吃过的亏）。
4. 只有在 1–3 完成、离线 fixture 能通过后，再把 v3 从“透传探针”改成“解码 + 注入”，
   那时才值得另开一个修复 PR。

## 脱敏提醒

不要把原始抓包 zip 原样提交到任何公开仓库或 Issue：它含 weatherkit 的
Authorization 令牌。本页只保留了脱敏后的 URL、响应头名和包体归因字串，
没有复制任何令牌、请求 ID 或 clientMetadata。

## Fork-only 补充（2026-11-04，预发布 v3.3.3-beta1 用）

- 本分支后来又加了一个 fork-only 提交：把 4 个主模板（Loon、Surge、Stash、Quantumult X）
  里的 script-path / script url 从 `github.com/NSRingo/WeatherKit/releases/download/` 改成
  `github.com/mist-whisper/WeatherKit/releases/download/`。不改这一步，fork 打出的 `.lpx`
  仍会去拉上游的旧 bundle，v3 探针跑不起来。
- 这个改动只属于 fork，往上游提 PR 时必须剔除；dev 模板（指向 VirgilClyne 的 gist）
  和 Rewrite 模板（指向 weatherkit.pages.dev）不在此次改动范围内。
- 预发布 tag 为 `v3.3.3-beta1`，触发上游同款 pre-release.yml：构建后把 `dist/*` 作为
  预发布附件发布，不设为 latest。构建仍需 fork 里补好 PACKAGE_TOKEN / SUBMODULE_TOKEN，
  否则 npm install / checkout 会失败。
