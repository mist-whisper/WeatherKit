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

## Fork-only 补充 2（2026-11-04，Node 版本钉住）

- `.github/workflows/build.yml` 把 setup-node 从 `latest` 钉到 `24`（npm 11）。
  原因是 `latest` 现在拉到 npm 12，其 `--allow-remote` 默认是 none，
  `npm install` 会以 EALLOWREMOTE 拒绝 lockfile 里 `@nsnanocat/util` 的
  registry.npmjs.org tarball。8 月上游能过的构建用的是 npm 11 时代的 `latest`。
- 这也是 fork-only 改动，往上游提时要另外定（是钉版本、还是加 `--allow-remote`、
  还是修 lockfile / .npmrc 一致性），不要原样带进上游 PR。
- 注意：改完工作流文件后，直接 Re-run 旧 run 仍用旧工作流文件，
  必须删掉重建 v3.3.3-beta1（或推新 tag）才能测到新工作流。

## 探针 v2（2026-11-04，只记日志、不改数据）

- 仍是透传：不调用 WeatherKit2.decode / encode，不写 `$response.body`，
  包体原样还给天气 App；dump 本身包在 try/catch 里，失败也只记一行错误就透传。
- 在 v1 日志基础上新增：
  - `schema-version(request)` 与 `schema-version(response)` 两边都记。
    v1 只记响应头得到 undefined，是取错了地方：schema 版本在请求头里。
  - `WK3 root: fields=<根表字段数> bodyLength=<包体字节数>`。
  - 每个根槽位一行：`WK3 slot <n>: absent`，或
    `WK3 slot <n>: fields=<子表字段数> strings=[...]`。
    字符串只取子表的直接字符串字段（如 AirQuality 的 scale、Alerts 的
    detailsUrl），每槽最多 3 条、每条截断到 120 字，不递归展开；
    向量长度不通用推断，避免把标量字段误读成向量。
- 预期日志示例（以 2026-11-04 上午包体推断，实测以真机日志为准）：
  slot0 应为 fields=8 且 strings 里有 scale（如 HJ6332012.2604），
  slot9 应为 fields=3 且 strings 里有 alertDetails 链接，
  slot7 应为 fields=4（WeatherChanges，时间戳字段不直接显示为字符串）。
- 本探针不证明 WK3 解码正确，只提供槽位清单，供离线对照 WK2 映射使用。

## 探针 v3（2026-11-04，只记日志、不改数据）

- 仍是透传：不调用 WeatherKit2.decode / encode，不写 `$response.body`；
  每个读数都带越界与合理性校验，失败只跳过该项。
- 在 v2 槽位清单基础上新增：
  - 空根表不再记成 failed：vtable 长度 4 时记 `WK3 root: empty (fields=0)`，
    即中国大陆单项下一小时那种 12 字节空包体。
  - 2 字段包装表：字段1 的向量长度与首元素表字段数（`vec1Len=` /
    `elem0Fields=`），用于区分每日（11 条 / 元素 34 字段）、小时
    （274 条 / 元素 25 字段）、历史对比（2 条 / 元素 5 字段）等。
  - 空气质量 slot0：`aqCategory=` / `aqIndex=`。
  - 当前天气 slot1：单独一行 `WK3 cw:`，含 asOf（字段2 时间戳）、
    humidity（字段8）、pressure（字段23）与候选温度字段 f25 / f26 / f27 /
    f31 / f32 的浮点值；温度字段尚未最终证实，日志里只记数值、不下结论，
    需与界面温度对照。
  - 下一小时 slot5：`WK3 nextHour:`，含 forecastStart / forecastEnd 与
    minutes 向量长度及首元素字段数。
  - 预警 slot9：`WK3 alerts:`，含 alerts 向量长度及首元素字段数。

## 空气质量 scale 原位替换原型（2026-11-04，不做全量解码）

- 只换 slot0 空气质量表的 scale 字符串：原生 `HJ6332012.2604`
  （14 字节）原位覆盖为测试串 `TEST.WK3.00001`（同为 14 字节），
  包体长度与所有偏移不变，其余字节一概不动；任一条件不符就原样返回。
- 适用条件：country 为 CN；根表非空；slot0 存在；子表里找到原生 scale 串。
  非 CN、东京的 EPA scale、空根表一律跳过并记一行 skipped 原因。
- 不调用 WeatherKit2.decode / encode，不重建 FlatBuffer。
- 离线验证（北京包体）：替换后长度不变，14 字节范围内 13 字节变化、
  1 字节恰好相同（均为 `0`），其余全部字节相同；探针 v3 再跑替换后包体，
  只有 slot0 的 scale 字符串一行变化，aqCategory / aqIndex 与其余槽位全不变。

## 空气质量数值原位替换原型（2026-11-04，beta4 教训后的修正）

- beta4 已证实：换 scale 串会让 App 整段丢弃空气质量，因此本版
  scale 串原样不动，只原位改 slot0 的 category（字段1，int8）与
  index（字段2，int16），测试值 category 4 / index 200，
  与原值按 50 一档对应一致，避免两者矛盾。
- 适用条件：country 为 CN；根表非空；slot0 存在且至少 3 字段；
  子表里找到原生 scale 串 HJ6332012.2604；category / index 字段可读。
  任一条件不符就原样返回，不调用 WeatherKit2.decode / encode，不重建。
- 离线验证（北京包体）：长度不变，仅 2 字节变化（category 3→4、
  index 低字节 141→200，高字节 0 不变），scale 串不变；探针 v3 再跑，
  只有 slot0 的 aqCategory / aqIndex 一行变化，其余槽位全不变。
  东京（JP）因 country 门跳过，强制 CN 下因 scale 串不匹配跳过，空根表跳过。
