import { Console, Storage } from "@nsnanocat/util";
import * as flatbuffers from "flatbuffers";
import AirQuality from "../class/AirQuality.mjs";
import ColorfulClouds from "../class/ColorfulClouds.mjs";
import QWeather from "../class/QWeather.mjs";
import WAQI from "../class/WAQI.mjs";
import Weather from "../class/Weather.mjs";
import WeatherAlerts from "../class/WeatherAlerts.mjs";
import WeatherKit2 from "../class/WeatherKit2.mjs";
import database from "../function/database.mjs";
import mergeWeatherKitAvailability from "../function/mergeWeatherKitAvailability.mjs";
import parseWeatherKitURL from "../function/parseWeatherKitURL.mjs";
import providerNameToLogo from "../function/providerNameToLogo.mjs";
import setENV from "../function/setENV.mjs";
/***************** Processing *****************/
export async function Response($request, $response) {
    // 解构URL
    const url = new URL($request.url);
    Console.info(`url: ${url.toJSON()}`);
    // 获取连接参数
    const PATHs = url.pathname.split("/").filter(Boolean);
    Console.info(`PATHs: ${PATHs}`);
    // 解析格式
    const FORMAT = ($response.headers?.["Content-Type"] ?? $response.headers?.["content-type"])?.split(";")?.[0];
    Console.info(`FORMAT: ${FORMAT}`);
    /**
     * 设置
     * @type {{Settings: import('../types').Settings}}
     */
    const { Settings, Caches, Configs } = setENV("iRingo", "WeatherKit", database);
    Console.logLevel = Settings.LogLevel;
    // 创建空数据
    let body = {};
    // 格式判断
    switch (FORMAT) {
        case undefined: // 视为无body
            break;
        case "application/x-www-form-urlencoded":
        case "text/plain":
        default:
            break;
        case "application/x-mpegURL":
        case "application/x-mpegurl":
        case "application/vnd.apple.mpegurl":
        case "audio/mpegurl":
            break;
        case "text/xml":
        case "text/html":
        case "text/plist":
        case "application/xml":
        case "application/plist":
        case "application/x-plist":
            break;
        case "text/vtt":
        case "application/vtt":
            break;
        case "text/json":
        case "application/json":
            body = JSON.parse($response.body);
            switch (url.hostname) {
                case "weatherkit.apple.com":
                    // 路径判断
                    switch (url.pathname) {
                        default:
                            if (url.pathname.startsWith("/api/v1/availability/")) {
                                body = mergeWeatherKitAvailability(body, Configs?.Availability?.v2);
                            }
                            break;
                    }
                    break;
            }
            $response.body = JSON.stringify(body);
            break;
        case "application/vnd.apple.flatbuffer":
        case "application/protobuf":
        case "application/x-protobuf":
        case "application/vnd.google.protobuf":
        case "application/grpc":
        case "application/grpc+proto":
        case "application/octet-stream": {
            let rawBody = $response.bodyBytes ? new Uint8Array($response.bodyBytes) : ($response.body ?? new Uint8Array());
            switch (FORMAT) {
                case "application/vnd.apple.flatbuffer": {
                    // 解析FlatBuffer
                    const ByteBuffer = new flatbuffers.ByteBuffer(rawBody);
                    // 主机判断
                    switch (url.hostname) {
                        case "weatherkit.apple.com":
                            // 路径判断
                            // WK3 实验（iOS 27.3 beta 1）：探针 v3 + 当前天气真实温度原位替换。
                            // WK3 的 FlatBuffer schema 尚未完整映射，WK2 编解码器不能直接用于 WK3.Weather，
                            // 所以不做全量解码/重编码。本版不再写死 25.00：按插件 Settings 的
                            // Weather.Provider（默认 ColorfulClouds）实时查第三方当前天气，
                            // 只原位改 slot1 的温度（字段25）、体感（字段26）与露点（字段27），
                            // 其余所有字节原封不动；第三方查不到、字段不符、country 不在 Replace
                            // 列表里，一律原样返回。空气质量本版不动。
                            // 完整修复需要先拿到 WK3 的 root slot 映射，见 docs/wk3-ios27.3-experiment.md。
                            if (url.pathname.startsWith("/api/v3/weather/")) {
                                const parameters = parseWeatherKitURL(url);
                                const slotLines = dumpWK3Root(ByteBuffer, rawBody.length);
                                let providerCurrentWeather = null;
                                if (Settings?.Weather?.Replace?.includes(parameters.country)) {
                                    const providerParameters = { ...parameters };
                                    switch (Settings?.Weather?.Provider) {
                                        case "QWeather": {
                                            const qWeather = new QWeather(providerParameters, Settings?.API?.QWeather?.Token || "bdd98ec1d87747f3a2e8b1741a5af796", Settings?.API?.QWeather?.Host);
                                            providerCurrentWeather = await qWeather.WeatherNow();
                                            break;
                                        }
                                        case "ColorfulClouds": {
                                            const colorfulClouds = new ColorfulClouds(providerParameters, Settings?.API?.ColorfulClouds?.Token || "Y2FpeXVuX25vdGlmeQ==");
                                            providerCurrentWeather = await colorfulClouds.CurrentWeather();
                                            break;
                                        }
                                        default:
                                            break;
                                    }
                                }
                                // AQ 全套（跟随设置）：用原污染物按设置的算法算指数，一起换
                                // category / index / 主污染物 / scale 串；v3.4.1-beta6
                                // 起四条合做：污染物空了按 Pollutants.Provider 补填、
                                // 指数按 Index.Provider 直取（和风/彩云美标/彩云国标/
                                // WAQI，默认仍为内置 Calculate）、昨日对比接和风与
                                // 内置算法；付费/令牌路径只留设置接口（上游同款），
                                // 不在代码里另行写死。和风与 WAQI 的实例在
                                // calculateWK3AQ 内按需建。昨日对比在原值 UNKNOWN
                                // （或 ReplaceWhenCurrentChange）时按 v2 逻辑重算，
                                // 元数据拼接 providerName；对比或元数据任一失败只
                                // 退回原值，不影响指数替换与 CW。国家门跟
                                // Weather.Replace，scale 门跟
                                // AirQuality.Current.Index.Replace。
                                let aqEnv = null;
                                if (Settings?.Weather?.Replace?.includes(parameters.country)) {
                                    aqEnv = {
                                        parameters,
                                        caches: Caches,
                                        colorfulClouds: new ColorfulClouds({ ...parameters }, Settings?.API?.ColorfulClouds?.Token || "Y2FpeXVuX25vdGlmeQ=="),
                                    };
                                }
                                const aqReplace = await calculateWK3AQ(ByteBuffer, rawBody, parameters.country, Settings, aqEnv);
                                let workingBody = rawBody;
                                let workingByteBuffer = ByteBuffer;
                                if (aqReplace.body) {
                                    workingBody = aqReplace.body;
                                    workingByteBuffer = new flatbuffers.ByteBuffer(workingBody);
                                }
                                const cwReplace = replaceWK3CWTemperature(workingByteBuffer, workingBody, parameters.country, Settings?.Weather?.Provider, providerCurrentWeather);
                                if (cwReplace.body) {
                                    workingBody = cwReplace.body;
                                    workingByteBuffer = new flatbuffers.ByteBuffer(workingBody);
                                }
                                // 预警补充（WK3 beta7）：只改现有槽 9 的预警元素，
                                // 不新建元素、不动元数据/detailsUrl；provider 默认
                                // QWeatherWeb（和风详情页）；失败一律原样返回。
                                const alertsReplace = await supplementWK3Alerts(workingByteBuffer, workingBody, parameters, Settings);
                                if (alertsReplace.body) {
                                    workingBody = alertsReplace.body;
                                    workingByteBuffer = new flatbuffers.ByteBuffer(workingBody);
                                }
                                // 每日高低温（WK3 v3.4.1-beta1/beta2）：原位改槽 2
                                // 每日元素的日级最高温（字段23）与最低温（字段25），
                                // beta2 起同时改昼夜子表（白天/夜间，字段14/15），
                                // 因十日 UI 读子表而非日级字段；provider 仅彩云
                                // （ColorfulClouds.Daily），按 forecastStart 对日匹配，
                                // 彩云从当日开始供数，苹果向量含昨日，故昨日无匹配
                                // 时留原值；失败一律原样返回。
                                const dailyReplace = await replaceWK3DailyHighLow(workingByteBuffer, workingBody, parameters, Settings);
                                if (dailyReplace.body) {
                                    workingBody = dailyReplace.body;
                                    workingByteBuffer = new flatbuffers.ByteBuffer(workingBody);
                                }
                                // 逐小时温度（WK3 v3.4.1-beta3）：只原位改槽 3 小时
                                // 元素的温度（字段17）一个 float32，不动其他字段；
                                // provider 仅彩云（ColorfulClouds.ForecastHourly），
                                // 按 forecastStart 对时匹配，过去小时无匹配时留原值；
                                // 失败一律原样返回。
                                const hourlyReplace = await replaceWK3HourlyTemperature(workingByteBuffer, workingBody, parameters, Settings);
                                if (hourlyReplace.body) {
                                    workingBody = hourlyReplace.body;
                                    workingByteBuffer = new flatbuffers.ByteBuffer(workingBody);
                                }
                                // 未来一小时填空（WK3）：beta6 已证实，任何新建槽 5
                                // 的体（填空/最小/窗口-only/东京原表移植）都会被 App
                                // 整包丢弃（槽位存在本身即缺陷），故 beta7 起停用
                                // 移植，槽 5 保持原样缺席，以免遮住预警补充的结果。
                                // transplantWK3NextHour 与 fillWK3NextHour 保留在文件
                                // 里备查，本 beta 不调用。
                                const nhDefaultLog = "WK3 nh: skipped (transplant parked, slot-presence defect)";
                                let nhReplace = { body: null, log: nhDefaultLog };
                                rawBody = workingBody;
                                Console.warn(
                                    "WK3 weather response (experiment, not a fix) [cwReplace: CW real provider temperature, all other bytes unchanged, fail -> original]",
                                    `messageType: ${$response.headers?.["Content-Type"] ?? $response.headers?.["content-type"]}`,
                                    // v1 探针读响应头得到 undefined 是取错了地方：schema 版本在请求头里，
                                    // 响应头里没有这个字段，所以 v2 两边都记，互相对照。
                                    `schema-version(response): ${$response.headers?.["x-schema-version"] ?? $response.headers?.["X-Schema-Version"]}`,
                                    `schema-version(request): ${$request.headers?.["x-schema-version"] ?? $request.headers?.["X-Schema-Version"]}`,
                                    `dataSets: ${parameters.dataSets.join(",")}`,
                                    `country: ${parameters.country}`,
                                    ...slotLines,
                                    aqReplace.log,
                                    cwReplace.log,
                                    alertsReplace.log,
                                    dailyReplace.log,
                                    hourlyReplace.log,
                                    nhReplace.log,
                                );
                                break;
                            }
                            if (url.pathname.startsWith("/api/v2/weather/")) {
                                const parameters = parseWeatherKitURL(url);
                                const dataSets = parameters.dataSets.filter(dataSet => Settings.DataSets.includes(dataSet));
                                const rootNames = dataSets.map(dataSet => Configs.DataSets[dataSet] ?? dataSet);
                                body = WeatherKit2.decode(ByteBuffer, rootNames);
                                const providerParameters = { ...parameters, weatherKitLanguage: body.weatherAlerts?.metadata?.language };
                                const enviroments = {
                                    colorfulClouds: new ColorfulClouds(providerParameters, Settings?.API?.ColorfulClouds?.Token || "Y2FpeXVuX25vdGlmeQ=="),
                                    qWeather: new QWeather(providerParameters, Settings?.API?.QWeather?.Token || "bdd98ec1d87747f3a2e8b1741a5af796", Settings?.API?.QWeather?.Host),
                                    waqi: new WAQI(parameters, Settings?.API?.WAQI?.Token),
                                    country: parameters.country,
                                };

                                await Promise.all(
                                    dataSets.map(async dataSet => {
                                        switch (dataSet) {
                                            case "airQuality": {
                                                body.airQuality = await InjectAirQuality(body.airQuality, Settings, Caches, enviroments);
                                                break;
                                            }
                                            case "currentWeather": {
                                                body.currentWeather = await InjectCurrentWeather(body.currentWeather, Settings, enviroments);
                                                break;
                                            }
                                            case "forecastDaily": {
                                                body.forecastDaily = await InjectForecastDaily(body.forecastDaily, Settings, enviroments);
                                                break;
                                            }
                                            case "forecastHourly": {
                                                body.forecastHourly = await InjectForecastHourly(body.forecastHourly, Settings, enviroments);
                                                break;
                                            }
                                            case "forecastNextHour": {
                                                body.forecastNextHour = await InjectForecastNextHour(body.forecastNextHour, Settings, enviroments);
                                                break;
                                            }
                                            case "weatherAlerts": {
                                                body.weatherAlerts = await InjectWeatherAlerts(body.weatherAlerts, Settings, enviroments);
                                                break;
                                            }
                                            default:
                                                break;
                                        }
                                    }),
                                );
                                rawBody = WeatherKit2.encode(ByteBuffer, body);
                                break;
                            }
                            break;
                    }
                    break;
                }
                case "application/protobuf":
                case "application/x-protobuf":
                case "application/vnd.google.protobuf":
                    break;
                case "application/grpc":
                case "application/grpc+proto":
                    break;
                case "application/octet-stream":
                    break;
            }
            // 写入二进制数据
            $response.body = rawBody;
            break;
        }
    }
    return $response;
}

/**
 * WK3 当前天气真实温度原位替换：只改 slot1 的温度 / 体感 / 露点三个浮点字段。
 * 字段身份已由四例露点公式证实：字段25 = 温度、字段27 = 露点、字段8 = 湿度、
 * 字段26 与温度接近、位于体感位置。
 * providerCurrentWeather 是第三方当前天气对象（QWeather.WeatherNow 或
 * ColorfulClouds.CurrentWeather 的返回值），取其 temperature / temperatureApparent /
 * temperatureDewPoint；ColorfulClouds 不给露点时，按 Magnus 公式以新温度与原湿度重算。
 * 适用条件全部满足才换，否则原样返回（body 为 null）：
 * - country 在调用方已确认的 Replace 列表语义下（本函数内仍以 country 为 CN
 *   作最后一道门，避免非 CN 对照城市被误改）；
 * - 根表非空，slot1 子表存在且至少 28 个字段；
 * - 湿度（字段8，int8）、温度（字段25，float32）、体感（字段26，float32）、
 *   露点（字段27，float32）均可读且湿度在 0-100 之间；
 * - 第三方温度与体感均为有限数。
 * 原位覆盖不改变包体长度与任何偏移。不调用 WeatherKit2.decode / encode，
 * 不重建 FlatBuffer，不改任何其他槽位。
 * @param {import("flatbuffers").ByteBuffer} ByteBuffer - 已按 rawBody 建好的 ByteBuffer
 * @param {Uint8Array} rawBody - 原始包体（不原地修改，成功时返回新拷贝）
 * @param {string} country - 请求的 country 参数
 * @param {string} providerName - 插件 Settings 的 Weather.Provider
 * @param {any} providerCurrentWeather - 第三方当前天气对象，未查到时为 null
 * @returns {{body: Uint8Array | null, log: string}}
 */
/**
 * WK3 根表 overlay（AQ 第一步，测试值）：把 AQ 表换成一张新表，其余槽位
 * 按原始字节保留，不需要先认清未知槽位的内部 schema（PR #69 的
 * copy-on-write 思路，离线已在北京、东京两体上验证通过）。
 * 新包体布局：[新根表 uoffset][新根表 vtable][新根表][新 AQ vtable]
 * [新 AQ 表][新 scale 串（若变）][新污染物 vtable + 各污染物表 + 新向量
 * （若传 options.pollutants 且校验通过，否则向量仍指向 blob）]
 * [原始包体 verbatim（8 字节对齐的 opaque blob）]。
 * 新根表除 slot0 外的每个字段都重算指向 blob 内的原表；新 AQ 表的
 * 3 个偏移字段（元数据、污染物向量、scale 串）也重算指向 blob，
 * 首要污染物字段经表字节核实为 1 字节枚举、不是偏移，绝不重算。
 * AQ 内部字段身份沿用 WK2（字段1 category int8、字段2 index int16、
 * 字段7 scale 字符串），且要求 scale 串为 HJ6332012.2604 才换；
 * 任一校验失败都原样返回（body 为 null），绝不输出半成品包体。
 * 自检：用新包体重建 ByteBuffer，核对根表字段数、slot0 的
 * category / index / scale、以及原有在场槽位仍在场，任一不符
 * 即放弃 overlay、原样返回。
 * @param {import("flatbuffers").ByteBuffer} ByteBuffer - 已按 rawBody 建好的 ByteBuffer
 * @param {Uint8Array} rawBody - 原始包体
 * @param {string} country - 请求的 country 参数
 * @param {number} newCategory - 测试用 category（beta5 同款 4）
 * @param {number} newIndex - 测试用 index（beta5 同款 200）
 * @returns {{body: Uint8Array | null, log: string}}
 */
/**
 * WK3 AQ 全套（跟随设置）：用原污染物按设置的算法算指数，一起换 category /
 * index / 主污染物 / scale 串，并重建污染物向量（换算过的量与单位写回，
 * 没换算的保留原量与原单位字节），昨日对比保持原值，污染物空了不补
 * （先只做污染物本来就有的城市），元数据保持原样。
 * 门全部跟随设置，不再写死：国家门跟 Settings.Weather.Replace
 * （默认 ["CN"]），scale 门跟 Settings.AirQuality.Current.Index.Replace
 * （默认 ["HJ6332012"]），算法跟 Settings.AirQuality.Calculate.Algorithm
 * （缺省时默认 EU_EAQI，与 beta8 一致）；算法为 None 时不换。
 * 解码沿用 WK2 的 AQ / 污染物字段顺序（已在北京、东京两体上核对：
 * AQ 字段1 category、字段2 index、字段7 scale；污染物字段0 类型、
 * 字段1 浓度、字段2 单位）。注意：不跑 FixPollutantsUnits，因为
 * 苹果原污染物已是 WeatherKit 单位，Fix 只针对插件自己注入的
 * 和风污染物；对原数据跑 Fix 会把 CO 从 µg 误当 mg 再乘 1000。
 * 单位字节 2 的映射是推断（未实证）：WK2 里它叫 UNKNOWN2，但
 * 原污染物浓度本身已是 µg 量级（CO 220、PM2.5 38 等），且欧标
 * 全是 µg 目标时按原量算结果正确；此处把它当作微克喂给计算，
 * 这样美标气体才能从微克正确换算成 ppb；若该推断错，美标气体
 * 指数会系统性偏离，需装机对照验证。污染物向量重建规则：换算
 * 后量或单位变了的，写换算值；量与单位串都没变的（无分段表的
 * 污染物、换算失败、µg→µg 恒等换算），一律保留原量与原单位字节，
 * 避免把原字节 2 误写成 µg 枚举。
 * 任一校验失败都原样返回。
 * @param {import("flatbuffers").ByteBuffer} ByteBuffer - 已按 rawBody 建好的 ByteBuffer
 * @param {Uint8Array} rawBody - 原始包体
 * @param {string} country - 请求的 country 参数
 * @param {any} Settings - 插件 Settings
 * @returns {{body: Uint8Array | null, log: string}}
 */
async function calculateWK3AQ(ByteBuffer, rawBody, country, Settings, aqEnv = null) {
    try {
        const replaceCountries = Settings?.Weather?.Replace ?? ["CN"];
        if (!replaceCountries.includes(country)) return { body: null, log: `WK3 aq: skipped (country ${country} not in Weather.Replace)` };
        // 和风与 WAQI 实例按需建（只在选到相关 provider 时才建，
        // 避免每次请求都多打日志）；token 一律走 Settings 接口。
        const colorfulClouds = aqEnv?.colorfulClouds ?? null;
        const getQWeather = () => {
            if (!aqEnv) return null;
            if (!aqEnv.qWeather) aqEnv.qWeather = new QWeather({ ...aqEnv.parameters }, Settings?.API?.QWeather?.Token || "bdd98ec1d87747f3a2e8b1741a5af796", Settings?.API?.QWeather?.Host);
            return aqEnv.qWeather;
        };
        const getWAQI = () => {
            if (!aqEnv) return null;
            if (!aqEnv.waqi) aqEnv.waqi = new WAQI(aqEnv.parameters, Settings?.API?.WAQI?.Token);
            return aqEnv.waqi;
        };
        const algorithm = Settings?.AirQuality?.Calculate?.Algorithm ?? "EU_EAQI";
        if (algorithm === "None") return { body: null, log: "WK3 aq: skipped (algorithm None)" };
        const rootPos = ByteBuffer.readInt32(ByteBuffer.position()) + ByteBuffer.position();
        if (rootPos < 0 || rootPos + 4 > rawBody.length) return { body: null, log: "WK3 aq: skipped (root out of range)" };
        const rootVtablePos = rootPos - ByteBuffer.readInt32(rootPos);
        const rootFieldCount = Math.floor((ByteBuffer.readUint16(rootVtablePos) - 4) / 2);
        if (rootFieldCount !== 15) return { body: null, log: `WK3 aq: skipped (unexpected root fields=${rootFieldCount})` };
        const slot0Offset = ByteBuffer.__offset(rootPos, 4);
        if (!slot0Offset) return { body: null, log: "WK3 aq: skipped (slot 0 absent)" };
        const aqPos = ByteBuffer.__indirect(rootPos + slot0Offset);
        const aqMetaOffset = ByteBuffer.__offset(aqPos, 4);
        const aqCategoryOffset = ByteBuffer.__offset(aqPos, 6);
        const aqIndexOffset = ByteBuffer.__offset(aqPos, 8);
        const aqPollutantsOffset = ByteBuffer.__offset(aqPos, 12);
        const aqScaleOffset = ByteBuffer.__offset(aqPos, 18);
        if (!aqMetaOffset || !aqCategoryOffset || !aqIndexOffset || !aqPollutantsOffset || !aqScaleOffset) {
            return { body: null, log: "WK3 aq: skipped (AQ field absent)" };
        }
        const oldScale = ByteBuffer.__string(aqPos + aqScaleOffset);
        const replaceScales = Settings?.AirQuality?.Current?.Index?.Replace ?? ["HJ6332012"];
        if (!replaceScales.some(scaleName => AirQuality.ScaleMatches(oldScale, scaleName))) {
            return { body: null, log: `WK3 aq: skipped (scale ${oldScale} not in Index.Replace)` };
        }
        const oldCategory = ByteBuffer.readInt8(aqPos + aqCategoryOffset);
        const oldIndex = ByteBuffer.readInt16(aqPos + aqIndexOffset);
        const metaPos = ByteBuffer.__indirect(aqPos + aqMetaOffset);
        const metaProviderOffset = ByteBuffer.__offset(metaPos, 16);
        const providerName = metaProviderOffset ? ByteBuffer.__string(metaPos + metaProviderOffset) : "";
        const vecPos = ByteBuffer.__indirect(aqPos + aqPollutantsOffset);
        if (vecPos < 0 || vecPos + 4 > rawBody.length) return { body: null, log: "WK3 aq: skipped (pollutants vector out of range)" };
        const vecLen = ByteBuffer.readInt32(vecPos);
        if (vecLen > 20) return { body: null, log: `WK3 aq: skipped (pollutants too many: ${vecLen})` };
        // WK3 污染物类型枚举相对 WK2 数组整体错位一位（离线对照 ANALYSIS §174：
        // 以苹果指数为标尺，7 城拟合误差 0.1–3.6，插件标签误差 13–97）。
        // 真值 = 数组[typeByte - 1]，故头部补一位占位；WK3 的 0 号类型未知。
        // 影响：Calculate 指数/档位/主污染物、向量重建的槽位匹配、明细页数值。
        const pollutantTypes = ["UNKNOWN0", "NOT_AVAILABLE", "C6H6", "NH3", "NMHC", "NO", "NO2", "NOX", "OZONE", "PM2_5", "SO2", "PM10", "CO", "UNKNOWN12", "UNKNOWN13"];
        // WK2 的单位枚举：0 ppb、1 µg、2 UNKNOWN2、3 UNKNOWN3。WK3 原包体里
        // 大量出现单位字节 2，且浓度是 µg 量级，故计算时把它当作微克（推断，见函数注释）。
        const unitTypes = ["PARTS_PER_BILLION", "MICROGRAMS_PER_CUBIC_METER", "MICROGRAMS_PER_CUBIC_METER", "UNKNOWN3"];
        const unitEnumByName = { PARTS_PER_BILLION: 0, MICROGRAMS_PER_CUBIC_METER: 1, UNKNOWN3: 3 };
        // 污染物空了（v2 Step 2）：按 Pollutants.Provider 补填；补不到则跳过。
        // 槽位本身缺失时上游已在前面拦下（AQ field absent），此处只处理空向量。
        let filledPollutants = null;
        let filledProviderName = null;
        if (vecLen === 0) {
            const pollutantsProvider = Settings?.AirQuality?.Current?.Pollutants?.Provider ?? "ColorfulClouds";
            try {
                const filled = pollutantsProvider === "QWeather"
                    ? await getQWeather()?.CurrentAirQuality()
                    : await colorfulClouds?.CurrentAirQuality();
                if (filled && !filled.metadata?.temporarilyUnavailable && Array.isArray(filled.pollutants) && filled.pollutants.length > 0) {
                    filledPollutants = filled.pollutants;
                    filledProviderName = filled.metadata?.providerName || pollutantsProvider;
                }
            } catch {
                filledPollutants = null;
            }
            if (!filledPollutants) return { body: null, log: `WK3 aq: skipped (pollutants empty, provider ${pollutantsProvider} unavailable)` };
        }
        let pollutants = [];
        const origPollutants = [];
        for (let i = 0; i < vecLen; i++) {
            const elemPos = ByteBuffer.__indirect(vecPos + 4 + i * 4);
            const typeOffset = ByteBuffer.__offset(elemPos, 4);
            const amountOffset = ByteBuffer.__offset(elemPos, 6);
            const unitsOffset = ByteBuffer.__offset(elemPos, 8);
            if (!typeOffset || !amountOffset || !unitsOffset) return { body: null, log: `WK3 aq: skipped (pollutant ${i} field absent)` };
            const typeByte = ByteBuffer.readInt8(elemPos + typeOffset);
            const amount = ByteBuffer.readFloat32(elemPos + amountOffset);
            const unitsByte = ByteBuffer.readInt8(elemPos + unitsOffset);
            if (!Number.isFinite(amount) || amount < 0) return { body: null, log: `WK3 aq: skipped (pollutant ${i} amount invalid)` };
            pollutants.push({ pollutantType: pollutantTypes[typeByte] ?? "UNKNOWN", amount, units: unitTypes[unitsByte] ?? "UNKNOWN" });
            origPollutants.push({ typeByte, amount, unitsByte, units: unitTypes[unitsByte] ?? "UNKNOWN" });
        }
        if (filledPollutants) {
            // 补填的污染物只留类型/单位已知、量有限且非负的项（provider
            // 缺失值常以 -1 占位，需滤掉）；单位串须在 overlay 可写枚举内。
            pollutants = filledPollutants
                .filter(p => pollutantTypes.includes(p.pollutantType) && unitEnumByName[p.units] !== undefined && Number.isFinite(p.amount) && p.amount >= 0)
                .map(p => ({ pollutantType: p.pollutantType, amount: p.amount, units: p.units }));
            if (pollutants.length === 0) return { body: null, log: "WK3 aq: skipped (pollutants filled but unusable)" };
        }
        // 指数来源按 Index.Provider 分发（v2 InjectIndex 同款）；默认
        // 仍为内置 Calculate。直接 provider 的结果须自带 scale /
        // category / index / 主污染物 / isSignificant / pollutants /
        // metadata；WAQI 不带 pollutants，向量保持原样。
        const indexProvider = Settings?.AirQuality?.Current?.Index?.Provider ?? "Calculate";
        const forceCNPrimary = Settings?.AirQuality?.Current?.Index?.ForceCNPrimaryPollutants;
        let calculated = null;
        if (indexProvider === "QWeather") {
            const qw = getQWeather();
            const direct = qw ? await qw.CurrentAirQuality(forceCNPrimary) : null;
            if (!direct || direct.metadata?.temporarilyUnavailable) return { body: null, log: "WK3 aq: skipped (QWeather index unavailable)" };
            calculated = direct;
        } else if (indexProvider === "ColorfulCloudsUS" || indexProvider === "ColorfulCloudsCN") {
            if (!colorfulClouds) return { body: null, log: "WK3 aq: skipped (no colorfulClouds env)" };
            const direct = await colorfulClouds.CurrentAirQuality(indexProvider === "ColorfulCloudsUS", forceCNPrimary);
            if (!direct || direct.metadata?.temporarilyUnavailable) return { body: null, log: `WK3 aq: skipped (${indexProvider} index unavailable)` };
            calculated = direct;
        } else if (indexProvider === "WAQI") {
            const waqi = getWAQI();
            if (!waqi) return { body: null, log: "WK3 aq: skipped (no WAQI env)" };
            let direct = null;
            if (Settings?.API?.WAQI?.Token) {
                direct = await waqi.AQI2();
            } else {
                const nearest = await waqi.Nearest();
                if (nearest?.metadata?.stationId) {
                    const token = await waqi.Token(nearest.metadata.stationId);
                    const aqi = token ? await waqi.AQI(nearest.metadata.stationId, token) : null;
                    if (aqi) direct = { metadata: { ...nearest.metadata, ...aqi.metadata }, ...nearest, ...aqi };
                }
            }
            if (!direct || direct.metadata?.temporarilyUnavailable) return { body: null, log: "WK3 aq: skipped (WAQI index unavailable)" };
            calculated = direct;
        } else {
            const effectiveSettings = {
                ...Settings,
                AirQuality: { ...(Settings?.AirQuality ?? {}), Calculate: { ...(Settings?.AirQuality?.Calculate ?? {}), Algorithm: algorithm } },
            };
            calculated = AirQuality.Pollutants2AQI({ pollutants, metadata: { providerName } }, effectiveSettings);
        }
        if (!Number.isFinite(calculated?.index) || calculated.index < 0 || !Number.isFinite(calculated?.categoryIndex) || calculated.categoryIndex < 1 || calculated.categoryIndex > 10) {
            return { body: null, log: `WK3 aq: skipped (index invalid: index=${calculated?.index} category=${calculated?.categoryIndex})` };
        }
        const primaryEnum = pollutantTypes.indexOf(calculated.primaryPollutant);
        if (primaryEnum < 0) return { body: null, log: `WK3 aq: skipped (primary pollutant unknown: ${calculated.primaryPollutant})` };
        const perPollutant = (calculated.pollutants ?? []).map(p => `${p.pollutantType}=${Number.isFinite(p.index) ? p.index.toFixed(2) : p.index}`).join(" ");
        // 污染物向量重建输入：按原顺序、按类型对齐指数结果；量或单位
        // 没变的写回原字节，变了的写换算值与目标单位枚举。空向量补填
        // 时没有原表，直接用指数结果的污染物建新向量（overlay 的
        // fresh 分支）。
        const calcByType = new Map((calculated.pollutants ?? []).map(p => [p.pollutantType, p]));
        let newPollutants;
        let changedDesc;
        if (origPollutants.length > 0) {
            newPollutants = origPollutants.map(orig => {
                const typeName = pollutantTypes[orig.typeByte] ?? "UNKNOWN";
                const calc = calcByType.get(typeName);
                const unchanged = { typeEnum: orig.typeByte, amount: orig.amount, unitsEnum: orig.unitsByte };
                if (!calc || !Number.isFinite(calc.amount) || calc.amount < 0) return unchanged;
                if (calc.amount === orig.amount && calc.units === orig.units) return unchanged;
                const unitsEnum = unitEnumByName[calc.units];
                if (!Number.isInteger(unitsEnum)) return unchanged;
                return { typeEnum: orig.typeByte, amount: calc.amount, unitsEnum };
            });
            changedDesc = newPollutants.map((p, i) => {
                const orig = origPollutants[i];
                if (p.amount === orig.amount && p.unitsEnum === orig.unitsByte) return null;
                const unitLabel = p.unitsEnum === 0 ? "ppb" : p.unitsEnum === 1 ? "µg" : `byte${p.unitsEnum}`;
                return `${pollutantTypes[orig.typeByte] ?? "?"} ${orig.amount}->${Number(p.amount.toFixed(2))}${unitLabel}`;
            }).filter(Boolean).join(", ");
        } else {
            newPollutants = (calculated.pollutants ?? [])
                .filter(p => pollutantTypes.includes(p.pollutantType) && unitEnumByName[p.units] !== undefined && Number.isFinite(p.amount) && p.amount >= 0)
                .map(p => ({ typeEnum: pollutantTypes.indexOf(p.pollutantType), amount: p.amount, unitsEnum: unitEnumByName[p.units] }));
            changedDesc = `filled ${newPollutants.length} pollutants`;
        }
        // WK3 探针（beta12）：beta11 已证实应用不发定义请求，故“定义送达”说已排除；
        // 剩余名字格式假说：WK3 体内苹果自带 scale 均带版本后缀（HJ6332012.2604、
        // EPA_NowCast.2604），而 HK.AQHI 本地定义的 version 为 1，故试写带版本的
        // HK.AQHI.1；其余标准不动。CN.AQHI 同理但本探针只动 HK 代表。
        const probeScale = calculated.scale === "HK.AQHI" ? "HK.AQHI.1" : calculated.scale;
        // 昨日对比（v2 Step 4 逻辑的 WK3 版）与元数据拼接（v2 Step 5）。
        // ComparisonTrend 字节映射取自 3.2 bundle 内生成枚举（已核实）：
        // UNKNOWN 0、MUCH_WORSE 1、WORSE 2、SAME 3、BETTER 4、MUCH_BETTER 5；
        // JS 比较只产出 UNKNOWN/WORSE/SAME/BETTER 四种。
        const COMPARISON_BYTE_BY_TREND = { UNKNOWN: 0, WORSE: 2, SAME: 3, BETTER: 4 };
        const COMPARISON_TREND_BY_BYTE = { 0: "UNKNOWN", 1: "MUCH_WORSE", 2: "WORSE", 3: "SAME", 4: "BETTER", 5: "MUCH_BETTER" };
        const aqComparisonOffset = ByteBuffer.__offset(aqPos, 14);
        const origComparisonByte = aqComparisonOffset ? ByteBuffer.readInt8(aqPos + aqComparisonOffset) : -1;
        const origComparisonStr = COMPARISON_TREND_BY_BYTE[origComparisonByte] ?? "UNKNOWN";
        // 注意：原值 UNKNOWN 时字段常因默认值被省略（北京体实测字段 5
        // 的 vtable 槽位为 0），故“字段缺失”即 UNKNOWN、同样需要计算；
        // 写回时由 overlay 以 vtable 槽位 + 表尾追加字节补位。
        const needComputeComparison = origComparisonStr === "UNKNOWN" || Settings?.AirQuality?.Comparison?.ReplaceWhenCurrentChange === true;
        let comparisonByte = null;
        let comparisonLine = null;
        let comparisonLog = "comparison unchanged";
        if (needComputeComparison) {
            // 昨日指数源按 v2 InjectComparison 分发：彩云美标/国标、
            // 和风、内置算法（和风昨日污染物 + 本地算）。失败只退回原值。
            const yesterdayProvider = Settings?.AirQuality?.Comparison?.Yesterday?.IndexProvider ?? "ColorfulCloudsUS";
            const currentIndexProvider = Settings?.AirQuality?.Current?.Index?.Provider ?? "Calculate";
            const isHj = currentIndexProvider === "Calculate"
                ? Settings?.AirQuality?.Calculate?.Algorithm === "WAQI_InstantCast_CN"
                : (currentIndexProvider === "QWeather" || currentIndexProvider === "ColorfulCloudsCN");
            const isEpa = currentIndexProvider === "WAQI" || currentIndexProvider === "ColorfulCloudsUS";
            if (yesterdayProvider === "ColorfulCloudsUS" || yesterdayProvider === "ColorfulCloudsCN") {
                const useUsa = yesterdayProvider !== "ColorfulCloudsCN";
                if (!colorfulClouds) {
                    comparisonLog = "comparison skipped (no colorfulClouds env)";
                } else {
                    try {
                        const todayCatFromInjected = yesterdayProvider === "ColorfulCloudsCN" ? (isHj ? calculated.categoryIndex : undefined) : (isEpa ? calculated.categoryIndex : undefined);
                        const yesterday = await colorfulClouds.YesterdayAirQuality(useUsa);
                        if (yesterday?.metadata?.temporarilyUnavailable || !Number.isFinite(yesterday?.categoryIndex)) {
                            comparisonLog = "comparison skipped (yesterday unavailable)";
                        } else {
                            let todayCat = todayCatFromInjected;
                            if (todayCat === undefined) {
                                const ccCurrent = await colorfulClouds.CurrentAirQuality(useUsa);
                                if (ccCurrent?.metadata?.temporarilyUnavailable || !Number.isFinite(ccCurrent?.categoryIndex)) {
                                    comparisonLog = "comparison skipped (current unavailable)";
                                    todayCat = null;
                                } else {
                                    todayCat = ccCurrent.categoryIndex;
                                }
                            }
                            if (todayCat !== undefined && todayCat !== null) {
                                const trend = AirQuality.CompareCategoryIndexes(todayCat, yesterday.categoryIndex);
                                comparisonByte = COMPARISON_BYTE_BY_TREND[trend] ?? 0;
                                comparisonLine = `对比昨日：\n指数：${AirQuality.appendScaleToProviderName({ metadata: yesterday.metadata, scale: yesterday.scale }, Settings)}`;
                                comparisonLog = `comparison ${origComparisonStr}->${trend} (CC today(${useUsa ? "US" : "CN"}) ${todayCat} vs yesterday ${yesterday.categoryIndex})`;
                            }
                        }
                    } catch (error) {
                        comparisonLog = `comparison skipped (${error?.message ?? error})`;
                    }
                }
            } else if (yesterdayProvider === "QWeather" || yesterdayProvider === "Calculate") {
                try {
                    const qw = getQWeather();
                    if (!qw || !aqEnv) {
                        comparisonLog = "comparison skipped (no qWeather env)";
                    } else {
                        const setQWeatherCache = qweatherCache => {
                            aqEnv.caches.qweather = qweatherCache;
                            Storage.setItem("@iRingo.WeatherKit.Caches", { ...aqEnv.caches, qweather: qweatherCache });
                        };
                        const locationsGrid = await QWeather.GetLocationsGrid(aqEnv.caches?.qweather, setQWeatherCache);
                        const locationInfo = QWeather.GetLocationInfo(locationsGrid, aqEnv.parameters.latitude, aqEnv.parameters.longitude);
                        const yesterdayQW = await qw.YesterdayAirQuality(locationInfo);
                        if (yesterdayQW?.metadata?.temporarilyUnavailable || !Number.isFinite(yesterdayQW?.categoryIndex) || yesterdayQW.categoryIndex < 0) {
                            comparisonLog = "comparison skipped (yesterday unavailable)";
                        } else {
                            let yesterday = yesterdayQW;
                            if (yesterdayProvider === "Calculate") {
                                const algorithm = AirQuality.chooseAlogrithm({ scale: probeScale }, Settings);
                                if (!algorithm) {
                                    comparisonLog = "comparison skipped (no algorithm for yesterday)";
                                    yesterday = null;
                                } else {
                                    const calcYesterday = AirQuality.Pollutants2AQI(yesterdayQW, Settings, { algorithm });
                                    if (!Number.isFinite(calcYesterday?.categoryIndex) || calcYesterday.categoryIndex < 1) {
                                        comparisonLog = "comparison skipped (yesterday calculation invalid)";
                                        yesterday = null;
                                    } else {
                                        yesterday = calcYesterday;
                                    }
                                }
                            }
                            if (yesterday) {
                                let todayCat;
                                if (yesterdayProvider === "Calculate") {
                                    todayCat = calculated.categoryIndex;
                                } else if (isHj) {
                                    todayCat = calculated.categoryIndex;
                                } else {
                                    const qwCurrent = await qw.CurrentAirQuality();
                                    if (qwCurrent?.metadata?.temporarilyUnavailable || !Number.isFinite(qwCurrent?.categoryIndex)) {
                                        comparisonLog = "comparison skipped (current unavailable)";
                                        todayCat = null;
                                    } else {
                                        todayCat = qwCurrent.categoryIndex;
                                    }
                                }
                                if (todayCat !== undefined && todayCat !== null) {
                                    const trend = AirQuality.CompareCategoryIndexes(todayCat, yesterday.categoryIndex);
                                    comparisonByte = COMPARISON_BYTE_BY_TREND[trend] ?? 0;
                                    comparisonLine = `对比昨日：\n指数：${AirQuality.appendScaleToProviderName({ metadata: yesterday.metadata, scale: yesterday.scale }, Settings)}`;
                                    comparisonLog = `comparison ${origComparisonStr}->${trend} (QW today ${todayCat} vs yesterday ${yesterday.categoryIndex})`;
                                }
                            }
                        }
                    }
                } catch (error) {
                    comparisonLog = `comparison skipped (${error?.message ?? error})`;
                }
            } else {
                comparisonLog = `comparison skipped (yesterday provider ${yesterdayProvider} not wired in WK3)`;
            }
        }
        // 元数据拼接（v2 Step 5）：原 provider + 污染物行（补填时）+
        // 指数行 + 对比行；logo 保持原值（首个有效 provider 即原
        // provider），故不重建 logo 字段。指数行用指数来源的
        // providerName（Calculate 为 iRingo，其余为各 provider 名）。
        const indexProviderName = calculated?.metadata?.providerName || "iRingo";
        const indexLine = `指数：${AirQuality.appendScaleToProviderName({ metadata: { providerName: indexProviderName }, scale: probeScale }, Settings)}`;
        const providerLines = [];
        if (providerName) providerLines.push(providerName);
        if (filledProviderName) providerLines.push(`污染物：${filledProviderName}`);
        providerLines.push(indexLine);
        if (comparisonLine) providerLines.push(comparisonLine);
        const joinedProviderName = providerLines.join("\n");
        const metadataProviderName = joinedProviderName !== providerName ? joinedProviderName : null;
        const overlay = overlayWK3AQ(ByteBuffer, rawBody, country, calculated.categoryIndex, Math.round(calculated.index), {
            scale: probeScale,
            primaryEnum,
            isSignificant: calculated.isSignificant,
            pollutants: newPollutants,
            comparisonByte,
            metadataProviderName,
        });
        if (!overlay.body) return { body: null, log: `WK3 aq: overlay failed (${overlay.log})` };
        return {
            body: overlay.body,
            log: `WK3 aq: provider ${providerName || "?"} pollutants ${pollutants.length} [${perPollutant}] scale ${oldScale}->${probeScale} category ${oldCategory}->${calculated.categoryIndex} index ${oldIndex}->${Math.round(calculated.index)} primary ${calculated.primaryPollutant} (pollutants vector rebuilt: ${changedDesc || "no changes"}${filledProviderName ? `; filled from ${filledProviderName}` : ""}) [index ${indexProvider}] [${comparisonLog}] [metadata: ${metadataProviderName ? "providerName spliced" : "unchanged"}]`,
        };
    } catch (error) {
        return { body: null, log: `WK3 aq: skipped (${error?.message ?? error})` };
    }
}

function overlayWK3AQ(ByteBuffer, rawBody, country, newCategory, newIndex, options = {}) {
    try {
        // overlay 本身不设国家/scale 门，门由调用方（calculateWK3AQ）按设置把关。
        // options.scale：不传或与原 scale 相同则 scale 串指向 blob 原串；
        // 传新串则在新 AQ 表后新建一个字符串对象，scale 字段指向它。
        // options.primaryEnum / options.isSignificant：不传则保持原字节。
        const rootPos = ByteBuffer.readInt32(ByteBuffer.position()) + ByteBuffer.position();
        if (rootPos < 0 || rootPos + 4 > rawBody.length) return { body: null, log: "WK3 aqOverlay: skipped (root out of range)" };
        const rootVtablePos = rootPos - ByteBuffer.readInt32(rootPos);
        const rootVtableLen = ByteBuffer.readUint16(rootVtablePos);
        const rootTableSize = ByteBuffer.readUint16(rootVtablePos + 2);
        const rootFieldCount = Math.floor((rootVtableLen - 4) / 2);
        if (rootFieldCount !== 15 || rootTableSize <= 0 || rootTableSize > 1024) {
            return { body: null, log: `WK3 aqOverlay: skipped (unexpected root fields=${rootFieldCount} size=${rootTableSize})` };
        }
        const slot0Offset = ByteBuffer.__offset(rootPos, 4);
        if (!slot0Offset) return { body: null, log: "WK3 aqOverlay: skipped (slot 0 absent)" };
        const aqPos = ByteBuffer.__indirect(rootPos + slot0Offset);
        const aqVtablePos = aqPos - ByteBuffer.readInt32(aqPos);
        const aqVtableLen = ByteBuffer.readUint16(aqVtablePos);
        const aqTableSize = ByteBuffer.readUint16(aqVtablePos + 2);
        const aqFieldCount = Math.floor((aqVtableLen - 4) / 2);
        if (aqFieldCount < 8 || aqTableSize <= 0 || aqTableSize > 1024) {
            return { body: null, log: `WK3 aqOverlay: skipped (unexpected AQ fields=${aqFieldCount} size=${aqTableSize})` };
        }
        const aqMetaOffset = ByteBuffer.__offset(aqPos, 4);
        const aqCategoryOffset = ByteBuffer.__offset(aqPos, 6);
        const aqIndexOffset = ByteBuffer.__offset(aqPos, 8);
        const aqPollutantsOffset = ByteBuffer.__offset(aqPos, 12);
        const aqScaleOffset = ByteBuffer.__offset(aqPos, 18);
        if (!aqMetaOffset || !aqCategoryOffset || !aqIndexOffset || !aqPollutantsOffset || !aqScaleOffset) {
            return { body: null, log: "WK3 aqOverlay: skipped (AQ field absent)" };
        }
        const scale = ByteBuffer.__string(aqPos + aqScaleOffset);
        const newScale = typeof options.scale === "string" && options.scale.length > 0 ? options.scale : scale;
        const oldCategory = ByteBuffer.readInt8(aqPos + aqCategoryOffset);
        const oldIndex = ByteBuffer.readInt16(aqPos + aqIndexOffset);
        // 原有在场槽位清单（自检用）。
        const presentSlots = [];
        for (let slot = 0; slot < rootFieldCount; slot++) {
            if (ByteBuffer.__offset(rootPos, 4 + slot * 2)) presentSlots.push(slot);
        }
        const align4 = value => Math.ceil(value / 4) * 4;
        const align8 = value => Math.ceil(value / 8) * 8;
        const newRootVtablePos = 4;
        const newRootPos = align4(newRootVtablePos + rootVtableLen);
        const newAqVtablePos = align4(newRootPos + rootTableSize);
        const newAqPos = newAqVtablePos + aqVtableLen;
        // 昨日对比字段（字段 5）缺失时（原值 UNKNOWN 被默认值省略），
        // 不能原位改写：改 vtable——表长 +1、字段 5 槽位置为原表长，
        // 并在表尾追加一个字节放对比值；其余字段偏移一律不动。
        const comparisonExtendsTable = Number.isInteger(options.comparisonByte) && !ByteBuffer.__offset(aqPos, 14);
        const newAqTableSize = aqTableSize + (comparisonExtendsTable ? 1 : 0);
        const scaleChanged = newScale !== scale;
        const newScaleBytes = scaleChanged ? new TextEncoder().encode(newScale) : null;
        const newScalePos = scaleChanged ? align4(newAqPos + newAqTableSize) : null;
        const newScaleSize = scaleChanged ? align4(4 + newScaleBytes.length) : 0;
        // 元数据重建：新布局在 scale 串之后依次放元数据 vtable、元数据表、
        // providerName 新串。元数据表沿用原表字节模板（标量原样保留），
        // 只重算偏移字段：0/2/5 指向 blob 原对象，6（providerName）指向
        // 新串。北京体实测元数据表 11 字段、标量最大 4 字节（经纬度为
        // float32），表起址仍按 8 对齐以容纳可能的 8 字节成员。
        let rebuildMetadata = null;
        let newMetaVtablePos = null;
        let newMetaPos = null;
        let newProviderNamePos = null;
        if (typeof options.metadataProviderName === "string" && options.metadataProviderName.length > 0) {
            const origMetaPos = ByteBuffer.__indirect(aqPos + aqMetaOffset);
            const origMetaVtablePos = origMetaPos - ByteBuffer.readInt32(origMetaPos);
            const metaVtableLen = ByteBuffer.readUint16(origMetaVtablePos);
            const metaTableSize = ByteBuffer.readUint16(origMetaVtablePos + 2);
            const metaFieldCount = Math.floor((metaVtableLen - 4) / 2);
            if (metaFieldCount < 7 || metaTableSize <= 0 || metaTableSize > 256) {
                return { body: null, log: `WK3 aqOverlay: skipped (unexpected metadata fields=${metaFieldCount} size=${metaTableSize})` };
            }
            const metaProviderOffset = ByteBuffer.__offset(origMetaPos, 16);
            const origProviderName = metaProviderOffset ? ByteBuffer.__string(origMetaPos + metaProviderOffset) : "";
            if (origProviderName !== options.metadataProviderName) {
                const stringTargets = {};
                for (const f of [0, 2, 5]) {
                    const fo = ByteBuffer.__offset(origMetaPos, 4 + f * 2);
                    if (fo) stringTargets[f] = { fieldOffset: fo, origTarget: ByteBuffer.__indirect(origMetaPos + fo) };
                }
                rebuildMetadata = {
                    table: rawBody.subarray(origMetaPos, origMetaPos + metaTableSize),
                    vtable: rawBody.subarray(origMetaVtablePos, origMetaVtablePos + metaVtableLen),
                    vtableLen: metaVtableLen,
                    tableSize: metaTableSize,
                    stringTargets,
                    providerFieldOffset: metaProviderOffset,
                };
            }
        }
        // 污染物向量重建：新布局在 scale 串之后依次放污染物 vtable、
        // 各污染物表（沿用原表字节模板，只改三个标量）、新向量。
        // 任一前置校验失败都退回 blob 原向量（AQ 替换本身不受影响），
        // 只有自检失败才放弃整个 overlay。
        let rebuildPollutants = null;
        let newPolVtablePositions = [];
        let newPolTablePositions = [];
        let newPolVecPos = null;
        try {
            const origVecPos = ByteBuffer.__indirect(aqPos + aqPollutantsOffset);
            const origVecLen = ByteBuffer.readInt32(origVecPos);
            const want = options.pollutants;
            if (Array.isArray(want) && want.length === origVecLen && origVecLen > 0 && origVecLen <= 20) {
                // 注意：原体里各污染物表不一定共享同一张 vtable（实测北京体：
                // 3 个表长 14、类型字段在 13，另 3 个表长 16、类型字段在 15），
                // 故每个元素各存自己的 vtable 副本与字段偏移，不做共享假设。
                let ok = true;
                const elems = [];
                for (let i = 0; i < origVecLen; i++) {
                    const elem = ByteBuffer.__indirect(origVecPos + 4 + i * 4);
                    const vt = elem - ByteBuffer.readInt32(elem);
                    const vtableLen = ByteBuffer.readUint16(vt);
                    const tableSize = ByteBuffer.readUint16(vt + 2);
                    const typeOff = ByteBuffer.__offset(elem, 4);
                    const amountOff = ByteBuffer.__offset(elem, 6);
                    const unitsOff = ByteBuffer.__offset(elem, 8);
                    if (!typeOff || !amountOff || !unitsOff || vtableLen < 10 || tableSize <= 0 || tableSize > 64) { ok = false; break; }
                    elems.push({ table: rawBody.subarray(elem, elem + tableSize), vtable: rawBody.subarray(vt, vt + vtableLen), vtableLen, tableSize, typeOff, amountOff, unitsOff });
                }
                if (ok) {
                    for (const p of want) {
                        if (!Number.isInteger(p.typeEnum) || p.typeEnum < 0 || p.typeEnum > 13 || !Number.isFinite(p.amount) || p.amount < 0 || !Number.isInteger(p.unitsEnum) || p.unitsEnum < 0 || p.unitsEnum > 3) { ok = false; break; }
                    }
                }
                if (ok) {
                    rebuildPollutants = { want, elems };
                }
            } else if (Array.isArray(want) && want.length > 0 && want.length <= 20 && origVecLen === 0) {
                // 空向量补填：没有原表可复用，按 Pollutant 三字段
                // （type int8 / amount float32 / units int8）从头建表：
                // vtable 10 字节、表 16 字节（type@4、amount@8、
                // units@12），各元素共用一张 vtable。
                let ok = true;
                for (const p of want) {
                    if (!Number.isInteger(p.typeEnum) || p.typeEnum < 0 || p.typeEnum > 13 || !Number.isFinite(p.amount) || p.amount < 0 || !Number.isInteger(p.unitsEnum) || p.unitsEnum < 0 || p.unitsEnum > 3) { ok = false; break; }
                }
                if (ok) {
                    const freshVtable = new Uint8Array([10, 0, 16, 0, 4, 0, 8, 0, 12, 0]);
                    const elems = want.map(() => ({ table: new Uint8Array(16), vtable: freshVtable, vtableLen: 10, tableSize: 16, typeOff: 4, amountOff: 8, unitsOff: 12 }));
                    rebuildPollutants = { want, elems, fresh: true };
                }
            }
        } catch {
            rebuildPollutants = null;
        }
        let cursor = scaleChanged ? newScalePos + newScaleSize : newAqPos + newAqTableSize;
        if (rebuildMetadata) {
            newMetaVtablePos = align4(cursor);
            cursor = newMetaVtablePos + rebuildMetadata.vtableLen;
            newMetaPos = align8(cursor);
            cursor = newMetaPos + rebuildMetadata.tableSize;
            const providerNameBytes = new TextEncoder().encode(options.metadataProviderName);
            newProviderNamePos = align4(cursor);
            cursor = newProviderNamePos + align4(4 + providerNameBytes.length);
            rebuildMetadata.providerNameBytes = providerNameBytes;
        }
        if (rebuildPollutants) {
            // 向量必须在表之前：FlatBuffers 的 uoffset 是无符号前向偏移，
            // 元素偏移必须为正。beta10 把向量放在表之后，元素偏移成负值，
            // 存为 uint32 后是 40 亿量级的越界数；JS 解析（有符号）能正常
            // 读回故自检全过，苹果原生解析（无符号）则越界丢段——这就是
            // beta10 新请求无段的机制。原体实测：向量在前、元素偏移全为
            // +4…+120 的小正数；此处复现该排布。
            newPolVecPos = align4(cursor);
            cursor = newPolVecPos + 4 + rebuildPollutants.want.length * 4;
            if (rebuildPollutants.fresh) {
                // 补填的新表共用一张 vtable，只占一次位置。
                const vtablePos = align4(cursor);
                for (let i = 0; i < rebuildPollutants.elems.length; i++) newPolVtablePositions.push(vtablePos);
                cursor = vtablePos + rebuildPollutants.elems[0].vtableLen;
            } else {
                for (let i = 0; i < rebuildPollutants.elems.length; i++) {
                    const vtablePos = align4(cursor);
                    newPolVtablePositions.push(vtablePos);
                    cursor = vtablePos + rebuildPollutants.elems[i].vtableLen;
                }
            }
            for (let i = 0; i < rebuildPollutants.elems.length; i++) {
                const tablePos = align4(cursor);
                newPolTablePositions.push(tablePos);
                cursor = tablePos + rebuildPollutants.elems[i].tableSize;
            }
        }
        const blobOffset = align8(cursor);
        const out = new Uint8Array(blobOffset + rawBody.length);
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        view.setUint32(0, newRootPos, true);
        out.set(rawBody.subarray(rootVtablePos, rootVtablePos + rootVtableLen), newRootVtablePos);
        const newRoot = new Uint8Array(rawBody.subarray(rootPos, rootPos + rootTableSize));
        const newRootView = new DataView(newRoot.buffer, newRoot.byteOffset, newRoot.byteLength);
        newRootView.setInt32(0, newRootPos - newRootVtablePos, true);
        for (let slot = 0; slot < rootFieldCount; slot++) {
            const fieldOffset = ByteBuffer.__offset(rootPos, 4 + slot * 2);
            if (!fieldOffset) continue;
            const newFieldPos = newRootPos + fieldOffset;
            const value = slot === 0 ? newAqPos - newFieldPos : ByteBuffer.__indirect(rootPos + fieldOffset) + blobOffset - newFieldPos;
            newRootView.setUint32(fieldOffset, value, true);
        }
        out.set(newRoot, newRootPos);
        const newAqVtable = new Uint8Array(rawBody.subarray(aqVtablePos, aqVtablePos + aqVtableLen));
        if (comparisonExtendsTable) {
            const newAqVtableView = new DataView(newAqVtable.buffer, newAqVtable.byteOffset, newAqVtable.byteLength);
            newAqVtableView.setUint16(2, newAqTableSize, true);
            newAqVtableView.setUint16(14, aqTableSize, true);
        }
        out.set(newAqVtable, newAqVtablePos);
        const newAq = new Uint8Array(newAqTableSize);
        newAq.set(rawBody.subarray(aqPos, aqPos + aqTableSize), 0);
        const newAqView = new DataView(newAq.buffer, newAq.byteOffset, newAq.byteLength);
        newAqView.setInt32(0, newAqPos - newAqVtablePos, true);
        if (rebuildMetadata) {
            newAqView.setUint32(aqMetaOffset, newMetaPos - (newAqPos + aqMetaOffset), true);
        } else {
            const origTarget = ByteBuffer.__indirect(aqPos + aqMetaOffset);
            newAqView.setUint32(aqMetaOffset, origTarget + blobOffset - (newAqPos + aqMetaOffset), true);
        }
        if (rebuildPollutants) {
            newAqView.setUint32(aqPollutantsOffset, newPolVecPos - (newAqPos + aqPollutantsOffset), true);
        } else {
            const origTarget = ByteBuffer.__indirect(aqPos + aqPollutantsOffset);
            newAqView.setUint32(aqPollutantsOffset, origTarget + blobOffset - (newAqPos + aqPollutantsOffset), true);
        }
        if (scaleChanged) {
            newAqView.setUint32(aqScaleOffset, newScalePos - (newAqPos + aqScaleOffset), true);
        } else {
            const origTarget = ByteBuffer.__indirect(aqPos + aqScaleOffset);
            newAqView.setUint32(aqScaleOffset, origTarget + blobOffset - (newAqPos + aqScaleOffset), true);
        }
        newAqView.setInt8(aqCategoryOffset, newCategory);
        newAqView.setInt16(aqIndexOffset, newIndex, true);
        const aqIsSignificantOffset = ByteBuffer.__offset(aqPos, 10);
        if (aqIsSignificantOffset && typeof options.isSignificant === "boolean") {
            newAqView.setInt8(aqIsSignificantOffset, options.isSignificant ? 1 : 0);
        }
        const aqPrimaryOffset = ByteBuffer.__offset(aqPos, 16);
        if (aqPrimaryOffset && Number.isInteger(options.primaryEnum)) {
            newAqView.setInt8(aqPrimaryOffset, options.primaryEnum);
        }
        const aqComparisonWriteOffset = ByteBuffer.__offset(aqPos, 14);
        if (Number.isInteger(options.comparisonByte)) {
            if (aqComparisonWriteOffset) {
                newAqView.setInt8(aqComparisonWriteOffset, options.comparisonByte);
            } else if (comparisonExtendsTable) {
                newAqView.setInt8(aqTableSize, options.comparisonByte);
            }
        }
        out.set(newAq, newAqPos);
        if (scaleChanged) {
            const scaleView = new DataView(out.buffer, out.byteOffset, out.byteLength);
            scaleView.setUint32(newScalePos, newScaleBytes.length, true);
            out.set(newScaleBytes, newScalePos + 4);
        }
        if (rebuildMetadata) {
            out.set(rebuildMetadata.vtable, newMetaVtablePos);
            out.set(rebuildMetadata.table, newMetaPos);
            const metaView = new DataView(out.buffer, out.byteOffset + newMetaPos, rebuildMetadata.tableSize);
            metaView.setInt32(0, newMetaPos - newMetaVtablePos, true);
            for (const f of [0, 2, 5]) {
                const entry = rebuildMetadata.stringTargets[f];
                if (entry) metaView.setUint32(entry.fieldOffset, entry.origTarget + blobOffset - (newMetaPos + entry.fieldOffset), true);
            }
            if (rebuildMetadata.providerFieldOffset) {
                metaView.setUint32(rebuildMetadata.providerFieldOffset, newProviderNamePos - (newMetaPos + rebuildMetadata.providerFieldOffset), true);
            }
            const providerNameView = new DataView(out.buffer, out.byteOffset, out.byteLength);
            providerNameView.setUint32(newProviderNamePos, rebuildMetadata.providerNameBytes.length, true);
            out.set(rebuildMetadata.providerNameBytes, newProviderNamePos + 4);
        }
        if (rebuildPollutants) {
            const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
            rebuildPollutants.elems.forEach((elem, i) => {
                out.set(elem.vtable, newPolVtablePositions[i]);
            });
            rebuildPollutants.want.forEach((p, i) => {
                const elem = rebuildPollutants.elems[i];
                const tablePos = newPolTablePositions[i];
                out.set(elem.table, tablePos);
                const tableView = new DataView(out.buffer, out.byteOffset + tablePos, elem.tableSize);
                tableView.setInt32(0, tablePos - newPolVtablePositions[i], true);
                tableView.setInt8(elem.typeOff, p.typeEnum);
                tableView.setFloat32(elem.amountOff, p.amount, true);
                tableView.setInt8(elem.unitsOff, p.unitsEnum);
            });
            outView.setUint32(newPolVecPos, rebuildPollutants.want.length, true);
            rebuildPollutants.want.forEach((p, i) => {
                const elemPos = newPolVecPos + 4 + i * 4;
                outView.setUint32(elemPos, newPolTablePositions[i] - elemPos, true);
            });
        }
        out.set(rawBody, blobOffset);
        // 自检：重建 ByteBuffer 核对关键项。
        const checkBuffer = new flatbuffers.ByteBuffer(out);
        const checkRootPos = checkBuffer.readInt32(checkBuffer.position()) + checkBuffer.position();
        const checkRootVtablePos = checkRootPos - checkBuffer.readInt32(checkRootPos);
        const checkFieldCount = Math.floor((checkBuffer.readUint16(checkRootVtablePos) - 4) / 2);
        if (checkFieldCount !== rootFieldCount) return { body: null, log: "WK3 aqOverlay: skipped (self-check root field count mismatch)" };
        for (const slot of presentSlots) {
            if (!checkBuffer.__offset(checkRootPos, 4 + slot * 2)) return { body: null, log: `WK3 aqOverlay: skipped (self-check slot ${slot} lost)` };
        }
        const checkAqPos = checkBuffer.__indirect(checkRootPos + checkBuffer.__offset(checkRootPos, 4));
        if (checkBuffer.readInt8(checkAqPos + checkBuffer.__offset(checkAqPos, 6)) !== newCategory) {
            return { body: null, log: "WK3 aqOverlay: skipped (self-check category mismatch)" };
        }
        if (checkBuffer.readInt16(checkAqPos + checkBuffer.__offset(checkAqPos, 8)) !== newIndex) {
            return { body: null, log: "WK3 aqOverlay: skipped (self-check index mismatch)" };
        }
        if (checkBuffer.__string(checkAqPos + checkBuffer.__offset(checkAqPos, 18)) !== newScale) {
            return { body: null, log: "WK3 aqOverlay: skipped (self-check scale mismatch)" };
        }
        if (Number.isInteger(options.comparisonByte)) {
            const checkComparisonOffset = checkBuffer.__offset(checkAqPos, 14);
            if (!checkComparisonOffset || checkBuffer.readInt8(checkAqPos + checkComparisonOffset) !== options.comparisonByte) {
                return { body: null, log: "WK3 aqOverlay: skipped (self-check comparison mismatch)" };
            }
        }
        if (typeof options.metadataProviderName === "string" && options.metadataProviderName.length > 0) {
            const checkMetaPos = checkBuffer.__indirect(checkAqPos + checkBuffer.__offset(checkAqPos, 4));
            const checkMetaProviderOffset = checkBuffer.__offset(checkMetaPos, 16);
            if (!checkMetaProviderOffset || checkBuffer.__string(checkMetaPos + checkMetaProviderOffset) !== options.metadataProviderName) {
                return { body: null, log: "WK3 aqOverlay: skipped (self-check metadata providerName mismatch)" };
            }
        }
        if (rebuildPollutants) {
            const checkVecPos = checkBuffer.__indirect(checkAqPos + checkBuffer.__offset(checkAqPos, 12));
            if (checkBuffer.readInt32(checkVecPos) !== rebuildPollutants.want.length) {
                return { body: null, log: "WK3 aqOverlay: skipped (self-check pollutants vector length mismatch)" };
            }
            // 无符号前向检查：元素偏移必须为小正数且界内，否则苹果原生
            // 解析越界（JS 有符号读回会掩盖此问题，beta10 即因此漏网）。
            for (let i = 0; i < rebuildPollutants.want.length; i++) {
                const rawOffset = checkBuffer.readUint32(checkVecPos + 4 + i * 4);
                if (rawOffset <= 0 || rawOffset >= out.length) {
                    return { body: null, log: "WK3 aqOverlay: skipped (self-check pollutants element offset not forward)" };
                }
            }
            for (let i = 0; i < rebuildPollutants.want.length; i++) {
                const elem = checkBuffer.__indirect(checkVecPos + 4 + i * 4);
                const want = rebuildPollutants.want[i];
                if (checkBuffer.readInt8(elem + checkBuffer.__offset(elem, 4)) !== want.typeEnum) {
                    return { body: null, log: "WK3 aqOverlay: skipped (self-check pollutant type mismatch)" };
                }
                if (checkBuffer.readFloat32(elem + checkBuffer.__offset(elem, 6)) !== Math.fround(want.amount)) {
                    return { body: null, log: "WK3 aqOverlay: skipped (self-check pollutant amount mismatch)" };
                }
                if (checkBuffer.readInt8(elem + checkBuffer.__offset(elem, 8)) !== want.unitsEnum) {
                    return { body: null, log: "WK3 aqOverlay: skipped (self-check pollutant units mismatch)" };
                }
            }
        }
        return { body: out, log: `WK3 aqOverlay: scale ${scale}->${newScale}, category ${oldCategory}->${newCategory} index ${oldIndex}->${newIndex} (overlay, opaque slots preserved${rebuildPollutants ? ", pollutants vector rebuilt" : ", pollutants vector kept"}) body ${rawBody.length}->${out.length}` };
    } catch (error) {
        return { body: null, log: `WK3 aqOverlay: skipped (${error?.message ?? error})` };
    }
}

function replaceWK3CWTemperature(ByteBuffer, rawBody, country, providerName, providerCurrentWeather) {
    try {
        // 国家门不在此函数内：handler 只在 country ∈ Weather.Replace
        // 时才取 provider 数据，数据为空时下面也会跳过（与 v2
        // InjectCurrentWeather 同款；v3.4.1-beta6 起不再硬编码 CN）。
        if (!providerCurrentWeather || !Number.isFinite(providerCurrentWeather.temperature) || !Number.isFinite(providerCurrentWeather.temperatureApparent)) {
            return { body: null, log: `WK3 cwReplace: skipped (provider ${providerName ?? "?"} current weather unavailable, original kept)` };
        }
        const newTemp = providerCurrentWeather.temperature;
        const newApparent = providerCurrentWeather.temperatureApparent;
        const rootPos = ByteBuffer.readInt32(ByteBuffer.position()) + ByteBuffer.position();
        const vtablePos = rootPos - ByteBuffer.readInt32(rootPos);
        const fieldCount = Math.floor((ByteBuffer.readUint16(vtablePos) - 4) / 2);
        if (fieldCount <= 1) return { body: null, log: "WK3 cwReplace: skipped (slot 1 absent or empty root)" };
        const slot1Offset = ByteBuffer.__offset(rootPos, 6);
        if (!slot1Offset) return { body: null, log: "WK3 cwReplace: skipped (slot 1 absent)" };
        const tablePos = ByteBuffer.__indirect(rootPos + slot1Offset);
        const subVtablePos = tablePos - ByteBuffer.readInt32(tablePos);
        const subFieldCount = Math.floor((ByteBuffer.readUint16(subVtablePos) - 4) / 2);
        if (subFieldCount < 28 || subFieldCount > 64) return { body: null, log: "WK3 cwReplace: skipped (unexpected CW subtable)" };
        const humidityOffset = ByteBuffer.__offset(tablePos, 20);
        const tempOffset = ByteBuffer.__offset(tablePos, 54);
        const apparentOffset = ByteBuffer.__offset(tablePos, 56);
        const dewOffset = ByteBuffer.__offset(tablePos, 58);
        if (!humidityOffset || !tempOffset || !apparentOffset || !dewOffset) return { body: null, log: "WK3 cwReplace: skipped (CW temp/apparent/dew field absent)" };
        const humidity = ByteBuffer.readInt8(tablePos + humidityOffset);
        const oldTemp = ByteBuffer.readFloat32(tablePos + tempOffset);
        const oldApparent = ByteBuffer.readFloat32(tablePos + apparentOffset);
        const oldDew = ByteBuffer.readFloat32(tablePos + dewOffset);
        if (!Number.isFinite(oldTemp) || !Number.isFinite(oldApparent) || !Number.isFinite(oldDew) || humidity < 0 || humidity > 100) {
            return { body: null, log: "WK3 cwReplace: skipped (CW values out of range)" };
        }
        let newDew;
        let dewSource;
        if (Number.isFinite(providerCurrentWeather.temperatureDewPoint)) {
            newDew = providerCurrentWeather.temperatureDewPoint;
            dewSource = "provider";
        } else {
            const alpha = (17.27 * newTemp) / (237.7 + newTemp) + Math.log(humidity / 100);
            newDew = (237.7 * alpha) / (17.27 - alpha);
            dewSource = "magnus";
        }
        const modified = new Uint8Array(rawBody);
        const view = new DataView(modified.buffer, modified.byteOffset, modified.byteLength);
        view.setFloat32(tablePos + tempOffset, newTemp, true);
        view.setFloat32(tablePos + apparentOffset, newApparent, true);
        view.setFloat32(tablePos + dewOffset, newDew, true);
        return { body: modified, log: `WK3 cwReplace: provider ${providerName} temp ${oldTemp.toFixed(2)}->${newTemp.toFixed(2)} apparent ${oldApparent.toFixed(2)}->${newApparent.toFixed(2)} dew ${oldDew.toFixed(2)}->${newDew.toFixed(2)} (${dewSource}) humidity ${humidity}` };
    } catch (error) {
        return { body: null, log: `WK3 cwReplace: skipped (${error?.message ?? error})` };
    }
}

/**
 * WK3 每日高低温原位替换（v3.4.1-beta1）：只改槽 2 每日元素的
 * 最高温（字段23）与最低温（字段25）两个 float32，不动其他字段
 * 与昼夜子表，不改包体长度与任何偏移。
 * 字段身份已由两城独立证实：每日元素字段 23/25 在北京、东京两体
 * 上皆为最高/最低温（与当日最高温比较的当前值比特相等，且最高>
 * 最低在全部 11 日成立）；字段 0 为 forecastStart（当地午夜）。
 * v3.4.1-beta2 追加：同时改昼夜子表（DayPartForecast）的最高温
 * （字段14）与最低温（字段15）。原因：beta1 真机闭环证实包体
 * 已被采用（AQ 卡片显示 EU 的“中等”，非苹果原 HJ 标签），但十
 * 日预报仍显示苹果值，故十日 UI 不读日级字段 23/25，读的是
 * 昼夜子表；日级与子表值各自独立（子表按 07:00-19:00 白天与
 * 19:00-次日 07:00 夜间两个 12 小时窗口算，与日级的日历日窗口
 * 不同，故值不必相等）。子表按窗口认，不按字段号（日元素字段
 * 数因“今日”多一张当日余段表而在 34/35 间变）：白天子表起止
 * 为日起 +7h/+19h，夜间为 +19h/+31h，时长皆 12h；当日余段表
 * （起于请求时刻、止于午夜）时长非 12h，天然排除。
 * provider 仅彩云（ColorfulClouds.Daily）：按 forecastStart 对日
 * 匹配，不按下标——彩云每日从当日开始供数（实测 begin 参数被忽
 * 略），而苹果向量元素 0 为昨日，故昨日无匹配时留原值；彩云缺
 * 某日或某日高低温非有限数时该日留原值。任一校验失败都原样返回
 * （body 为 null）。
 * 自检：用新包体重建 ByteBuffer，重新走槽 2 向量与各元素 vtable
 * 及昼夜子表，核对每个已换浮点与 provider 值（float32 舍入后）一致。
 * @param {import("flatbuffers").ByteBuffer} ByteBuffer - 已按 rawBody 建好的 ByteBuffer
 * @param {Uint8Array} rawBody - 原始包体（不原地修改，成功时返回新拷贝）
 * @param {any} parameters - parseWeatherKitURL 的结果（含 country / 经纬度）
 * @param {any} Settings - 插件 Settings
 * @returns {{body: Uint8Array | null, log: string}}
 */
/**
 * 在一个 WK3 每日元素内按窗口找出昼夜子表（DayPartForecast）。
 * 不按字段号（日元素字段数在 34/35 间变）：白天子表起于日起 +7h、
 * 夜间起于 +19h，时长皆约 12h；当日余段表（起于请求时刻）时长
 * 非 12h，天然排除。返回 { daytime, overnight }，各为
 * { tablePos, maxPos, minPos } 或 null（字段 14/15 为最高/最低温）。
 */
function findWK3Dayparts(ByteBuffer, rawLength, elemPos, dayStart) {
    const vtablePos = elemPos - ByteBuffer.readInt32(elemPos);
    const fieldCount = Math.floor((ByteBuffer.readUint16(vtablePos) - 4) / 2);
    const out = { daytime: null, overnight: null };
    for (let f = 0; f < fieldCount; f++) {
        const off = ByteBuffer.__offset(elemPos, 4 + f * 2);
        if (!off) continue;
        const pos = elemPos + off;
        const v = ByteBuffer.readInt32(pos);
        if (v <= 0 || pos + v >= rawLength) continue;
        const tablePos = pos + v;
        let subVtable;
        try {
            subVtable = tablePos - ByteBuffer.readInt32(tablePos);
            const subCount = Math.floor((ByteBuffer.readUint16(subVtable) - 4) / 2);
            if (subCount < 20 || subCount > 32) continue;
        } catch {
            continue;
        }
        const startOff = ByteBuffer.__offset(tablePos, 4);
        const endOff = ByteBuffer.__offset(tablePos, 6);
        const maxOff = ByteBuffer.__offset(tablePos, 32);
        const minOff = ByteBuffer.__offset(tablePos, 34);
        if (!startOff || !endOff || !maxOff || !minOff) continue;
        const start = ByteBuffer.readInt32(tablePos + startOff);
        const end = ByteBuffer.readInt32(tablePos + endOff);
        const durH = (end - start) / 3600;
        const startH = (start - dayStart) / 3600;
        if (durH < 11 || durH > 13) continue;
        const max = ByteBuffer.readFloat32(tablePos + maxOff);
        const min = ByteBuffer.readFloat32(tablePos + minOff);
        if (!Number.isFinite(max) || !Number.isFinite(min) || max < -60 || max > 60 || min < -60 || min > 60) continue;
        const part = { tablePos, maxPos: tablePos + maxOff, minPos: tablePos + minOff };
        if (startH >= 5 && startH <= 9 && !out.daytime) out.daytime = part;
        else if (startH >= 17 && startH <= 21 && !out.overnight) out.overnight = part;
    }
    return out;
}

async function replaceWK3DailyHighLow(ByteBuffer, rawBody, parameters, Settings) {
    try {
        if (!Settings?.Weather?.Replace?.includes(parameters.country)) {
            return { body: null, log: `WK3 daily: skipped (country ${parameters.country} not in Weather.Replace)` };
        }
        if (Settings?.Weather?.Provider !== "ColorfulClouds") {
            return { body: null, log: `WK3 daily: skipped (provider ${Settings?.Weather?.Provider ?? "?"} not wired in WK3)` };
        }
        const rootPos = ByteBuffer.readInt32(ByteBuffer.position()) + ByteBuffer.position();
        const vtablePos = rootPos - ByteBuffer.readInt32(rootPos);
        const fieldCount = Math.floor((ByteBuffer.readUint16(vtablePos) - 4) / 2);
        if (fieldCount <= 2) return { body: null, log: "WK3 daily: skipped (slot 2 absent or empty root)" };
        const slot2Offset = ByteBuffer.__offset(rootPos, 8);
        if (!slot2Offset) return { body: null, log: "WK3 daily: skipped (slot 2 absent)" };
        const wrapperPos = ByteBuffer.__indirect(rootPos + slot2Offset);
        const vecOffset = ByteBuffer.__offset(wrapperPos, 6);
        if (!vecOffset) return { body: null, log: "WK3 daily: skipped (daily vector absent)" };
        const vecPos = ByteBuffer.__indirect(wrapperPos + vecOffset);
        const dayCount = ByteBuffer.readInt32(vecPos);
        if (dayCount <= 0 || dayCount > 32) return { body: null, log: `WK3 daily: skipped (unexpected daily vector length ${dayCount})` };
        const days = [];
        for (let i = 0; i < dayCount; i++) {
            const slotPos = vecPos + 4 + i * 4;
            const elemPos = slotPos + ByteBuffer.readInt32(slotPos);
            const startOffset = ByteBuffer.__offset(elemPos, 4);
            const maxOffset = ByteBuffer.__offset(elemPos, 50);
            const minOffset = ByteBuffer.__offset(elemPos, 54);
            if (!startOffset || !maxOffset || !minOffset) continue;
            days.push({
                elemPos,
                forecastStart: ByteBuffer.readInt32(elemPos + startOffset),
                maxPos: elemPos + maxOffset,
                minPos: elemPos + minOffset,
                oldMax: ByteBuffer.readFloat32(elemPos + maxOffset),
                oldMin: ByteBuffer.readFloat32(elemPos + minOffset),
            });
        }
        if (days.length === 0) return { body: null, log: "WK3 daily: skipped (no decodable day element)" };
        const colorfulClouds = new ColorfulClouds({ ...parameters }, Settings?.API?.ColorfulClouds?.Token || "Y2FpeXVuX25vdGlmeQ==");
        let providerDaily;
        try {
            providerDaily = await colorfulClouds.Daily(dayCount, days[0].forecastStart);
        } catch (error) {
            return { body: null, log: `WK3 daily: skipped (provider error: ${error?.message ?? error})` };
        }
        const byStart = new Map((providerDaily?.days ?? []).map(d => [d.forecastStart, d]));
        const modified = new Uint8Array(rawBody);
        const view = new DataView(modified.buffer, modified.byteOffset, modified.byteLength);
        let replaced = 0;
        let replacedParts = 0;
        let firstLog = "";
        for (const day of days) {
            const pd = byStart.get(day.forecastStart);
            if (!pd || !Number.isFinite(pd.temperatureMax) || !Number.isFinite(pd.temperatureMin)) continue;
            view.setFloat32(day.maxPos, pd.temperatureMax, true);
            view.setFloat32(day.minPos, pd.temperatureMin, true);
            replaced++;
            if (!firstLog) firstLog = `day ${day.forecastStart} max ${day.oldMax.toFixed(2)}->${pd.temperatureMax.toFixed(2)} min ${day.oldMin.toFixed(2)}->${pd.temperatureMin.toFixed(2)}`;
            const parts = findWK3Dayparts(ByteBuffer, rawBody.length, day.elemPos, day.forecastStart);
            const dayPart = pd.daytimeForecast;
            const nightPart = pd.overnightForecast;
            if (parts.daytime && dayPart && Number.isFinite(dayPart.temperatureMax) && Number.isFinite(dayPart.temperatureMin)) {
                view.setFloat32(parts.daytime.maxPos, dayPart.temperatureMax, true);
                view.setFloat32(parts.daytime.minPos, dayPart.temperatureMin, true);
                replacedParts++;
            }
            if (parts.overnight && nightPart && Number.isFinite(nightPart.temperatureMax) && Number.isFinite(nightPart.temperatureMin)) {
                view.setFloat32(parts.overnight.maxPos, nightPart.temperatureMax, true);
                view.setFloat32(parts.overnight.minPos, nightPart.temperatureMin, true);
                replacedParts++;
            }
        }
        if (replaced === 0) return { body: null, log: "WK3 daily: skipped (no day matched)" };
        const checkBb = new flatbuffers.ByteBuffer(modified);
        const checkRoot = checkBb.readInt32(checkBb.position()) + checkBb.position();
        const checkSlot2 = checkBb.__offset(checkRoot, 8);
        if (!checkSlot2) return { body: null, log: "WK3 daily: skipped (self-check: slot 2 lost)" };
        const checkWrapper = checkBb.__indirect(checkRoot + checkSlot2);
        const checkVec = checkBb.__indirect(checkWrapper + checkBb.__offset(checkWrapper, 6));
        if (checkBb.readInt32(checkVec) !== dayCount) return { body: null, log: "WK3 daily: skipped (self-check: day count changed)" };
        for (let i = 0; i < dayCount; i++) {
            const slotPos = checkVec + 4 + i * 4;
            const elemPos = slotPos + checkBb.readInt32(slotPos);
            const startOffset = checkBb.__offset(elemPos, 4);
            const maxOffset = checkBb.__offset(elemPos, 50);
            const minOffset = checkBb.__offset(elemPos, 54);
            if (!startOffset || !maxOffset || !minOffset) continue;
            const pd = byStart.get(checkBb.readInt32(elemPos + startOffset));
            if (!pd || !Number.isFinite(pd.temperatureMax) || !Number.isFinite(pd.temperatureMin)) continue;
            if (checkBb.readFloat32(elemPos + maxOffset) !== Math.fround(pd.temperatureMax) ||
                checkBb.readFloat32(elemPos + minOffset) !== Math.fround(pd.temperatureMin)) {
                return { body: null, log: "WK3 daily: skipped (self-check: value mismatch)" };
            }
            const parts = findWK3Dayparts(checkBb, modified.length, elemPos, checkBb.readInt32(elemPos + startOffset));
            const dayPart = pd.daytimeForecast;
            const nightPart = pd.overnightForecast;
            if (parts.daytime && dayPart && Number.isFinite(dayPart.temperatureMax) && Number.isFinite(dayPart.temperatureMin)) {
                if (checkBb.readFloat32(parts.daytime.maxPos) !== Math.fround(dayPart.temperatureMax) ||
                    checkBb.readFloat32(parts.daytime.minPos) !== Math.fround(dayPart.temperatureMin)) {
                    return { body: null, log: "WK3 daily: skipped (self-check: daytime value mismatch)" };
                }
            }
            if (parts.overnight && nightPart && Number.isFinite(nightPart.temperatureMax) && Number.isFinite(nightPart.temperatureMin)) {
                if (checkBb.readFloat32(parts.overnight.maxPos) !== Math.fround(nightPart.temperatureMax) ||
                    checkBb.readFloat32(parts.overnight.minPos) !== Math.fround(nightPart.temperatureMin)) {
                    return { body: null, log: "WK3 daily: skipped (self-check: overnight value mismatch)" };
                }
            }
        }
        return { body: modified, log: `WK3 daily: ColorfulClouds ${replaced}/${days.length} days high/low replaced (${firstLog}) [dayparts ${replacedParts}]` };
    } catch (error) {
        return { body: null, log: `WK3 daily: skipped (${error?.message ?? error})` };
    }
}

/**
 * WK3 逐小时温度原位替换（v3.4.1-beta3）：只改槽 3 小时元素的
 * 温度（字段17）一个 float32，不动其他字段，不改包体长度与
 * 任何偏移。字段身份已由三城证实：小时元素字段 17 在北京、
 * 东京、哈尔滨三体上皆为温度（与 CW 温度/体感/露点三重贴
 * 近，哈尔滨体感精确相等，全日曲线平滑）；字段 0 为
 * forecastStart（整点）。WK2 的 26 字段中仅 19 号 unknown20
 * 被删，自 20 起差一位，温度字段号未变。
 * provider 仅彩云（ColorfulClouds.ForecastHourly）：按
 * forecastStart 对时匹配，不按下标——彩云逐小时从当前小时
 * 开始供数（实测 begin 参数未必生效），而苹果向量含过去数
 * 日小时，故过去小时无匹配时留原值；彩云缺某小时或某小时
 * 温度非有限数时该小时留原值。任一校验失败都原样返回
 * （body 为 null）。
 * 自检：用新包体重建 ByteBuffer，重新走槽 3 向量与各元素
 * vtable，核对每个已换浮点与 provider 值（float32 舍入后）一致。
 * @param {import("flatbuffers").ByteBuffer} ByteBuffer - 已按 rawBody 建好的 ByteBuffer
 * @param {Uint8Array} rawBody - 原始包体（不原地修改，成功时返回新拷贝）
 * @param {any} parameters - parseWeatherKitURL 的结果（含 country / 经纬度）
 * @param {any} Settings - 插件 Settings
 * @returns {{body: Uint8Array | null, log: string}}
 */
async function replaceWK3HourlyTemperature(ByteBuffer, rawBody, parameters, Settings) {
    try {
        if (!Settings?.Weather?.Replace?.includes(parameters?.country)) return { body: null, log: `WK3 hourly: skipped (country ${parameters?.country} not in Weather.Replace)` };
        if (Settings?.Weather?.Provider !== "ColorfulClouds") return { body: null, log: `WK3 hourly: skipped (provider ${Settings?.Weather?.Provider} not wired in WK3)` };
        const rootPos = ByteBuffer.position() + ByteBuffer.readInt32(ByteBuffer.position());
        const rootVtable = rootPos - ByteBuffer.readInt32(rootPos);
        const rootFieldCount = Math.floor((ByteBuffer.readUint16(rootVtable) - 4) / 2);
        if (rootFieldCount <= 3) return { body: null, log: "WK3 hourly: skipped (slot 3 absent or empty root)" };
        const slot3Offset = ByteBuffer.__offset(rootPos, 10);
        if (!slot3Offset) return { body: null, log: "WK3 hourly: skipped (slot 3 absent)" };
        const wrapperPos = ByteBuffer.__indirect(rootPos + slot3Offset);
        const hoursVecOffset = ByteBuffer.__offset(wrapperPos, 6);
        if (!hoursVecOffset) return { body: null, log: "WK3 hourly: skipped (hours vector absent)" };
        const hoursVec = ByteBuffer.__indirect(wrapperPos + hoursVecOffset);
        const hourCount = ByteBuffer.readInt32(hoursVec);
        if (hourCount < 1 || hourCount > 400) return { body: null, log: `WK3 hourly: skipped (unexpected hour count ${hourCount})` };
        const hours = [];
        for (let i = 0; i < hourCount; i++) {
            const slotPos = hoursVec + 4 + i * 4;
            const elemPos = slotPos + ByteBuffer.readInt32(slotPos);
            const startOffset = ByteBuffer.__offset(elemPos, 4);
            const tempOffset = ByteBuffer.__offset(elemPos, 38);
            if (!startOffset || !tempOffset) continue;
            hours.push({
                elemPos,
                forecastStart: ByteBuffer.readInt32(elemPos + startOffset),
                oldTemp: ByteBuffer.readFloat32(elemPos + tempOffset),
                tempPos: elemPos + tempOffset,
            });
        }
        if (hours.length === 0) return { body: null, log: "WK3 hourly: skipped (no decodable hour element)" };
        const provider = new ColorfulClouds({ ...parameters }, Settings?.API?.ColorfulClouds?.Token || "Y2FpeXVuX25vdGlmeQ==");
        const providerHourly = await provider.ForecastHourly(hours.length, hours[0].forecastStart);
        const providerHours = Array.isArray(providerHourly?.hours) ? providerHourly.hours : [];
        if (providerHours.length === 0) return { body: null, log: "WK3 hourly: skipped (ColorfulClouds hourly unavailable)" };
        const byStart = new Map();
        for (const h of providerHours) {
            if (Number.isFinite(h?.forecastStart) && Number.isFinite(h?.temperature)) byStart.set(h.forecastStart, h.temperature);
        }
        const modified = new Uint8Array(rawBody);
        const view = new DataView(modified.buffer, modified.byteOffset, modified.byteLength);
        let replaced = 0;
        let firstLog = "";
        for (const hour of hours) {
            const temp = byStart.get(hour.forecastStart);
            if (temp === undefined) continue;
            view.setFloat32(hour.tempPos, temp, true);
            replaced++;
            if (!firstLog) firstLog = `hour ${hour.forecastStart} temp ${hour.oldTemp.toFixed(2)}->${temp.toFixed(2)}`;
        }
        if (replaced === 0) return { body: null, log: "WK3 hourly: skipped (no hour matched)" };
        const checkBb = new flatbuffers.ByteBuffer(modified);
        const checkRoot = checkBb.position() + checkBb.readInt32(checkBb.position());
        const checkSlot3 = checkBb.__offset(checkRoot, 10);
        if (!checkSlot3) return { body: null, log: "WK3 hourly: skipped (self-check: slot 3 lost)" };
        const checkWrapper = checkBb.__indirect(checkRoot + checkSlot3);
        const checkVecOff = checkBb.__offset(checkWrapper, 6);
        if (!checkVecOff) return { body: null, log: "WK3 hourly: skipped (self-check: hours vector lost)" };
        const checkVec = checkBb.__indirect(checkWrapper + checkVecOff);
        if (checkBb.readInt32(checkVec) !== hourCount) return { body: null, log: "WK3 hourly: skipped (self-check: hour count changed)" };
        for (let i = 0; i < hourCount; i++) {
            const slotPos = checkVec + 4 + i * 4;
            const elemPos = slotPos + checkBb.readInt32(slotPos);
            const startOffset = checkBb.__offset(elemPos, 4);
            const tempOffset = checkBb.__offset(elemPos, 38);
            if (!startOffset || !tempOffset) continue;
            const temp = byStart.get(checkBb.readInt32(elemPos + startOffset));
            if (temp === undefined) continue;
            if (checkBb.readFloat32(elemPos + tempOffset) !== Math.fround(temp)) {
                return { body: null, log: "WK3 hourly: skipped (self-check: value mismatch)" };
            }
        }
        return { body: modified, log: `WK3 hourly: ColorfulClouds ${replaced}/${hours.length} hours temperature replaced (${firstLog})` };
    } catch (error) {
        return { body: null, log: `WK3 hourly: skipped (${error?.message ?? error})` };
    }
}

/**
 * WK3 预警补充（beta7）：只改现有槽 9 的预警元素，不新建元素，
 * 不动集合元数据 / detailsUrl / logo。provider 本 beta 只接
 * QWeatherWeb（默认路径，和风详情页）；其余 provider 未接线，
 * 一律回退原体。流程：解码槽 9 元素为 v2 形状 → 调现有
 * WeatherAlerts.mergeAlerts（评分匹配 + 只补缺失/占位字段）
 * → 只把变化的字段写回（元素表重建 + 向量重建 + 集合表重建
 * + 根重定基，复用 AQ 覆盖架构），任一校验失败回退原体。
 * WK3 元素 22 字段 = WK2 前 22 字段、顺序不变（哈尔滨实测），
 * WK2 的 unknown23～26 已删；元素内向量必须在表之前（beta10
 * 教训），本函数布局保证这一点。
 * @param {import("flatbuffers").ByteBuffer} ByteBuffer - 已按 rawBody 建好的 ByteBuffer
 * @param {Uint8Array} rawBody - 工作体（已含 AQ/CW 覆盖）
 * @param {object} parameters - parseWeatherKitURL 的结果（含经纬度、语言）
 * @param {object} Settings - 插件设置
 * @returns {Promise<{body: Uint8Array|null, log: string}>}
 */
async function supplementWK3Alerts(ByteBuffer, rawBody, parameters, Settings) {
    try {
        const rootPos = ByteBuffer.readInt32(ByteBuffer.position()) + ByteBuffer.position();
        const rootVtablePos = rootPos - ByteBuffer.readInt32(rootPos);
        const rootVtableLen = ByteBuffer.readUint16(rootVtablePos);
        const rootTableSize = ByteBuffer.readUint16(rootVtablePos + 2);
        const rootFieldCount = Math.floor((rootVtableLen - 4) / 2);
        if (rootFieldCount !== 15 || rootTableSize <= 0 || rootTableSize > 1024) {
            return { body: null, log: `WK3 alerts: skipped (unexpected root fields=${rootFieldCount} size=${rootTableSize})` };
        }
        const slot9Offset = ByteBuffer.__offset(rootPos, 4 + 9 * 2);
        if (!slot9Offset) return { body: null, log: "WK3 alerts: skipped (slot 9 absent)" };
        const collPos = ByteBuffer.__indirect(rootPos + slot9Offset);
        const collVtablePos = collPos - ByteBuffer.readInt32(collPos);
        const collVtableLen = ByteBuffer.readUint16(collVtablePos);
        const collTableSize = ByteBuffer.readUint16(collVtablePos + 2);
        const collFieldCount = Math.floor((collVtableLen - 4) / 2);
        if (collFieldCount !== 3 || collTableSize <= 0 || collTableSize > 256) {
            return { body: null, log: `WK3 alerts: skipped (unexpected alerts collection fields=${collFieldCount} size=${collTableSize})` };
        }
        const collMetaOffset = ByteBuffer.__offset(collPos, 4);
        const collDetailsOffset = ByteBuffer.__offset(collPos, 6);
        const collAlertsOffset = ByteBuffer.__offset(collPos, 8);
        if (!collAlertsOffset) return { body: null, log: "WK3 alerts: skipped (alerts vector absent)" };
        const vecPos = ByteBuffer.__indirect(collPos + collAlertsOffset);
        const alertCount = ByteBuffer.readInt32(vecPos);
        if (alertCount <= 0 || alertCount > 64) return { body: null, log: `WK3 alerts: skipped (alert count ${alertCount})` };
        // provider 分发（v2 InjectWeatherAlerts 同款规则）：
        // QWeatherWeb 恒跑；ColorfulClouds / QWeather 只在国家预警
        // 中心城市跑（v2 的 NWC 门：两家预警数据只覆盖国内）。
        const providerName = Settings?.WeatherAlerts?.Provider || "QWeatherWeb";
        if (providerName === "WeatherKit") return { body: null, log: "WK3 alerts: skipped (provider WeatherKit)" };
        let collProviderName = "";
        if (collMetaOffset) {
            const metaPos = ByteBuffer.__indirect(collPos + collMetaOffset);
            const metaProviderOffset = ByteBuffer.__offset(metaPos, 16);
            if (metaProviderOffset) collProviderName = ByteBuffer.__string(metaPos + metaProviderOffset) || "";
        }
        const isNationalWarningCenter = ["国家预警信息发布中心", "國家預警信息發布中心", "National Early Warning Center"].includes(collProviderName);
        // Apple 集合元数据解码（11 字段，与 WK2 Metadata 同序）：
        // f0 attributionUrl, f1 expireTime, f2 language, f3 latitude,
        // f4 longitude, f5 providerLogo, f6 providerName, f7 readTime,
        // f8 reportedTime, f9 temporarilyUnavailable, f10 sourceType。
        // 缺席字段记 null，供后续与 provider 合并时做 diff。
        const appleMeta = { attributionUrl: null, expireTime: null, language: null, latitude: null, longitude: null, providerLogo: null, providerName: null, readTime: null, reportedTime: null, temporarilyUnavailable: null, sourceType: null };
        let appleDetailsUrl = null;
        if (collMetaOffset) {
            const metaPos = ByteBuffer.__indirect(collPos + collMetaOffset);
            const mOff = f => ByteBuffer.__offset(metaPos, 4 + f * 2);
            const mStr = f => mOff(f) ? ByteBuffer.__string(metaPos + mOff(f)) : null;
            const mI32 = f => mOff(f) ? ByteBuffer.readInt32(metaPos + mOff(f)) : null;
            const mF32 = f => mOff(f) ? ByteBuffer.readFloat32(metaPos + mOff(f)) : null;
            const mI8 = f => mOff(f) ? ByteBuffer.readInt8(metaPos + mOff(f)) : null;
            appleMeta.attributionUrl = mStr(0);
            appleMeta.expireTime = mI32(1);
            appleMeta.language = mStr(2);
            appleMeta.latitude = mF32(3);
            appleMeta.longitude = mF32(4);
            appleMeta.providerLogo = mStr(5);
            appleMeta.providerName = mStr(6);
            appleMeta.readTime = mI32(7);
            appleMeta.reportedTime = mI32(8);
            appleMeta.temporarilyUnavailable = mI8(9);
            appleMeta.sourceType = mI8(10);
        }
        if (collDetailsOffset) appleDetailsUrl = ByteBuffer.__string(collPos + collDetailsOffset) || null;
        let providerResult;
        if (providerName === "QWeatherWeb") {
            const detailsUrl = collDetailsOffset ? ByteBuffer.__string(collPos + collDetailsOffset) : "";
            if (!detailsUrl) return { body: null, log: "WK3 alerts: skipped (no detailsUrl)" };
            const qWeather = new QWeather({ ...parameters }, Settings?.API?.QWeather?.Token || "bdd98ec1d87747f3a2e8b1741a5af796", Settings?.API?.QWeather?.Host);
            providerResult = await qWeather.WeatherAlertWeb(detailsUrl);
        } else if (providerName === "ColorfulClouds" || providerName === "QWeather") {
            if (!isNationalWarningCenter) return { body: null, log: `WK3 alerts: skipped (provider ${providerName} requires National Warning Center, got "${collProviderName}")` };
            if (providerName === "ColorfulClouds") {
                // v2 同款：WeatherAlert()（v2.6 实况缓存）；不用
                // WeatherAlertV3CAP()（另条 CAP 端点，v2 未接）。
                const colorfulClouds = new ColorfulClouds({ ...parameters }, Settings?.API?.ColorfulClouds?.Token || "Y2FpeXVuX25vdGlmeQ==");
                providerResult = await colorfulClouds.WeatherAlert();
            } else {
                // 和风 weatheralert v1：/weatheralert/v1/current/{lat}/{lon}。
                const qWeather = new QWeather({ ...parameters }, Settings?.API?.QWeather?.Token || "bdd98ec1d87747f3a2e8b1741a5af796", Settings?.API?.QWeather?.Host);
                providerResult = await qWeather.WeatherAlert();
            }
        } else {
            return { body: null, log: `WK3 alerts: skipped (provider ${providerName} not wired in WK3)` };
        }
        const providerAlerts = providerResult?.alerts || [];
        // 元数据合并（v2 InjectWeatherAlerts 同款，beta5 补齐）：
        // provider metadata 按字段覆盖 Apple（实测三路 provider
        // 都只带 attributionUrl）；detailsUrl 用 provider 的
        // （无则留 Apple）；providerLogo 缺席时按合并后
        // providerName 补（NWC 名不在 logo 表里，实测恒为空，
        // 但仍按 v2 原样走一遍）。v2 只以 metadata 存在为门——
        // provider 0 条预警时元素不补，但元数据/detailsUrl 照合
        // （和风 403 的失败体也会走到这里）；故原先的
        // "skipped (no provider alerts)" 早退改为由下方的
        // no-changes 门统一处理。
        const providerMeta = providerResult?.metadata || null;
        if (!providerMeta) return { body: null, log: "WK3 alerts: skipped (no provider metadata)" };
        const META_STR_KEYS = ["attributionUrl", "language", "providerLogo", "providerName"];
        const META_NUM_KEYS = ["expireTime", "readTime", "reportedTime", "sourceType"];
        const META_F32_KEYS = ["latitude", "longitude"];
        const mergedMeta = { ...appleMeta };
        for (const k of META_STR_KEYS) if (typeof providerMeta[k] === "string" && providerMeta[k]) mergedMeta[k] = providerMeta[k];
        for (const k of META_NUM_KEYS) if (typeof providerMeta[k] === "number" && Number.isFinite(providerMeta[k])) mergedMeta[k] = providerMeta[k] | 0;
        for (const k of META_F32_KEYS) if (typeof providerMeta[k] === "number" && Number.isFinite(providerMeta[k])) mergedMeta[k] = providerMeta[k];
        if (typeof providerMeta.temporarilyUnavailable === "boolean") mergedMeta.temporarilyUnavailable = providerMeta.temporarilyUnavailable ? 1 : 0;
        else if (typeof providerMeta.temporarilyUnavailable === "number") mergedMeta.temporarilyUnavailable = providerMeta.temporarilyUnavailable ? 1 : 0;
        if (!mergedMeta.providerLogo) mergedMeta.providerLogo = providerNameToLogo(mergedMeta.providerName) || null;
        const mergedDetailsUrl = typeof providerResult?.detailsUrl === "string" && providerResult.detailsUrl ? providerResult.detailsUrl : appleDetailsUrl;
        const metaChangedKeys = [];
        for (const k of [...META_STR_KEYS, ...META_NUM_KEYS, "temporarilyUnavailable", ...META_F32_KEYS]) {
            const a = appleMeta[k], b = mergedMeta[k];
            const eq = META_F32_KEYS.includes(k) ? (a === b || (a != null && b != null && Math.fround(a) === Math.fround(b))) : (a ?? null) === (b ?? null);
            if (!eq) metaChangedKeys.push(k);
        }
        // 无槽位可挂新表时元数据/detailsUrl 合并不落盘（实测体
        // 均有这两个字段，此分支只作防御）。
        const metaChanged = metaChangedKeys.length > 0 && !!collMetaOffset;
        const detailsChanged = (appleDetailsUrl ?? null) !== (mergedDetailsUrl ?? null) && !!collDetailsOffset;
        // 枚举表（与 3.2 bundle 生成对象一致；解码 int→串，编码串→int）。
        const SEVERITY = ["UNKNOWN", "EXTREME", "SEVERE", "MODERATE", "MINOR", "UNKNOWN5"];
        const SIGNIFICANCE = ["UNKNOWN", "UNKNOWN1", "UNKNOWN2", "UNKNOWN3", "UNKNOWN4", "UNKNOWN5", "UNKNOWN6", "UNKNOWN7", "UNKNOWN8", "UNKNOWN9", "STATEMENT", "WARNING", "ADVISORY", "UNKNOWN13"];
        const URGENCY = ["UNKNOWN", "IMMEDIATE", "EXPECTED", "FUTURE", "PAST", "UNKNOWN5"];
        const CERTAINTY = ["UNKNOWN", "OBSERVED", "LIKELY", "POSSIBLE", "UNLIKELY", "UNKNOWN5"];
        const IMPORTANCE = ["NORMAL", "LOW", "HIGH", "UNKNOWN3", "UNKNOWN4", "UNKNOWN5"];
        const RESPONSE = ["UNKNOWN0", "SHELTER", "EVACUATE", "PREPARE", "EXECUTE", "AVOID", "MONITOR", "ACCESS", "ALLCLEAR", "NONE", "UNKNOWN10"];
        const enumStr = (table, v) => table[v] ?? "UNKNOWN";
        const appleAlerts = [];
        const elemInfos = [];
        for (let i = 0; i < alertCount; i++) {
            const slotPos = vecPos + 4 + i * 4;
            const elemPos = ByteBuffer.__indirect(slotPos);
            const elemVtablePos = elemPos - ByteBuffer.readInt32(elemPos);
            const elemVtableLen = ByteBuffer.readUint16(elemVtablePos);
            const elemTableSize = ByteBuffer.readUint16(elemVtablePos + 2);
            const elemFieldCount = Math.floor((elemVtableLen - 4) / 2);
            if (elemFieldCount !== 22 || elemTableSize <= 0 || elemTableSize > 256) {
                return { body: null, log: `WK3 alerts: skipped (unexpected alert element fields=${elemFieldCount} size=${elemTableSize})` };
            }
            const foffs = [];
            for (let f = 0; f < 22; f++) foffs.push(ByteBuffer.__offset(elemPos, 4 + f * 2));
            const strF = f => foffs[f] ? ByteBuffer.__string(elemPos + foffs[f]) : null;
            const intF = (f, read) => foffs[f] ? read(elemPos + foffs[f]) : 0;
            let responses = [];
            if (foffs[21]) {
                const rvecPos = ByteBuffer.__indirect(elemPos + foffs[21]);
                const rlen = ByteBuffer.readInt32(rvecPos);
                if (rlen < 0 || rlen > 32) return { body: null, log: `WK3 alerts: skipped (responses length ${rlen})` };
                for (let j = 0; j < rlen; j++) responses.push(enumStr(RESPONSE, ByteBuffer.readInt8(rvecPos + 4 + j)));
            }
            appleAlerts.push({
                id: null,
                areaId: strF(1),
                areaName: strF(2),
                attributionUrl: strF(3),
                certainty: enumStr(CERTAINTY, intF(19, p => ByteBuffer.readInt8(p))),
                countryCode: strF(4),
                description: strF(5),
                detailsUrl: strF(12),
                effectiveTime: intF(7, p => ByteBuffer.readInt32(p)),
                eventEndTime: intF(11, p => ByteBuffer.readInt32(p)),
                eventOnsetTime: intF(10, p => ByteBuffer.readInt32(p)),
                eventSource: strF(17),
                expireTime: intF(8, p => ByteBuffer.readInt32(p)),
                importance: enumStr(IMPORTANCE, intF(20, p => ByteBuffer.readInt8(p))),
                issuedTime: intF(9, p => ByteBuffer.readInt32(p)),
                phenomenon: strF(13),
                responses,
                severity: enumStr(SEVERITY, intF(14, p => ByteBuffer.readInt8(p))),
                significance: enumStr(SIGNIFICANCE, intF(15, p => ByteBuffer.readInt8(p))),
                source: strF(16),
                token: strF(6),
                urgency: enumStr(URGENCY, intF(18, p => ByteBuffer.readInt8(p))),
            });
            elemInfos.push({ elemPos, elemVtablePos, elemVtableLen, elemTableSize, foffs });
        }
        // 合并（v2 逻辑：评分匹配 + 只补缺失/占位字段；不新建元素）。
        const before = appleAlerts.map(a => ({ ...a, responses: [...a.responses] }));
        WeatherAlerts.mergeAlerts(appleAlerts, providerAlerts);
        const STRING_FIELDS = [[1, "areaId"], [2, "areaName"], [3, "attributionUrl"], [4, "countryCode"], [5, "description"], [6, "token"], [12, "detailsUrl"], [13, "phenomenon"], [16, "source"], [17, "eventSource"]];
        const TIME_FIELDS = [[7, "effectiveTime"], [8, "expireTime"], [9, "issuedTime"], [10, "eventOnsetTime"], [11, "eventEndTime"]];
        const ENUM_FIELDS = [[14, "severity", SEVERITY], [15, "significance", SIGNIFICANCE], [18, "urgency", URGENCY], [19, "certainty", CERTAINTY], [20, "importance", IMPORTANCE]];
        const changes = [];
        let anyChange = false;
        for (let i = 0; i < alertCount; i++) {
            const ch = { strings: new Map(), times: new Map(), enums: new Map(), responses: null };
            const b = before[i], a = appleAlerts[i];
            for (const [f, key] of STRING_FIELDS) {
                if ((b[key] ?? null) !== (a[key] ?? null) && a[key] != null) ch.strings.set(f, a[key]);
            }
            for (const [f, key] of TIME_FIELDS) {
                if ((b[key] || 0) !== (a[key] || 0) && (a[key] || 0) !== 0) ch.times.set(f, a[key]);
            }
            for (const [f, key, table] of ENUM_FIELDS) {
                if (b[key] !== a[key]) {
                    const idx = table.indexOf(a[key]);
                    if (idx >= 0) ch.enums.set(f, idx);
                }
            }
            if (JSON.stringify(b.responses) !== JSON.stringify(a.responses) && a.responses.length) {
                const ints = [];
                for (const r of a.responses) { const idx = RESPONSE.indexOf(r); if (idx >= 0) ints.push(idx); }
                if (ints.length) ch.responses = ints;
            }
            if (ch.strings.size || ch.times.size || ch.enums.size || ch.responses) anyChange = true;
            changes.push(ch);
        }
        if (!anyChange && !metaChanged && !detailsChanged) return { body: null, log: `WK3 alerts: no changes (${alertCount} alerts, ${providerAlerts.length} provider alerts)` };
        // 布局：[根 uoffset][根 vtable][根表][集合 vtable][集合表][预警向量]
        // [变化元素的 vtable+表][新串][新 responses 向量][blob]。
        // 向量在表之前（beta10 教训），所有新对象都在 blob 之前，
        // 故一切 uoffset 均为前向。
        const align4 = v => Math.ceil(v / 4) * 4;
        const align8 = v => Math.ceil(v / 8) * 8;
        const enc = new TextEncoder();
        // 先算每条变化元素的扩展表长与新串/向量尺寸。
        const elemPlans = [];
        for (let i = 0; i < alertCount; i++) {
            const ch = changes[i];
            const info = elemInfos[i];
            if (!ch.strings.size && !ch.times.size && !ch.enums.size && !ch.responses) {
                elemPlans.push(null);
                continue;
            }
            // 缺席字段的追加：先 4 字节槽（int32 时间与串 uoffset，
            // 均需 4 对齐），后 int8 枚举（1 对齐）。串字段缺席时也
            // 在此配一个 4 字节槽位放新串的 uoffset（beta7 漏了这一
            // 类：和风详情页映射会给每条预警补 areaId/areaName，
            // 苹果原体这两字段缺席，缺槽位就写不进，beta8 补上）。
            const added = new Map(); // field -> offset in new table
            let cursor = info.elemTableSize;
            const addedInt32 = [];
            const addedStr = [];
            const addedInt8 = [];
            for (const [f] of ch.times) if (!info.foffs[f]) addedInt32.push(f);
            for (const [f] of ch.strings) if (!info.foffs[f]) addedStr.push(f);
            for (const [f] of ch.enums) if (!info.foffs[f]) addedInt8.push(f);
            for (const f of addedInt32) { cursor = Math.ceil(cursor / 4) * 4; added.set(f, cursor); cursor += 4; }
            for (const f of addedStr) { cursor = Math.ceil(cursor / 4) * 4; added.set(f, cursor); cursor += 4; }
            for (const f of addedInt8) { added.set(f, cursor); cursor += 1; }
            const newTableSize = cursor;
            const newStrings = [];
            for (const [f, s] of [...ch.strings.entries()].sort((a, b) => a[0] - b[0])) {
                const bytes = enc.encode(s);
                newStrings.push({ field: f, bytes, size: align4(4 + bytes.length + 1) });
            }
            const newRespSize = ch.responses ? align4(4 + ch.responses.length) : 0;
            elemPlans.push({ added, newTableSize, newStrings, newRespSize });
        }
        const newRootVtablePos = 4;
        const newRootPos = align4(newRootVtablePos + rootVtableLen);
        const newCollVtablePos = align4(newRootPos + rootTableSize);
        // 集合表含 uoffset（4 字节），表位必须 4 对齐：beta8 漏了这
        // 一步，表落在 90（%4=2），App 验不过整条响应（哈尔滨/
        // 中山 AQ 连带消失；无预警城市不走这步故不受影响）。
        const newCollPos = align4(newCollVtablePos + collVtableLen);
        const newVecPos = align4(newCollPos + collTableSize);
        const newVecSize = 4 + alertCount * 4;
        let cursor = align4(newVecPos + newVecSize);
        const elemNewPos = [];
        for (let i = 0; i < alertCount; i++) {
            const plan = elemPlans[i];
            if (!plan) { elemNewPos.push(null); continue; }
            const vtablePos = align4(cursor);
            cursor = vtablePos + elemInfos[i].elemVtableLen;
            const tablePos = align4(cursor);
            cursor = tablePos + plan.newTableSize;
            elemNewPos.push({ vtablePos, tablePos, plan });
        }
        const strPos = new Map(); // "i:f" -> pos
        cursor = align4(cursor);
        for (let i = 0; i < alertCount; i++) {
            const plan = elemPlans[i];
            if (!plan) continue;
            for (const s of plan.newStrings) {
                strPos.set(`${i}:${s.field}`, cursor);
                cursor += s.size;
            }
        }
        const respPos = new Map(); // i -> pos
        cursor = align4(cursor);
        for (let i = 0; i < alertCount; i++) {
            const plan = elemPlans[i];
            if (!plan || !plan.newRespSize) continue;
            respPos.set(i, cursor);
            cursor += plan.newRespSize;
        }
        // 元数据表字段（与 WK2 Metadata 同序；kind 决定槽位大小）。
        const META_FIELDS = [
            ["attributionUrl", "str"], ["expireTime", "i32"], ["language", "str"], ["latitude", "f32"], ["longitude", "f32"],
            ["providerLogo", "str"], ["providerName", "str"], ["readTime", "i32"], ["reportedTime", "i32"],
            ["temporarilyUnavailable", "i8"], ["sourceType", "i8"],
        ];
        // 新元数据表（仅 metaChanged 时建；从 mergedMeta 现算，
        // 不复用 Apple 原表布局）+ 新 detailsUrl 串（仅
        // detailsChanged 时建）。均在 responses 向量之后、blob
        // 之前，4 对齐。
        let newMeta = null;
        if (metaChanged) {
            const vtablePos = align4(cursor);
            cursor = vtablePos + 26;
            const tablePos = align4(cursor);
            const slots = new Map();
            // 表首 4 字节是到 vtable 的 soffset，字段槽位从 +4 起
            // （漏了这 4 字节会让 f0 的槽位与 soffset 重叠，整张
            // 元数据表损坏——beta5 离线验证 Case A/B/F 即因此失败）。
            let tCursor = tablePos + 4;
            for (let f = 0; f < 11; f++) {
                const [key, kind] = META_FIELDS[f];
                const v = mergedMeta[key];
                if (v == null) continue;
                if (kind === "i8") { slots.set(f, tCursor - tablePos); tCursor += 1; }
                else { tCursor = Math.ceil(tCursor / 4) * 4; slots.set(f, tCursor - tablePos); tCursor += 4; }
            }
            const tableSize = tCursor - tablePos;
            cursor = tCursor;
            const strPos = new Map();
            cursor = align4(cursor);
            for (let f = 0; f < 11; f++) {
                const [key, kind] = META_FIELDS[f];
                if (kind !== "str" || mergedMeta[key] == null) continue;
                const bytes = enc.encode(mergedMeta[key]);
                strPos.set(f, cursor);
                cursor += align4(4 + bytes.length + 1);
            }
            newMeta = { vtablePos, tablePos, tableSize, slots, strPos };
        }
        let newDetailsPos = null;
        if (detailsChanged) {
            cursor = align4(cursor);
            newDetailsPos = cursor;
            cursor += align4(4 + enc.encode(mergedDetailsUrl).length + 1);
        }
        const blobOffset = align8(cursor);
        const out = new Uint8Array(blobOffset + rawBody.length);
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        const setU32 = (p, v) => view.setUint32(p, v, true);
        const setI32 = (p, v) => view.setInt32(p, v, true);
        const setI8 = (p, v) => view.setInt8(p, v);
        const setU16 = (p, v) => view.setUint16(p, v, true);
        // 根 uoffset 与根 vtable/根表。
        setU32(0, newRootPos);
        out.set(rawBody.subarray(rootVtablePos, rootVtablePos + rootVtableLen), newRootVtablePos);
        out.set(rawBody.subarray(rootPos, rootPos + rootTableSize), newRootPos);
        view.setInt32(newRootPos, newRootPos - newRootVtablePos, true);
        for (let slot = 0; slot < rootFieldCount; slot++) {
            const fieldOff = ByteBuffer.__offset(rootPos, 4 + slot * 2);
            if (!fieldOff) continue;
            const origTarget = rootPos + fieldOff + ByteBuffer.readInt32(rootPos + fieldOff);
            const newTarget = slot === 9 ? newCollPos : blobOffset + origTarget;
            setU32(newRootPos + fieldOff, newTarget - (newRootPos + fieldOff));
        }
        // 集合 vtable/集合表。
        out.set(rawBody.subarray(collVtablePos, collVtablePos + collVtableLen), newCollVtablePos);
        out.set(rawBody.subarray(collPos, collPos + collTableSize), newCollPos);
        view.setInt32(newCollPos, newCollPos - newCollVtablePos, true);
        if (collMetaOffset) {
            const origTarget = collPos + collMetaOffset + ByteBuffer.readInt32(collPos + collMetaOffset);
            const target = newMeta ? newMeta.tablePos : blobOffset + origTarget;
            setU32(newCollPos + collMetaOffset, target - (newCollPos + collMetaOffset));
        }
        if (collDetailsOffset) {
            const origTarget = collPos + collDetailsOffset + ByteBuffer.readInt32(collPos + collDetailsOffset);
            const target = newDetailsPos != null ? newDetailsPos : blobOffset + origTarget;
            setU32(newCollPos + collDetailsOffset, target - (newCollPos + collDetailsOffset));
        }
        if (collAlertsOffset) setU32(newCollPos + collAlertsOffset, newVecPos - (newCollPos + collAlertsOffset));
        // 预警向量：未变元素指向 blob 原表，变化元素指向新表。
        setU32(newVecPos, alertCount);
        for (let i = 0; i < alertCount; i++) {
            const slotP = newVecPos + 4 + i * 4;
            const target = elemNewPos[i] ? elemNewPos[i].tablePos : blobOffset + elemInfos[i].elemPos;
            setU32(slotP, target - slotP);
        }
        // 变化元素的 vtable/表/新串/新向量。
        for (let i = 0; i < alertCount; i++) {
            const np = elemNewPos[i];
            if (!np) continue;
            const info = elemInfos[i];
            const ch = changes[i];
            const plan = np.plan;
            out.set(rawBody.subarray(info.elemVtablePos, info.elemVtablePos + info.elemVtableLen), np.vtablePos);
            out.set(rawBody.subarray(info.elemPos, info.elemPos + info.elemTableSize), np.tablePos);
            view.setInt32(np.tablePos, np.tablePos - np.vtablePos, true);
            setU16(np.vtablePos + 2, plan.newTableSize);
            // 追加的缺席字段：vtable 入口指向扩展区。
            for (const [f, off] of plan.added) setU16(np.vtablePos + 4 + f * 2, off);
            // 标量：原位改写（已存在字段）或写入扩展区（新增字段）。
            for (const [f, v] of ch.times) {
                const off = info.foffs[f] || plan.added.get(f);
                setI32(np.tablePos + off, v);
            }
            for (const [f, v] of ch.enums) {
                const off = info.foffs[f] || plan.added.get(f);
                setI8(np.tablePos + off, v);
            }
            // 偏移字段：新串 / 新向量 / blob 原对象，一律重算。
            const OFFSET_FIELDS = [0, 1, 2, 3, 4, 5, 6, 12, 13, 16, 17, 21];
            for (const f of OFFSET_FIELDS) {
                const fieldOff = info.foffs[f];
                if (!fieldOff && !ch.strings.has(f) && f !== 21) continue;
                if (ch.strings.has(f)) {
                    // 已存在字段改写原槽位；缺席字段用扩展区的新槽位。
                    const slotOff = fieldOff || plan.added.get(f);
                    if (slotOff == null) continue;
                    const sPos = strPos.get(`${i}:${f}`);
                    setU32(np.tablePos + slotOff, sPos - (np.tablePos + slotOff));
                } else if (f === 21 && ch.responses) {
                    const rPos = respPos.get(i);
                    setU32(np.tablePos + fieldOff, rPos - (np.tablePos + fieldOff));
                } else if (fieldOff) {
                    const origTarget = info.elemPos + fieldOff + ByteBuffer.readInt32(info.elemPos + fieldOff);
                    setU32(np.tablePos + fieldOff, (blobOffset + origTarget) - (np.tablePos + fieldOff));
                }
            }
            // 新串对象：长度 + 字节 + NUL，4 对齐。
            for (const s of plan.newStrings) {
                const sPos = strPos.get(`${i}:${s.field}`);
                setU32(sPos, s.bytes.length);
                out.set(s.bytes, sPos + 4);
                out[sPos + 4 + s.bytes.length] = 0;
            }
            // 新 responses 向量：长度 + int8 枚举。
            if (ch.responses) {
                const rPos = respPos.get(i);
                setU32(rPos, ch.responses.length);
                ch.responses.forEach((v, j) => setI8(rPos + 4 + j, v));
            }
        }
        // 新元数据表/串与新 detailsUrl 串。
        if (newMeta) {
            setU16(newMeta.vtablePos, 26);
            setU16(newMeta.vtablePos + 2, newMeta.tableSize);
            for (let f = 0; f < 11; f++) setU16(newMeta.vtablePos + 4 + f * 2, newMeta.slots.get(f) || 0);
            setI32(newMeta.tablePos, newMeta.tablePos - newMeta.vtablePos);
            for (let f = 0; f < 11; f++) {
                const [key, kind] = META_FIELDS[f];
                const v = mergedMeta[key];
                if (v == null || !newMeta.slots.has(f)) continue;
                const off = newMeta.tablePos + newMeta.slots.get(f);
                if (kind === "str") setU32(off, newMeta.strPos.get(f) - off);
                else if (kind === "i32") setI32(off, v);
                else if (kind === "f32") view.setFloat32(off, v, true);
                else if (kind === "i8") setI8(off, v);
            }
            for (const [f, sPos] of newMeta.strPos) {
                const bytes = enc.encode(mergedMeta[META_FIELDS[f][0]]);
                setU32(sPos, bytes.length);
                out.set(bytes, sPos + 4);
                out[sPos + 4 + bytes.length] = 0;
            }
        }
        if (newDetailsPos != null) {
            const bytes = enc.encode(mergedDetailsUrl);
            setU32(newDetailsPos, bytes.length);
            out.set(bytes, newDetailsPos + 4);
            out[newDetailsPos + 4 + bytes.length] = 0;
        }
        // blob：工作体原样。
        out.set(rawBody, blobOffset);
        // 自检：用真实 flatbuffers 回读，任一不符回退原体。
        const checkBB = new flatbuffers.ByteBuffer(out);
        const checkRoot = checkBB.readInt32(checkBB.position()) + checkBB.position();
        if (Math.floor((checkBB.readUint16(checkRoot - checkBB.readInt32(checkRoot)) - 4) / 2) !== 15) {
            return { body: null, log: "WK3 alerts: skipped (self-check root fields)" };
        }
        const checkSlot9 = checkBB.__offset(checkRoot, 4 + 9 * 2);
        if (!checkSlot9) return { body: null, log: "WK3 alerts: skipped (self-check slot 9)" };
        const checkColl = checkBB.__indirect(checkRoot + checkSlot9);
        const checkAlertsOff = checkBB.__offset(checkColl, 8);
        if (!checkAlertsOff) return { body: null, log: "WK3 alerts: skipped (self-check alerts vector)" };
        const checkVec = checkBB.__indirect(checkColl + checkAlertsOff);
        if (checkBB.readInt32(checkVec) !== alertCount) return { body: null, log: "WK3 alerts: skipped (self-check vector length)" };
        for (let i = 0; i < alertCount; i++) {
            const slotP = checkVec + 4 + i * 4;
            const elemU = checkBB.readUint32(slotP);
            if (elemU <= 0 || slotP + elemU >= out.length) return { body: null, log: "WK3 alerts: skipped (self-check element offset)" };
            const elemP = slotP + elemU;
            const ch = changes[i];
            const fo = f => checkBB.__offset(elemP, 4 + f * 2);
            for (const [f, s] of ch.strings) {
                const off = fo(f);
                if (!off || checkBB.__string(elemP + off) !== s) return { body: null, log: `WK3 alerts: skipped (self-check alert ${i} string field ${f})` };
            }
            for (const [f, v] of ch.times) {
                const off = fo(f);
                if (!off || checkBB.readInt32(elemP + off) !== v) return { body: null, log: `WK3 alerts: skipped (self-check alert ${i} time field ${f})` };
            }
            for (const [f, v] of ch.enums) {
                const off = fo(f);
                if (!off || checkBB.readInt8(elemP + off) !== v) return { body: null, log: `WK3 alerts: skipped (self-check alert ${i} enum field ${f})` };
            }
            if (ch.responses) {
                const off = fo(21);
                if (!off) return { body: null, log: `WK3 alerts: skipped (self-check alert ${i} responses absent)` };
                const rvec = checkBB.__indirect(elemP + off);
                if (checkBB.readInt32(rvec) !== ch.responses.length) return { body: null, log: `WK3 alerts: skipped (self-check alert ${i} responses length)` };
                for (let j = 0; j < ch.responses.length; j++) {
                    if (checkBB.readInt8(rvec + 4 + j) !== ch.responses[j]) return { body: null, log: `WK3 alerts: skipped (self-check alert ${i} responses[${j}])` };
                }
            }
        }
        // 集合元数据/detailsUrl 回读（beta8 盲区：此前只验元素，
        // 元数据与 detailsUrl 的解析从未被自检覆盖）。
        const checkMetaOff = checkBB.__offset(checkColl, 4);
        const checkDetailsOff = checkBB.__offset(checkColl, 6);
        if (metaChanged) {
            if (!checkMetaOff) return { body: null, log: "WK3 alerts: skipped (self-check meta absent)" };
            const checkMeta = checkBB.__indirect(checkColl + checkMetaOff);
            const mOff = f => checkBB.__offset(checkMeta, 4 + f * 2);
            for (const [f, k] of [[0, "attributionUrl"], [2, "language"], [5, "providerLogo"], [6, "providerName"]]) {
                const want = mergedMeta[k];
                if (want == null) continue;
                const off = mOff(f);
                if (!off || checkBB.__string(checkMeta + off) !== want) return { body: null, log: `WK3 alerts: skipped (self-check meta ${k})` };
            }
            for (const [f, k] of [[1, "expireTime"], [7, "readTime"], [8, "reportedTime"]]) {
                const want = mergedMeta[k];
                if (want == null) continue;
                const off = mOff(f);
                if (!off || checkBB.readInt32(checkMeta + off) !== want) return { body: null, log: `WK3 alerts: skipped (self-check meta ${k})` };
            }
            for (const [f, k] of [[3, "latitude"], [4, "longitude"]]) {
                const want = mergedMeta[k];
                if (want == null) continue;
                const off = mOff(f);
                if (!off || checkBB.readFloat32(checkMeta + off) !== Math.fround(want)) return { body: null, log: `WK3 alerts: skipped (self-check meta ${k})` };
            }
            for (const [f, k] of [[9, "temporarilyUnavailable"], [10, "sourceType"]]) {
                const want = mergedMeta[k];
                if (want == null) continue;
                const off = mOff(f);
                if (!off || checkBB.readInt8(checkMeta + off) !== want) return { body: null, log: `WK3 alerts: skipped (self-check meta ${k})` };
            }
        } else if (collMetaOffset && !checkMetaOff) {
            return { body: null, log: "WK3 alerts: skipped (self-check meta lost)" };
        }
        if (detailsChanged) {
            if (!checkDetailsOff || checkBB.__string(checkColl + checkDetailsOff) !== mergedDetailsUrl) return { body: null, log: "WK3 alerts: skipped (self-check detailsUrl)" };
        } else if (collDetailsOffset && !checkDetailsOff) {
            return { body: null, log: "WK3 alerts: skipped (self-check detailsUrl lost)" };
        }
        // 其余槽位仍在场（根重定基未丢槽）。
        for (let slot = 0; slot < 15; slot++) {
            const origOff = ByteBuffer.__offset(rootPos, 4 + slot * 2);
            const newOff = checkBB.__offset(checkRoot, 4 + slot * 2);
            if (!!origOff !== !!newOff) return { body: null, log: `WK3 alerts: skipped (self-check slot ${slot} presence)` };
        }
        const filledDesc = [];
        for (let i = 0; i < alertCount; i++) {
            const ch = changes[i];
            if (!ch.strings.size && !ch.times.size && !ch.enums.size && !ch.responses) continue;
            const parts = [];
            if (ch.strings.has(5)) parts.push(`description="${appleAlerts[i].description}"`);
            if (ch.times.has(10)) parts.push(`onset=${appleAlerts[i].eventOnsetTime}`);
            if (ch.times.has(11)) parts.push(`end=${appleAlerts[i].eventEndTime}`);
            if (ch.responses) parts.push(`responses=[${appleAlerts[i].responses.join(",")}]`);
            filledDesc.push(`alert${i}(${parts.join(",")})`);
        }
        if (metaChanged) for (const k of metaChangedKeys) {
            const v = mergedMeta[k];
            filledDesc.push(`meta ${k}=${typeof v === "string" ? `"${v}"` : v}`);
        }
        if (detailsChanged) filledDesc.push(`detailsUrl="${mergedDetailsUrl}"`);
        return { body: out, log: `WK3 alerts: ${providerName} ${alertCount} alerts, ${providerAlerts.length} provider alerts, filled ${filledDesc.join("; ")} body ${rawBody.length}->${out.length}` };
    } catch (error) {
        return { body: null, log: `WK3 alerts: skipped (${error?.message ?? error})` };
    }
}

/**
 * WK3 实验探针 v3：只读，不解码、不重编码、不改包体。
 * 在 v2 的根表槽位清单基础上新增三类只读信息，全部带越界与合理性校验，
 * 任一读数失败只跳过该项，绝不影响透传：
 * - 2 字段包装表：字段1 的向量长度与首元素表字段数（区分每日/小时/历史对比等）；
 * - 空气质量 slot0：category / index；当前天气 slot1：asOf / humidity / pressure
 *   与候选温度字段 f25 / f26 / f27 / f31 / f32 的浮点值（温度字段尚未最终证实，
 *   日志里只记数值、不下结论）；
 * - 下一小时 slot5：forecastStart / forecastEnd 与 minutes 向量长度；
 *   预警 slot9：alerts 向量长度。
 * 不调用 WeatherKit2.decode / encode，不写 $response.body。
 * @param {import("flatbuffers").ByteBuffer} ByteBuffer - 已按 rawBody 建好的 ByteBuffer
 * @param {number} rawBodyLength - 原始包体字节数，用于越界保护
 * @returns {string[]} 日志行
 */
function dumpWK3Root(ByteBuffer, rawBodyLength) {
    const fieldOffsetOf = (tablePos, index) => {
        try {
            return ByteBuffer.__offset(tablePos, 4 + index * 2);
        } catch {
            return 0;
        }
    };
    const readFloat = (tablePos, index) => {
        const offset = fieldOffsetOf(tablePos, index);
        if (!offset) return null;
        try {
            const value = ByteBuffer.readFloat32(tablePos + offset);
            return Number.isFinite(value) ? value : null;
        } catch {
            return null;
        }
    };
    const readUint = (tablePos, index) => {
        const offset = fieldOffsetOf(tablePos, index);
        if (!offset) return null;
        try {
            return ByteBuffer.readUint32(tablePos + offset);
        } catch {
            return null;
        }
    };
    const readInt8 = (tablePos, index) => {
        const offset = fieldOffsetOf(tablePos, index);
        if (!offset) return null;
        try {
            return ByteBuffer.readInt8(tablePos + offset);
        } catch {
            return null;
        }
    };
    const readInt16 = (tablePos, index) => {
        const offset = fieldOffsetOf(tablePos, index);
        if (!offset) return null;
        try {
            return ByteBuffer.readInt16(tablePos + offset);
        } catch {
            return null;
        }
    };
    const vectorInfo = (tablePos, index) => {
        const offset = fieldOffsetOf(tablePos, index);
        if (!offset) return null;
        try {
            const vecPos = tablePos + offset + ByteBuffer.readInt32(tablePos + offset);
            if (vecPos < 0 || vecPos + 4 > rawBodyLength) return null;
            const len = ByteBuffer.readInt32(vecPos);
            if (len < 0 || len > 1000 || vecPos + 4 + len * 4 > rawBodyLength) return null;
            let elemFields = null;
            if (len > 0) {
                const elemPos = vecPos + 4;
                const elemTarget = elemPos + ByteBuffer.readInt32(elemPos);
                if (elemTarget >= 0 && elemTarget < rawBodyLength) {
                    const elemVtableLength = ByteBuffer.readUint16(elemTarget - ByteBuffer.readInt32(elemTarget));
                    const count = Math.floor((elemVtableLength - 4) / 2);
                    if (elemVtableLength >= 4 && count > 0 && count <= 64) elemFields = count;
                }
            }
            return { len, elemFields };
        } catch {
            return null;
        }
    };
    const fmtFloat = value => (value === null ? "?" : value.toFixed(2));
    try {
        const rootPos = ByteBuffer.readInt32(ByteBuffer.position()) + ByteBuffer.position();
        const vtablePos = rootPos - ByteBuffer.readInt32(rootPos);
        const vtableLength = ByteBuffer.readUint16(vtablePos);
        const fieldCount = Math.floor((vtableLength - 4) / 2);
        if (vtableLength === 4) {
            // 空根表（如中国大陆单项下一小时）：不是失败，是数据为空。
            return [`WK3 root: empty (fields=0) bodyLength=${rawBodyLength}`];
        }
        if (vtableLength < 4 || fieldCount <= 0 || fieldCount > 64) {
            return [`WK3 slot dump failed: unexpected root vtable length ${vtableLength}`];
        }
        const lines = [`WK3 root: fields=${fieldCount} bodyLength=${rawBodyLength}`];
        let cwTablePos = null;
        let nextHourTablePos = null;
        let alertsTablePos = null;
        for (let slot = 0; slot < fieldCount; slot++) {
            const fieldOffset = ByteBuffer.__offset(rootPos, 4 + slot * 2);
            if (!fieldOffset) {
                lines.push(`WK3 slot ${slot}: absent`);
                continue;
            }
            const tablePos = ByteBuffer.__indirect(rootPos + fieldOffset);
            if (tablePos < 0 || tablePos >= rawBodyLength) {
                lines.push(`WK3 slot ${slot}: out-of-range table`);
                continue;
            }
            const subVtablePos = tablePos - ByteBuffer.readInt32(tablePos);
            const subVtableLength = ByteBuffer.readUint16(subVtablePos);
            const subFieldCount = Math.floor((subVtableLength - 4) / 2);
            if (subVtableLength < 4 || subFieldCount <= 0 || subFieldCount > 64) {
                lines.push(`WK3 slot ${slot}: unexpected subtable vtable length ${subVtableLength}`);
                continue;
            }
            if (slot === 1) cwTablePos = tablePos;
            if (slot === 5) nextHourTablePos = tablePos;
            if (slot === 9) alertsTablePos = tablePos;
            const strings = [];
            for (let sub = 0; sub < subFieldCount && strings.length < 3; sub++) {
                const subOffset = ByteBuffer.__offset(tablePos, 4 + sub * 2);
                if (!subOffset) continue;
                try {
                    const value = ByteBuffer.__string(tablePos + subOffset);
                    if (typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("�") && [...value].every(ch => ch.codePointAt(0) >= 32)) {
                        strings.push(value.slice(0, 120));
                    }
                } catch {
                    // 非字符串字段按 __string 读会失败或出乱码，直接跳过，不影响透传。
                }
            }
            let extra = "";
            if (slot === 0) {
                const category = readInt8(tablePos, 1);
                const index = readInt16(tablePos, 2);
                if (category !== null && index !== null) extra += ` aqCategory=${category} aqIndex=${index}`;
            }
            if (subFieldCount === 2) {
                const vec = vectorInfo(tablePos, 1);
                if (vec) extra += ` vec1Len=${vec.len}${vec.elemFields !== null ? ` elem0Fields=${vec.elemFields}` : ""}`;
            }
            lines.push(`WK3 slot ${slot}: fields=${subFieldCount}${strings.length ? ` strings=[${strings.join(" | ")}]` : ""}${extra}`);
        }
        if (cwTablePos !== null) {
            lines.push(
                `WK3 cw: asOf=${readUint(cwTablePos, 2) ?? "?"} humidity=${readInt8(cwTablePos, 8) ?? "?"} pressure=${fmtFloat(readFloat(cwTablePos, 23))} f25=${fmtFloat(readFloat(cwTablePos, 25))} f26=${fmtFloat(readFloat(cwTablePos, 26))} f27=${fmtFloat(readFloat(cwTablePos, 27))} f31=${fmtFloat(readFloat(cwTablePos, 31))} f32=${fmtFloat(readFloat(cwTablePos, 32))}`,
            );
        }
        if (nextHourTablePos !== null) {
            const minutes = vectorInfo(nextHourTablePos, 5);
            lines.push(
                `WK3 nextHour: start=${readUint(nextHourTablePos, 3) ?? "?"} end=${readUint(nextHourTablePos, 4) ?? "?"} minutesLen=${minutes ? minutes.len : "?"} minutesElem0Fields=${minutes && minutes.elemFields !== null ? minutes.elemFields : "?"}`,
            );
        }
        if (alertsTablePos !== null) {
            const alerts = vectorInfo(alertsTablePos, 2);
            if (alerts) lines.push(`WK3 alerts: vecLen=${alerts.len}${alerts.elemFields !== null ? ` elem0Fields=${alerts.elemFields}` : ""}`);
        }
        return lines;
    } catch (error) {
        return [`WK3 slot dump failed: ${error?.message ?? error}`];
    }
}

/**
 * 注入当前天气数据
 * @param {any} currentWeather - 当前天气数据对象
 * @param {import('../types').Settings} Settings - 设置对象
 * @param {any} enviroments - 环境变量
 * @returns {Promise<any>} 注入后的当前天气数据
 */
async function InjectCurrentWeather(currentWeather, Settings, enviroments) {
    Console.info("☑️ InjectCurrentWeather");
    if (!Settings?.Weather?.Replace?.includes(enviroments.country)) {
        Console.warn("InjectCurrentWeather", `Unreplaced country: ${enviroments.country}`);
        Console.info("✅ InjectCurrentWeather");
        return currentWeather;
    }
    let newCurrentWeather;
    switch (Settings?.Weather?.Provider) {
        case "WeatherKit":
        default:
            break;
        case "QWeather": {
            newCurrentWeather = await enviroments.qWeather.WeatherNow();
            break;
        }
        case "ColorfulClouds": {
            newCurrentWeather = await enviroments.colorfulClouds.CurrentWeather();
            break;
        }
    }
    if (newCurrentWeather?.metadata) {
        newCurrentWeather.metadata = { ...currentWeather?.metadata, ...newCurrentWeather.metadata };
        currentWeather = { ...currentWeather, ...newCurrentWeather };
        currentWeather.metadata.providerLogo ||= providerNameToLogo(currentWeather.metadata.providerName);
    }
    Console.info("✅ InjectCurrentWeather");
    return currentWeather;
}

/**
 * 注入每日天气预报数据
 * @param {any} forecastDaily - 每日预报数据对象
 * @param {import('../types').Settings} Settings - 设置对象
 * @param {any} enviroments - 环境变量
 * @returns {Promise<any>} 注入后的每日预报数据
 */
async function InjectForecastDaily(forecastDaily, Settings, enviroments) {
    Console.info("☑️ InjectForecastDaily");
    if (!Settings?.Weather?.Replace?.includes(enviroments.country)) {
        Console.warn("InjectForecastDaily", `Unreplaced country: ${enviroments.country}`);
        Console.info("✅ InjectForecastDaily");
        return forecastDaily;
    }
    let newForecastDaily;
    switch (Settings?.Weather?.Provider) {
        case "WeatherKit":
        default:
            break;
        case "QWeather": {
            newForecastDaily = await enviroments.qWeather.Daily();
            break;
        }
        case "ColorfulClouds": {
            const dailysteps = forecastDaily?.days?.length || 11;
            const begin = forecastDaily?.days?.[0]?.forecastStart;
            newForecastDaily = await enviroments.colorfulClouds.Daily(dailysteps, begin);
            break;
        }
    }
    if (newForecastDaily?.metadata) {
        forecastDaily.metadata = { ...forecastDaily?.metadata, ...newForecastDaily.metadata };
        Weather.mergeForecast(forecastDaily?.days, newForecastDaily?.days);
        forecastDaily.metadata.providerLogo ||= providerNameToLogo(forecastDaily.metadata.providerName);
    }
    Console.info("✅ InjectForecastDaily");
    return forecastDaily;
}

/**
 * 注入小时天气预报数据
 * @param {any} forecastHourly - 小时预报数据对象
 * @param {import('../types').Settings} Settings - 设置对象
 * @param {any} enviroments - 环境变量
 * @returns {Promise<any>} 注入后的小时预报数据
 */
async function InjectForecastHourly(forecastHourly, Settings, enviroments) {
    Console.info("☑️ InjectForecastHourly");
    if (!Settings?.Weather?.Replace?.includes(enviroments.country)) {
        Console.warn("InjectForecastHourly", `Unreplaced country: ${enviroments.country}`);
        Console.info("✅ InjectForecastHourly");
        return forecastHourly;
    }
    let newForecastHourly;
    switch (Settings?.Weather?.Provider) {
        case "WeatherKit":
        default:
            break;
        case "QWeather": {
            newForecastHourly = await enviroments.qWeather.Hourly();
            break;
        }
        case "ColorfulClouds": {
            const hourlysteps = forecastHourly?.hours?.length || 273;
            const begin = forecastHourly?.hours?.[0]?.forecastStart;
            newForecastHourly = await enviroments.colorfulClouds.ForecastHourly(hourlysteps, begin);
            break;
        }
    }
    if (newForecastHourly?.metadata) {
        forecastHourly.metadata = { ...forecastHourly?.metadata, ...newForecastHourly.metadata };
        forecastHourly.hours = Weather.mergeForecast(forecastHourly?.hours, newForecastHourly?.hours);
        forecastHourly.metadata.providerLogo ||= providerNameToLogo(forecastHourly.metadata.providerName);
    }
    Console.info("✅ InjectForecastHourly");
    return forecastHourly;
}

/**
 * 注入下一小时天气预报数据
 * @param {any} forecastNextHour - 下一小时预报数据对象
 * @param {import('../types').Settings} Settings - 设置对象
 * @param {any} enviroments - 环境变量
 * @returns {Promise<any>} 注入后的下一小时预报数据
 */
async function InjectForecastNextHour(forecastNextHour, Settings, enviroments) {
    Console.info("☑️ InjectForecastNextHour");

    if (forecastNextHour) {
        Console.info("✅ InjectForecastNextHour");
        return forecastNextHour;
    }

    let newForecastNextHour;
    switch (Settings?.NextHour?.Provider) {
        case "WeatherKit":
            break;
        case "QWeather": {
            newForecastNextHour = await enviroments.qWeather.Minutely();
            break;
        }
        case "ColorfulClouds":
        default: {
            newForecastNextHour = await enviroments.colorfulClouds.Minutely();
            break;
        }
    }
    if (newForecastNextHour?.metadata) {
        newForecastNextHour.metadata = { ...forecastNextHour?.metadata, ...newForecastNextHour.metadata };
        forecastNextHour = { ...forecastNextHour, ...newForecastNextHour };
        forecastNextHour.metadata.providerLogo ||= providerNameToLogo(forecastNextHour.metadata.providerName);
    }
    Console.info("✅ InjectForecastNextHour");
    return forecastNextHour;
}

/**
 * 补全预警数据
 * @param {any} weatherAlerts - 预警集合数据对象
 * @param {import('../types').Settings} Settings - 设置对象
 * @param {any} enviroments - 环境变量
 * @returns {Promise<any>} 补全后的预警集合数据
 */
async function InjectWeatherAlerts(weatherAlerts, Settings, enviroments) {
    Console.info("☑️ InjectWeatherAlerts");
    const isNationalWarningCenter = ["国家预警信息发布中心", "國家預警信息發布中心", "National Early Warning Center"].includes(weatherAlerts?.metadata?.providerName);
    let newWeatherAlerts;
    switch (Settings?.WeatherAlerts?.Provider) {
        case "WeatherKit": {
            break;
        }
        case "ColorfulClouds": {
            if (isNationalWarningCenter) newWeatherAlerts = await enviroments.colorfulClouds.WeatherAlert();
            break;
        }
        case "QWeather": {
            if (isNationalWarningCenter) newWeatherAlerts = await enviroments.qWeather.WeatherAlert();
            break;
        }
        case "QWeatherWeb":
        default: {
            newWeatherAlerts = await enviroments.qWeather.WeatherAlertWeb(weatherAlerts?.detailsUrl);
            break;
        }
    }
    if (newWeatherAlerts?.metadata) {
        weatherAlerts.metadata = { ...weatherAlerts?.metadata, ...newWeatherAlerts.metadata };
        weatherAlerts.detailsUrl = newWeatherAlerts.detailsUrl ?? weatherAlerts.detailsUrl;
        weatherAlerts.alerts = WeatherAlerts.mergeAlerts(weatherAlerts?.alerts, newWeatherAlerts?.alerts);
        weatherAlerts.metadata.providerLogo ||= providerNameToLogo(weatherAlerts.metadata.providerName);
    }
    Console.info("✅ InjectWeatherAlerts");
    return weatherAlerts;
}

/**
 * 注入并合并空气质量数据（污染物、指数、昨日对比）
 * @param {any} airQuality - WeatherKit 原始空气质量对象
 * @param {import('../types').Settings} Settings - 设置对象
 * @param {any} Caches - 缓存对象
 * @param {any} enviroments - 各数据源实例与定位信息
 * @returns {Promise<any>} 合并后的空气质量对象
 */
async function InjectAirQuality(airQuality, Settings, Caches, enviroments) {
    // Step1. 修复污染物单位
    // Step 1. Fix pollutant units.
    airQuality = AirQuality.FixPollutantsUnits(airQuality);

    // Step2. 判断原始污染物是否为空，并在需要时注入污染物数据
    const isPollutantEmpty = !Array.isArray(airQuality?.pollutants) || airQuality.pollutants.length === 0;
    const injectedPollutants = isPollutantEmpty ? await InjectPollutants(Settings, enviroments) : airQuality;
    const needPollutants = isPollutantEmpty && !!(injectedPollutants?.metadata && !injectedPollutants.metadata.temporarilyUnavailable);

    // Step3. 根据污染物补齐情况与替换配置，决定是否注入 AQI 指数
    const needInjectIndex = needPollutants || Settings?.AirQuality?.Current?.Index?.Replace?.some(scaleName => AirQuality.ScaleMatches(airQuality?.scale, scaleName));
    const injectedIndex = needInjectIndex ? await InjectIndex(injectedPollutants, Settings, enviroments) : injectedPollutants;

    // Step4. 计算昨日对比是否需要重算；若未知则注入昨日对比结果
    const weatherKitComparison = airQuality?.previousDayComparison ?? AirQuality.Config.CompareCategoryIndexes.UNKNOWN;
    const previousDayComparison = needInjectIndex && Settings?.AirQuality?.Comparison?.ReplaceWhenCurrentChange ? AirQuality.Config.CompareCategoryIndexes.UNKNOWN : weatherKitComparison;
    const needInjectComparison = previousDayComparison === AirQuality.Config.CompareCategoryIndexes.UNKNOWN;
    const currentIndexProvider = needInjectIndex ? Settings?.AirQuality?.Current?.Index?.Provider : "WeatherKit";
    const injectedComparison = needInjectComparison ? await InjectComparison(injectedIndex, currentIndexProvider, Settings, Caches, enviroments) : { ...injectedIndex, previousDayComparison: weatherKitComparison };

    // Step5. 收集各阶段元数据，拼接最终 providerName 展示文案
    const weatherKitMetadata = airQuality?.metadata;
    const pollutantMetadata = injectedPollutants?.metadata;
    const indexMetadata = injectedIndex?.metadata;
    const comparisonMetadata = injectedComparison?.metadata;
    const providers = [
        ...(weatherKitMetadata?.providerName && !weatherKitMetadata.temporarilyUnavailable ? [weatherKitMetadata.providerName] : []),
        ...(needPollutants && pollutantMetadata?.providerName && !pollutantMetadata.temporarilyUnavailable ? [`污染物：${pollutantMetadata.providerName}`] : []),
        ...(needInjectIndex && indexMetadata?.providerName && !indexMetadata.temporarilyUnavailable ? [`指数：${AirQuality.appendScaleToProviderName(injectedIndex, Settings)}`] : []),
        ...(needInjectComparison && comparisonMetadata?.providerName && !comparisonMetadata.temporarilyUnavailable ? [`对比昨日：\n${comparisonMetadata.providerName}`] : []),
    ];

    // Step6. 选取首个有效 provider，生成统一 logo
    const providerLogo = providerNameToLogo(weatherKitMetadata?.providerName || pollutantMetadata?.providerName || indexMetadata?.providerName || comparisonMetadata?.providerName);

    // Step7. 合并输出：优先使用可用注入结果，并统一 metadata / pollutants / previousDayComparison
    airQuality = {
        ...airQuality,
        ...(injectedIndex?.metadata && !injectedIndex.metadata.temporarilyUnavailable ? injectedIndex : {}),
        metadata: {
            ...(airQuality?.metadata ? airQuality.metadata : injectedPollutants?.metadata),
            providerName: providers.join("\n"),
            ...(providerLogo ? { providerLogo } : {}),
        },
        pollutants: AirQuality.ConvertPollutants(airQuality, injectedPollutants, needInjectIndex, injectedIndex, Settings) ?? [],
        previousDayComparison: injectedComparison?.previousDayComparison ?? AirQuality.Config.CompareCategoryIndexes.UNKNOWN,
    };
    Console.debug(`airQuality: ${JSON.stringify(airQuality, null, 2)}`);
    return airQuality;
}

async function InjectPollutants(Settings, enviroments) {
    Console.info("☑️ InjectPollutants");

    switch (Settings?.AirQuality?.Current?.Pollutants?.Provider) {
        case "QWeather": {
            const currentAirQuality = await enviroments.qWeather.CurrentAirQuality();
            Console.info("✅ InjectPollutants");
            return currentAirQuality;
        }
        case "ColorfulClouds":
        default: {
            const currentAirQuality = await enviroments.colorfulClouds.CurrentAirQuality();
            Console.info("✅ InjectPollutants");
            return currentAirQuality;
        }
    }
}

/**
 * 注入空气质量数据
 * @param {any} airQuality - 空气质量数据对象
 * @param {import('../types').Settings} Settings - 设置对象
 * @param {any} enviroments - 环境变量
 * @returns {Promise<any>} 注入后的空气质量数据
 */
async function InjectIndex(airQuality, Settings, enviroments) {
    Console.info("☑️ InjectIndex");

    switch (Settings?.AirQuality?.Current?.Index?.Provider) {
        case "QWeather": {
            const currentAirQuality = await enviroments.qWeather.CurrentAirQuality(Settings.AirQuality.Current.Index.ForceCNPrimaryPollutants);
            Console.info("✅ InjectIndex");
            return currentAirQuality;
        }
        case "ColorfulCloudsUS":
        case "ColorfulCloudsCN": {
            const currentAirQuality = await enviroments.colorfulClouds.CurrentAirQuality(Settings.AirQuality.Current.Index.Provider === "ColorfulCloudsUS", Settings.AirQuality.Current.Index.ForceCNPrimaryPollutants);
            Console.info("✅ InjectIndex");
            return currentAirQuality;
        }
        case "Calculate":
        default: {
            const currentAirQuality = AirQuality.Pollutants2AQI(airQuality, Settings);
            Console.info("✅ InjectIndex");
            return currentAirQuality;
        }
        // TODO
        case "WAQI": {
            if (Settings?.API?.WAQI?.Token) {
                return await enviroments.waqi.AQI2();
            } else {
                const Nearest = await enviroments.waqi.Nearest();
                const Token = await enviroments.waqi.Token(Nearest?.metadata?.stationId);
                //Caches.WAQI.set(stationId, Token);
                const aqi = await enviroments.waqi.AQI(Nearest?.metadata?.stationId, Token);

                return {
                    metadata: { ...Nearest?.metadata, ...aqi?.metadata },
                    ...Nearest,
                    ...aqi,
                };
            }
        }
    }
}

async function InjectComparison(airQuality, currentIndexProvider, Settings, Caches, enviroments) {
    Console.info("☑️ InjectComparison");

    const { UNKNOWN } = AirQuality.Config.CompareCategoryIndexes;

    /**
     * HJ 633—2012
     * [环境空气质量指数（AQI）技术规定（试行）_中华人民共和国生态环境部]{@link https://www.mee.gov.cn/ywgz/fgbz/bz/bzwb/jcffbz/201203/t20120302_224166.shtml}
     */
    const isHJ6332012 = (currentIndexProvider, currentScale, Settings) => {
        Console.info("☑️ isHJ6332012", `currentIndexProvider: ${currentIndexProvider}`);

        switch (currentIndexProvider) {
            case "Calculate": {
                Console.debug(`Settings?.AirQuality?.Calculate?.Algorithm: ${Settings?.AirQuality?.Calculate?.Algorithm}`);
                const result = Settings?.AirQuality?.Calculate?.Algorithm === "WAQI_InstantCast_CN";
                Console.info("✅ isHJ6332012", result);
                return result;
            }
            case "QWeather":
            case "ColorfulCloudsCN": {
                Console.info("✅ isHJ6332012", true);
                return true;
            }
            case "WeatherKit": {
                const result = AirQuality.ScaleMatches(currentScale, AirQuality.Config.Scales.HJ6332012.weatherKitScale.name);
                Console.info("✅ isHJ6332012", result);
                return result;
            }
            default: {
                Console.info("✅ isHJ6332012", false);
                return false;
            }
        }
    };
    /**
     * EPA 454/B-18-007
     * [Technical Assistance Document for the Reporting of Daily Air Quality – the Air Quality Index (AQI)]{@link https://www.airnow.gov/sites/default/files/2020-05/aqi-technical-assistance-document-sept2018.pdf}
     */
    const isEPA454_B18007 = currentIndexProvider => {
        Console.info("☑️ isHJ6332012", `currentIndexProvider: ${currentIndexProvider}`);

        switch (currentIndexProvider) {
            case "WAQI":
            case "ColorfulCloudsUS": {
                Console.info("✅ isHJ6332012", true);
                return true;
            }
            default: {
                Console.info("✅ isHJ6332012", false);
                return false;
            }
        }
    };

    const colorfulCloudsComparison = async (useUsa, currentCategoryIndex) => {
        Console.info("☑️ colorfulCloudsComparison", `currentCategoryIndex: ${currentCategoryIndex}`);
        const yesterdayAirQuality = await enviroments.colorfulClouds.YesterdayAirQuality(useUsa);

        const getMetadata = (temporarilyUnavailable = false) => ({
            ...yesterdayAirQuality.metadata,
            providerName: `指数：${AirQuality.appendScaleToProviderName(yesterdayAirQuality)}`,
            temporarilyUnavailable,
        });

        if (!yesterdayAirQuality.metadata.temporarilyUnavailable) {
            if (currentCategoryIndex) {
                const comparisonAirQuality = {
                    ...yesterdayAirQuality,
                    metadata: getMetadata(false),
                    previousDayComparison: AirQuality.CompareCategoryIndexes(currentCategoryIndex, yesterdayAirQuality.categoryIndex),
                };
                Console.info("✅ colorfulCloudsComparison");
                return comparisonAirQuality;
            } else {
                const colorfulCloudsCurrent = await enviroments.colorfulClouds.CurrentAirQuality(useUsa);
                if (!colorfulCloudsCurrent.metadata.temporarilyUnavailable) {
                    Console.debug(`colorfulCloudsCurrent?.index: ${colorfulCloudsCurrent?.index}`);
                    const comparisonAirQuality = {
                        ...yesterdayAirQuality,
                        metadata: getMetadata(false),
                        previousDayComparison: AirQuality.CompareCategoryIndexes(colorfulCloudsCurrent.categoryIndex, yesterdayAirQuality.categoryIndex),
                    };
                    Console.info("✅ colorfulCloudsComparison");
                    return comparisonAirQuality;
                }
            }
        }

        Console.error("colorfulCloudsComparison", `无法从彩云天气获取${yesterdayAirQuality.metadata.temporarilyUnavailable ? "昨日" : "今日"}的空气质量数据`);
        return {
            ...yesterdayAirQuality,
            metadata: getMetadata(true),
            previousDayComparison: UNKNOWN,
        };
    };
    const qweatherComparison = async (currentCategoryIndex, pollutantsToAirQuality) => {
        Console.info("☑️ qweatherComparison", `currentCategoryIndex: ${currentCategoryIndex}`);
        const setQWeatherCache = qweatherCache => {
            Caches.qweather = qweatherCache;
            Storage.setItem("@iRingo.WeatherKit.Caches", { ...Caches, qweather: qweatherCache });
        };

        const locationsGrid = await QWeather.GetLocationsGrid(Caches?.qweather, setQWeatherCache);
        const { latitude, longitude } = enviroments.qWeather;
        const locationInfo = QWeather.GetLocationInfo(locationsGrid, latitude, longitude);

        const yesterdayQWeather = await enviroments.qWeather.YesterdayAirQuality(locationInfo);

        const getMetadata = (indexProvider, temporarilyUnavailable = false) => ({
            ...yesterdayQWeather.metadata,
            providerName: `污染物：和风天气，指数：${indexProvider}`,
            temporarilyUnavailable,
        });

        if (!yesterdayQWeather.metadata.temporarilyUnavailable) {
            const airQualityFromPollutants = pollutantsToAirQuality(yesterdayQWeather);
            const yesterdayAirQuality = pollutantsToAirQuality
                ? {
                      ...airQualityFromPollutants,
                      metadata: {
                          ...airQualityFromPollutants.metadata,
                          providerName: AirQuality.appendScaleToProviderName(airQualityFromPollutants, Settings),
                      },
                  }
                : {
                      ...yesterdayQWeather,
                      metadata: {
                          ...yesterdayQWeather.metadata,
                          providerName: AirQuality.appendScaleToProviderName(yesterdayQWeather),
                      },
                  };

            if (currentCategoryIndex) {
                const comparisonAirQuality = {
                    ...yesterdayQWeather,
                    metadata: getMetadata(yesterdayAirQuality.metadata.providerName, false),
                    previousDayComparison: AirQuality.CompareCategoryIndexes(currentCategoryIndex, yesterdayAirQuality.categoryIndex),
                };
                Console.info("✅ qweatherComparison");
                return comparisonAirQuality;
            } else {
                const qweatherCurrent = await enviroments.qWeather.CurrentAirQuality(locationInfo);
                if (!qweatherCurrent.metadata.temporarilyUnavailable) {
                    Console.debug(`qweatherCurrent?.index: ${qweatherCurrent?.index}`);

                    const comparisonAirQuality = {
                        ...yesterdayQWeather,
                        metadata: getMetadata(yesterdayAirQuality.metadata.providerName, false),
                        previousDayComparison: AirQuality.CompareCategoryIndexes(qweatherCurrent.categoryIndex, yesterdayAirQuality.categoryIndex),
                    };
                    Console.info("✅ qweatherComparison");
                    return comparisonAirQuality;
                }
            }
        }

        Console.error("qweatherComparison", `无法从和风天气获取${yesterdayQWeather.metadata.temporarilyUnavailable ? "昨日" : "今日"}空气质量数据`);
        return {
            ...yesterdayQWeather,
            metadata: getMetadata(yesterdayQWeather.metadata.providerName, true),
            previousDayComparison: UNKNOWN,
        };
    };

    switch (Settings?.AirQuality?.Comparison?.Yesterday?.IndexProvider) {
        case "Calculate": {
            const algorithm = AirQuality.chooseAlogrithm(airQuality, Settings);
            const PollutantsProvider = Settings?.AirQuality?.Comparison?.Yesterday?.PollutantsProvider;
            Console.debug(`Settings?.AirQuality?.Comparison?.Yesterday?.PollutantsProvider: ${PollutantsProvider}`);

            if (algorithm !== "") {
                switch (PollutantsProvider) {
                    case "QWeather":
                    default: {
                        const pollutantsToAirQuality = airQuality => AirQuality.Pollutants2AQI(airQuality, Settings, { algorithm });
                        const comparisonAirQuality = await qweatherComparison(airQuality?.categoryIndex, pollutantsToAirQuality);
                        Console.info("✅ InjectComparison");
                        return comparisonAirQuality;
                    }
                }
            }

            Console.error("InjectComparison", "不支持今日空气质量的标准");
            return { metadata: { providerName: "iRingo", temporarilyUnavailable: true }, previousDayComparison: UNKNOWN };
        }
        case "QWeather": {
            const comparisonAirQuality = await qweatherComparison(isHJ6332012(currentIndexProvider, airQuality?.scale, Settings) ? airQuality?.categoryIndex : undefined);
            Console.info("✅ InjectComparison");
            return comparisonAirQuality;
        }
        case "ColorfulCloudsCN": {
            // Use injected AQI or ColorfulClouds AQI depends on data source
            const comparisonAirQuality = colorfulCloudsComparison(false, isHJ6332012(currentIndexProvider, airQuality?.scale, Settings) ? airQuality?.categoryIndex : undefined);
            Console.info("✅ InjectComparison");
            return comparisonAirQuality;
        }
        case "ColorfulCloudsUS":
        default: {
            const comparisonAirQuality = colorfulCloudsComparison(true, isEPA454_B18007(currentIndexProvider) ? airQuality?.categoryIndex : undefined);
            Console.info("✅ InjectComparison");
            return comparisonAirQuality;
        }
    }
}

// ---- WK3 NextHour fill (beta14 candidate, offline-verified on Beijing/Tokyo bodies) ----
// WK3 NextHour fill prototype (beta14 candidate).
// Builds a whole slot-5 table from a provider Minutely object and splices it
// into the root as a NEW slot (fill-only: caller gates on slot 5 absent).
// Layout rule (beta10 lesson): every vector precedes its element tables;
// all element uoffsets are forward (small positive).

const CONDITION_TYPE = {
    CLEAR: 0, SLEET: 3, POSSIBLE_SLEET: 4, HEAVY_RAIN: 5, RAIN: 6,
    DRIZZLE: 7, POSSIBLE_DRIZZLE: 8, HEAVY_SNOW: 9, SNOW: 10,
};
const FORECAST_TOKEN = { CLEAR: 0, START: 1, STOP: 2, START_STOP: 3, STOP_START: 4, CONSTANT: 5 };
const PRECIPITATION_TYPE = { CLEAR: 0, RAIN: 1, SNOW: 2, SLEET: 3, HAIL: 4, MIXED: 6 };
const PARAMETER_TYPE = { FIRST_AT: 0, SECOND_AT: 1 };
const SOURCE_TYPE = { APPLE_INTERNAL: 0, MODELED: 1, STATION: 2 };


// 东京原表移植探针（beta6）：把 Capture 304 东京原体里的槽 5 子图
// （JMA 元数据 + 条件/摘要/分钟向量，83 分钟）整体搬进目标体；
// 只改窗口（移至今）、元数据经纬度（改目标城）与元数据三时间
// （保留原时长与上报-读取间隔）。不拉 provider、不调 fill。
// blob 布局：[NH vtable 16][NH 表 28] 开头，NH 表在 blob+16。
const TOKYO_NH_HEX = "10001c001800140010000c0008000400100000001c010000f400eb6a80edea6ae4000000b4000000200000001a00240020001c00000018001400000010000c0008000000070000001c00000000000002dcebea6a84edea6a6000000014ce0b439a190f4208f1ea6a040000004800000068747470733a2f2f646576656c6f7065722e6170706c652e636f6d2f776561746865726b69742f646174612d736f757263652d6174747269627574696f6e2d696e7465726e616c2f1b0000004a6170616e204d6574656f726f6c6f676963616c204167656e6379000100000014000000100010000c0000000b000a0009000400100000000c0000000007070680edea6a0000000001000000140000000e001400100000000c000b0004000000100000003358a140000000640800000080edea6a53000000580100007401000090010000ac010000c8010000e4010000000200001c0200003802000054020000700200008c020000a8020000c4020000e0020000fc0200001803000034030000500300006c03000088030000a4030000c0030000dc030000f803000014040000300400004c0400006804000084040000a0040000bc040000d8040000f4040000100500002c0500004805000064050000800500009c050000b8050000d4050000f00500000c0600002806000044060000600600007c06000098060000b4060000d0060000ec0600000807000024070000400700005c0700007807000094070000b0070000cc070000e807000004080000200800003c080000580800007408000090080000ac080000c8080000e4080000000900001c0900003809000054090000700900008c090000a8090000c4090000e0090000fc090000180a0000340a0000500a00000c00140010000f0008000400ccf5ffff9a99993f995fb43f0000006480edea6a0c00140010000f0008000400ecf5ffff17d99e3f815fc43f00000064bcedea6a0c00140010000f00080004000cf6ffff5839a43fbecad53f00000064f8edea6a0c00140010000f00080004002cf6ffff7f6aac3f1cdcf23f0000006434eeea6a0c00140010000f00080004004cf6ffff4a0cb23f7c3304400000006470eeea6a0c00140010000f00080004006cf6fffffa7eba3ff12c164000000064aceeea6a0c00140010000f00080004008cf6ffff4e62c03f207f234000000064e8eeea6a0c00140010000f0008000400acf6ffffa245c63fceff31400000006424efea6a0c00140010000f0008000400ccf6fffff628cc3fd0c941400000006460efea6a0c00140010000f0008000400ecf6ffff0e2dd23f5bfa5240000000649cefea6a0c00140010000f00080004000cf7ffff7d3fd53fe7225c4000000064d8efea6a0c00140010000f00080004002cf7ffffec51d83f3ab165400000006414f0ea6a0c00140010000f00080004004cf7ffff9643db3fc2a96f400000006450f0ea6a0c00140010000f00080004006cf7ffff9643db3fc2a96f40000000648cf0ea6a0c00140010000f00080004008cf7ffff0456de3f18117a4000000064c8f0ea6a0c00140010000f0008000400acf7ffff0456de3f18117a400000006404f1ea6a0c00140010000f0008000400ccf7ffff0456de3f18117a400000006440f1ea6a0c00140010000f0008000400ecf7ffff0456de3f18117a40000000647cf1ea6a0c00140010000f00080004000cf8ffff9643db3fc2a96f4000000064b8f1ea6a0c00140010000f00080004002cf8ffff9643db3fc2a96f4000000064f4f1ea6a0c00140010000f00080004004cf8ffff9643db3fc2a96f400000006430f2ea6a0c00140010000f00080004006cf8ffffec51d83f3ab16540000000646cf2ea6a0c00140010000f00080004008cf8ffff7d3fd53fe7225c4000000064a8f2ea6a0c00140010000f0008000400acf8ffff0e2dd23f5bfa524000000064e4f2ea6a0c00140010000f0008000400ccf8ffff643bcf3f55334a400000006420f3ea6a0c00140010000f0008000400ecf8fffff628cc3fd0c94140000000645cf3ea6a0c00140010000f00080004000cf9ffff4c37c93fdeb939400000006498f3ea6a0c00140010000f00080004002cf9ffffa245c63fceff314000000064d4f3ea6a0c00140010000f00080004004cf9ffff4e62c03f207f23400000006410f4ea6a0c00140010000f00080004006cf9fffffa7eba3ff12c1640000000644cf4ea6a0c00140010000f00080004008cf9ffff14aeb73f81ed0f400000006488f4ea6a0c00140010000f0008000400acf9ffff4a0cb23f7c33044000000064c4f4ea6a0c00140010000f0008000400ccf9ffff7f6aac3f1cdcf23f0000006400f5ea6a0c00140010000f0008000400ecf9ffff79e9a63f9412df3f000000643cf5ea6a0c00140010000f00080004000cfaffff5839a43fbecad53f0000006478f5ea6a0c00140010000f00080004002cfaffff17d99e3f815fc43f00000064b4f5ea6a0c00140010000f00080004004cfaffffba499c3f0c34bc3f00000064f0f5ea6a0c00140010000f00080004006cfaffff9a99993f995fb43f000000642cf6ea6a0c00140010000f00080004008cfaffff3d0a973f88deac3f0000006468f6ea6a0c00140010000f0008000400acfaffffa69b943f66ada53f00000064a4f6ea6a0c00140010000f0008000400ccfaffff4a0c923fdac89e3f00000064e0f6ea6a0c00140010000f0008000400ecfaffff4a0c923fdac89e3f000000641cf7ea6a0c00140010000f00080004000cfbffff4a0c923fdac89e3f0000006458f7ea6a0c00140010000f00080004002cfbffffa69b943f66ada53f0000006494f7ea6a0c00140010000f00080004004cfbffffa69b943f66ada53f00000064d0f7ea6a0c00140010000f00080004006cfbffff3d0a973f88deac3f000000640cf8ea6a0c00140010000f00080004008cfbffff9a99993f995fb43f0000006448f8ea6a0c00140010000f0008000400acfbffffba499c3f0c34bc3f0000006484f8ea6a0c00140010000f0008000400ccfbffff17d99e3f815fc43f00000064c0f8ea6a0c00140010000f0008000400ecfbffff5839a43fbecad53f00000064fcf8ea6a0c00140010000f00080004000cfcffff79e9a63f9412df3f0000006438f9ea6a0c00140010000f00080004002cfcffff7f6aac3f1cdcf23f0000006474f9ea6a0c00140010000f00080004004cfcffff4a0cb23f7c33044000000064b0f9ea6a0c00140010000f00080004006cfcffff2fddb43f9af0094000000064ecf9ea6a0c00140010000f00080004008cfcfffffa7eba3ff12c16400000006428faea6a0c00140010000f0008000400acfcffff4e62c03f207f23400000006464faea6a0c00140010000f0008000400ccfcfffff853c33f06982a4000000064a0faea6a0c00140010000f0008000400ecfcffff4c37c93fdeb9394000000064dcfaea6a0c00140010000f00080004000cfdfffff628cc3fd0c941400000006418fbea6a0c00140010000f00080004002cfdffff0e2dd23f5bfa52400000006454fbea6a0c00140010000f00080004004cfdffff7d3fd53fe7225c400000006490fbea6a0c00140010000f00080004006cfdffffec51d83f3ab1654000000064ccfbea6a0c00140010000f00080004008cfdffff9643db3fc2a96f400000006408fcea6a0c00140010000f0008000400acfdffff0456de3f18117a400000006444fcea6a0c00140010000f0008000400ccfdffff7368e13f017682400000006480fcea6a0c00140010000f0008000400ecfdffffa69be43fcb1f884000000064bcfcea6a0c00140010000f00080004000cfeffffa69be43fcb1f884000000064f8fcea6a0c00140010000f00080004002cfeffff14aee73f85088e400000006434fdea6a0c00140010000f00080004004cfeffff83c0ea3fea3294400000006470fdea6a0c00140010000f00080004006cfeffff83c0ea3fea32944000000064acfdea6a0c00140010000f00080004008cfeffff83c0ea3fea32944000000064e8fdea6a0c00140010000f0008000400acfefffff2d2ed3fcda19a400000006424feea6a0c00140010000f0008000400ccfefffff2d2ed3fcda19a400000006360feea6a0c00140010000f0008000400ecfefffff2d2ed3fcda19a40000000639cfeea6a0c00140010000f00080004000cffffff60e5f03f3358a14000000063d8feea6a0c00140010000f00080004002cffffff60e5f03f3358a1400000006314ffea6a0c00140010000f00080004004cffffff60e5f03f3358a1400000006350ffea6a0c00140010000f00080004006cffffff60e5f03f3358a140000000628cffea6a0c00140010000f00080004008cffffff60e5f03f3358a14000000062c8ffea6a0c00140010000f0008000400acffffff60e5f03f3358a140000000620400eb6a0c00140010000f0008000400ccffffff60e5f03f3358a140000000624000eb6a0c00140010000f0008000400ecffffff60e5f03f3358a140000000627c00eb6a0c00140010000f00080004000c00000060e5f03f3358a14000000061b800eb6a";
function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}
function utf8Bytes(str) {
    const s = unescape(encodeURIComponent(str));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}
function transplantWK3NextHour(ByteBuffer, rawBody) {
    const fail = (reason) => ({ body: null, log: `WK3 nhTransplant: skipped (${reason})` });
    try {
        const bb = ByteBuffer;
        const rootPos = bb.readInt32(bb.position()) + bb.position();
        const rootVtablePos = rootPos - bb.readInt32(rootPos);
        const rootVtableLen = bb.readUint16(rootVtablePos);
        const rootTableSize = bb.readUint16(rootVtablePos + 2);
        if (rootVtableLen !== 15 * 2 + 4) return fail("root not 15 fields");
        if (bb.__offset(rootPos, 4 + 5 * 2)) return fail("slot 5 present");
        // 目标城经纬度：取槽 0 AQ 元数据 float32 lat/lon（字段 3/4）
        const slot0Off = bb.__offset(rootPos, 4 + 0 * 2);
        if (!slot0Off) return fail("slot 0 absent");
        const aqTable = bb.__indirect(rootPos + slot0Off);
        const aqMetaOff = bb.__offset(aqTable, 4 + 0 * 2);
        if (!aqMetaOff) return fail("AQ metadata absent");
        const aqMeta = bb.__indirect(aqTable + aqMetaOff);
        const latOff = bb.__offset(aqMeta, 4 + 3 * 2);
        const lonOff = bb.__offset(aqMeta, 4 + 4 * 2);
        if (!latOff || !lonOff) return fail("AQ lat/lon absent");
        const dv = new DataView(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
        const targetLat = dv.getFloat32(aqMeta + latOff, true);
        const targetLon = dv.getFloat32(aqMeta + lonOff, true);
        if (!Number.isFinite(targetLat) || !Number.isFinite(targetLon)) return fail("AQ lat/lon not finite");
        // 复制移植 blob 并打补丁（字段偏移一律读各表自己的 vtable，东京打包与我方不同）
        const tpl = hexToBytes(TOKYO_NH_HEX);
        const td = new DataView(tpl.buffer);
        const nhPos = 16;
        const nhVt = nhPos - td.getInt32(nhPos, true);
        const fOff = (vt, f) => {
            const vlen = td.getUint16(vt, true);
            return (4 + f * 2 < vlen) ? td.getUint16(vt + 4 + f * 2, true) : 0;
        };
        const ind = (pos) => pos + td.getUint32(pos, true);
        const now = Math.trunc(Date.now() / 1000);
        const startOff = fOff(nhVt, 3);
        const endOff = fOff(nhVt, 4);
        if (!startOff || !endOff) return fail("NH window fields absent");
        const origStart = td.getInt32(nhPos + startOff, true);
        const origEnd = td.getInt32(nhPos + endOff, true);
        const delta = now - origStart;
        const shift = (tablePos, vtPos, field) => {
            const o = fOff(vtPos, field);
            if (o) td.setInt32(tablePos + o, td.getInt32(tablePos + o, true) + delta, true);
        };
        td.setInt32(nhPos + startOff, now, true);
        td.setInt32(nhPos + endOff, origEnd + delta, true);
        const metaOff = fOff(nhVt, 0);
        if (!metaOff) return fail("NH metadata absent");
        const metaPos = ind(nhPos + metaOff);
        const metaVt = metaPos - td.getInt32(metaPos, true);
        const mLat = fOff(metaVt, 3), mLon = fOff(metaVt, 4);
        const mExp = fOff(metaVt, 1), mRead = fOff(metaVt, 7), mRep = fOff(metaVt, 8);
        if (!mLat || !mLon || !mExp || !mRead || !mRep) return fail("metadata fields absent");
        const origRead = td.getInt32(metaPos + mRead, true);
        const origExp = td.getInt32(metaPos + mExp, true);
        const origRep = td.getInt32(metaPos + mRep, true);
        td.setFloat32(metaPos + mLat, Math.fround(targetLat), true);
        td.setFloat32(metaPos + mLon, Math.fround(targetLon), true);
        td.setInt32(metaPos + mRead, now, true);
        td.setInt32(metaPos + mRep, now - (origRead - origRep), true);
        td.setInt32(metaPos + mExp, now + (origExp - origRead), true);
        const walkVec = (fieldIdx, isCond, hasEndTime) => {
            const vo = fOff(nhVt, fieldIdx);
            if (!vo) return;
            const vecPos = ind(nhPos + vo);
            const n = td.getUint32(vecPos, true);
            for (let i = 0; i < n; i++) {
                const slot = vecPos + 4 + i * 4;
                const t = slot + td.getUint32(slot, true);
                const vt = t - td.getInt32(t, true);
                shift(t, vt, 0);
                if (hasEndTime) shift(t, vt, 1);
                if (isCond) {
                    const pvo = fOff(vt, 5);
                    if (pvo) {
                        const pvec = ind(t + pvo);
                        const pn = td.getUint32(pvec, true);
                        for (let j = 0; j < pn; j++) {
                            const pslot = pvec + 4 + j * 4;
                            const pt = pslot + td.getUint32(pslot, true);
                            const pvt = pt - td.getInt32(pt, true);
                            shift(pt, pvt, 1);
                        }
                    }
                }
            }
        };
        walkVec(1, true, true);
        walkVec(2, false, true);
        walkVec(5, false, false); // 分钟表字段 1 是 int8 概率，不是 endTime，不移
        // 拼装：[新根 uoffset][新根 vtable][新根表][移植 blob][原体 blob]
        const align4 = (v) => (v + 3) & ~3;
        const align8 = (v) => (v + 7) & ~7;
        const newRootVtablePos = 4;
        const newRootPos = align4(newRootVtablePos + rootVtableLen);
        const newRootTableSize = rootTableSize + 4;
        const tplPos = align4(newRootPos + newRootTableSize);
        const blobOffset = align8(tplPos + tpl.length);
        const outLen = blobOffset + rawBody.length;
        const out = new Uint8Array(outLen);
        const od = new DataView(out.buffer);
        od.setUint32(0, newRootPos, true);
        out.set(rawBody.slice(rootVtablePos, rootVtablePos + rootVtableLen), newRootVtablePos);
        od.setUint16(newRootVtablePos + 4 + 5 * 2, rootTableSize, true);
        out.set(rawBody.slice(rootPos, rootPos + rootTableSize), newRootPos);
        od.setInt32(newRootPos, newRootPos - newRootVtablePos, true);
        const nhNewPos = tplPos + nhPos;
        od.setUint32(newRootPos + rootTableSize, nhNewPos - (newRootPos + rootTableSize), true);
        out.set(tpl, tplPos);
        out.set(rawBody, blobOffset);
        for (let f = 0; f < 15; f++) {
            if (f === 5) continue;
            const o = bb.__offset(rootPos, 4 + f * 2);
            if (!o) continue;
            const oldTarget = rootPos + o + bb.readUint32(rootPos + o);
            const newTarget = oldTarget + blobOffset;
            od.setUint32(newRootPos + o, newTarget - (newRootPos + o), true);
        }
        // 自检：真实 flatbuffers 读回
        const chk = new flatbuffers.ByteBuffer(out);
        const chkRoot = chk.readInt32(chk.position()) + chk.position();
        const chkRootVt = chkRoot - chk.readInt32(chkRoot);
        if (chk.readUint16(chkRootVt) !== 15 * 2 + 4) return fail("self-check root fields");
        const s5 = chk.__offset(chkRoot, 4 + 5 * 2);
        if (!s5) return fail("self-check slot 5 absent");
        const cNh = chk.__indirect(chkRoot + s5);
        const cNhVt = cNh - chk.readInt32(cNh);
        const cStartOff = chk.readUint16(cNhVt + 4 + 3 * 2);
        if (!cStartOff) return fail("self-check NH start absent");
        const cStart = chk.readInt32(cNh + cStartOff);
        if (Math.abs(cStart - now) > 5) return fail("self-check window start != now");
        const cMetaOff = chk.__offset(cNh, 4 + 0 * 2);
        if (!cMetaOff) return fail("self-check metadata absent");
        const cMeta = chk.__indirect(cNh + cMetaOff);
        const cMetaVt = cMeta - chk.readInt32(cMeta);
        const cNameOff = chk.__offset(cMeta, 4 + 6 * 2);
        if (!cNameOff) return fail("self-check providerName absent");
        const cNamePos = chk.__indirect(cMeta + cNameOff);
        const cNameLen = chk.readUint32(cNamePos);
        const cNameBytes = out.slice(cNamePos + 4, cNamePos + 4 + cNameLen);
        const expName = utf8Bytes("Japan Meteorological Agency");
        if (cNameLen !== expName.length) return fail("self-check providerName length");
        for (let i = 0; i < cNameLen; i++) if (cNameBytes[i] !== expName[i]) return fail("self-check providerName bytes");
        const cLatOff = chk.__offset(cMeta, 4 + 3 * 2);
        const cLonOff = chk.__offset(cMeta, 4 + 4 * 2);
        const od2 = new DataView(out.buffer);
        if (!cLatOff || !cLonOff) return fail("self-check meta lat/lon absent");
        if (od2.getFloat32(cMeta + cLatOff, true) !== Math.fround(targetLat)) return fail("self-check lat");
        if (od2.getFloat32(cMeta + cLonOff, true) !== Math.fround(targetLon)) return fail("self-check lon");
        const vecCheck = (fieldIdx, expectLen) => {
            const vo = chk.__offset(cNh, 4 + fieldIdx * 2);
            if (!vo) return false;
            const vp = chk.__indirect(cNh + vo);
            const n = chk.readUint32(vp);
            if (n !== expectLen) return false;
            for (let i = 0; i < n; i++) {
                const off = chk.readUint32(vp + 4 + i * 4);
                if (off <= 0 || vp + 4 + i * 4 + off >= out.length) return false;
            }
            return true;
        };
        if (!vecCheck(1, 1) || !vecCheck(2, 1) || !vecCheck(5, 83)) return fail("self-check vectors");
        const cMinVec = chk.__indirect(cNh + chk.__offset(cNh, 4 + 5 * 2));
        const cMin0 = cMinVec + 4 + chk.readUint32(cMinVec + 4);
        const cMin0Vt = cMin0 - chk.readInt32(cMin0);
        const cMin0StartOff = chk.readUint16(cMin0Vt + 4 + 0 * 2);
        if (!cMin0StartOff || chk.readInt32(cMin0 + cMin0StartOff) !== cStart) return fail("self-check minute[0] start");
        // 槽 0 AQ 类别/指数未被扰动
        const aqCatOff = bb.__offset(aqTable, 4 + 1 * 2);
        const aqIdxOff = bb.__offset(aqTable, 4 + 2 * 2);
        const cAq = chk.__indirect(chkRoot + chk.__offset(chkRoot, 4 + 0 * 2));
        const cAqCatOff = chk.__offset(cAq, 4 + 1 * 2);
        const cAqIdxOff = chk.__offset(cAq, 4 + 2 * 2);
        if (aqCatOff && cAqCatOff && bb.readInt8(aqTable + aqCatOff) !== chk.readInt8(cAq + cAqCatOff)) return fail("self-check AQ category changed");
        if (aqIdxOff && cAqIdxOff && bb.readInt16(aqTable + aqIdxOff) !== chk.readInt16(cAq + cAqIdxOff)) return fail("self-check AQ index changed");
        return { body: out, log: `WK3 nhTransplant: slot 5 transplanted (tokyo) window ${now}->${origEnd + delta} latlon ${targetLat.toFixed(4)},${targetLon.toFixed(4)} body ${rawBody.length}->${outLen}` };
    } catch (e) {
        return fail(`exception ${e?.message ?? e}`);
    }
}

function fillWK3NextHour(ByteBuffer, rawBody, nh, opts = {}) {
    const minimal = !!opts.minimal; // BISECT beta2: minimal slot 5 (metadata only, empty vectors)
    const windowOnly = !!opts.windowOnly; // BISECT beta5: window-only slot 5 (no metadata, no vectors)
    const fail = log => ({ body: null, log: `WK3 nhFill: skipped (${log})` });
    try {
        if (!nh || !Array.isArray(nh.minutes) || (nh.minutes.length === 0 && !minimal && !windowOnly)) return fail("no minutes");
        const rootPos = ByteBuffer.readInt32(ByteBuffer.position()) + ByteBuffer.position();
        if (rootPos < 0 || rootPos + 4 > rawBody.length) return fail("root out of range");
        const rootVtablePos = rootPos - ByteBuffer.readInt32(rootPos);
        const rootVtableLen = ByteBuffer.readUint16(rootVtablePos);
        const rootTableSize = ByteBuffer.readUint16(rootVtablePos + 2);
        const rootFieldCount = Math.floor((rootVtableLen - 4) / 2);
        if (rootFieldCount !== 15 || rootTableSize <= 0 || rootTableSize > 1024) {
            return fail(`unexpected root fields=${rootFieldCount} size=${rootTableSize}`);
        }
        if (ByteBuffer.__offset(rootPos, 4 + 5 * 2)) return fail("slot 5 present");
        const presentSlots = [];
        for (let slot = 0; slot < rootFieldCount; slot++) {
            if (ByteBuffer.__offset(rootPos, 4 + slot * 2)) presentSlots.push(slot);
        }

        // Filter conditions like v2 does: begin/end must be known ConditionType
        // values (FLURRIES/POSSIBLE_FLURRIES are not in the WK2 schema enum).
        const conditions = (windowOnly || minimal) ? [] : (nh.condition || []).filter(c =>
            typeof CONDITION_TYPE[c.beginCondition] === "number" &&
            typeof CONDITION_TYPE[c.endCondition] === "number" &&
            typeof FORECAST_TOKEN[c.forecastToken] === "number");
        const summaries = (windowOnly || minimal) ? [] : (nh.summary || []);
        const minutes = (windowOnly || minimal) ? [] : nh.minutes;
        const md = nh.metadata || {};

        // BISECT beta3: shift window to now (provider window starts 60-120s in the past)
        if (opts.shiftToNow) {
            const nowSec = Math.trunc(Date.now() / 1000);
            const delta = nowSec - Math.trunc(nh.forecastStart || 0);
            if (delta > 0) {
                nh.forecastStart = Math.trunc(nh.forecastStart || 0) + delta;
                nh.forecastEnd = Math.trunc(nh.forecastEnd || 0) + delta;
                for (const m of minutes) m.startTime = Math.trunc(m.startTime || 0) + delta;
                for (const s of summaries) { s.startTime = Math.trunc(s.startTime || 0) + delta; if (s.endTime) s.endTime = Math.trunc(s.endTime) + delta; }
                for (const c of conditions) { c.startTime = Math.trunc(c.startTime || 0) + delta; if (c.endTime) c.endTime = Math.trunc(c.endTime) + delta; for (const p of (c.parameters || [])) p.date = Math.trunc(p.date || 0) + delta; }
            }
        }

        const align4 = v => Math.ceil(v / 4) * 4;
        const align8 = v => Math.ceil(v / 8) * 8;

        // ---- size planning (cursor walk, no writes yet) ----
        const newRootVtablePos = 4;
        const newRootPos = align4(newRootVtablePos + rootVtableLen);
        const newRootTableSize = rootTableSize + 4;
        let cursor = align4(newRootPos + newRootTableSize);
        const nhVtablePos = cursor; cursor += 16;
        const nhPos = align4(cursor); cursor += 28;
        const metaVtablePos = align4(cursor); cursor += 26;
        const metaPos = align8(cursor); cursor += 44;
        const enc = new TextEncoder();
        const strBytes = {};
        for (const k of ["attributionUrl", "language", "providerLogo", "providerName"]) {
            if (typeof md[k] === "string" && md[k].length > 0) strBytes[k] = enc.encode(md[k]);
        }
        const strPos = {};
        for (const k of ["attributionUrl", "language", "providerLogo", "providerName"]) {
            if (strBytes[k]) { strPos[k] = align4(cursor); cursor = strPos[k] + align4(4 + strBytes[k].length); }
        }
        const condVecPos = align4(cursor); cursor += 4 + 4 * conditions.length;
        const condTables = [];
        for (const c of conditions) {
            const params = Array.isArray(c.parameters) ? c.parameters : [];
            const vt = align4(cursor); cursor += 16;
            const tp = align4(cursor); cursor += 20;
            const pv = align4(cursor); cursor += 4 + 4 * params.length;
            const ptables = [];
            for (let j = 0; j < params.length; j++) {
                const pvt = align4(cursor); cursor += 8;
                const ptp = align4(cursor); cursor += 12;
                ptables.push({ vtable: pvt, table: ptp });
            }
            condTables.push({ vtable: vt, table: tp, paramsVec: pv, params, ptables });
        }
        const summVecPos = align4(cursor); cursor += 4 + 4 * summaries.length;
        const summTables = [];
        for (let j = 0; j < summaries.length; j++) {
            const vt = align4(cursor); cursor += 14;
            const tp = align4(cursor); cursor += 20;
            summTables.push({ vtable: vt, table: tp });
        }
        const minVecPos = align4(cursor); cursor += 4 + 4 * minutes.length;
        const minTables = [];
        for (let j = 0; j < minutes.length; j++) {
            const vt = align4(cursor); cursor += 12;
            const tp = align4(cursor); cursor += 20;
            minTables.push({ vtable: vt, table: tp });
        }
        const blobOffset = align8(cursor);
        const out = new Uint8Array(blobOffset + rawBody.length);
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        const setU16 = (p, v) => view.setUint16(p, v, true);
        const setI32 = (p, v) => view.setInt32(p, v, true);
        const setU32 = (p, v) => view.setUint32(p, v, true);
        const setF32 = (p, v) => view.setFloat32(p, Math.fround(v), true);
        const setI8 = (p, v) => view.setInt8(p, v);
        const writeString = (pos, bytes) => { setU32(pos, bytes.length); out.set(bytes, pos + 4); };

        // ---- root ----
        setU32(0, newRootPos);
        out.set(rawBody.subarray(rootVtablePos, rootVtablePos + rootVtableLen), newRootVtablePos);
        setU16(newRootVtablePos + 2, newRootTableSize);
        setU16(newRootVtablePos + 4 + 5 * 2, rootTableSize);
        out.set(rawBody.subarray(rootPos, rootPos + rootTableSize), newRootPos);
        setI32(newRootPos, newRootPos - newRootVtablePos);
        for (let slot = 0; slot < rootFieldCount; slot++) {
            const fo = ByteBuffer.__offset(rootPos, 4 + slot * 2);
            if (!fo) continue;
            const newFieldPos = newRootPos + fo;
            if (slot === 5) continue; // absent in original, handled below
            const origTarget = ByteBuffer.__indirect(rootPos + fo);
            setU32(newFieldPos, origTarget + blobOffset - newFieldPos);
        }
        setU32(newRootPos + rootTableSize, nhPos - (newRootPos + rootTableSize));

        // ---- NextHour table ----
        // windowOnly: fields 0/1/2/5 must be ABSENT via vtable entry 0 (a 0 slot
        // value is not absent in FlatBuffers, it is a self-referential offset).
        setU16(nhVtablePos, 16); setU16(nhVtablePos + 2, 28);
        if (windowOnly) {
            setU16(nhVtablePos + 4 + 0 * 2, 0); setU16(nhVtablePos + 4 + 1 * 2, 0);
            setU16(nhVtablePos + 4 + 2 * 2, 0); setU16(nhVtablePos + 4 + 3 * 2, 12);
            setU16(nhVtablePos + 4 + 4 * 2, 8); setU16(nhVtablePos + 4 + 5 * 2, 0);
        } else {
            setU16(nhVtablePos + 4 + 0 * 2, 24); setU16(nhVtablePos + 4 + 1 * 2, 20);
            setU16(nhVtablePos + 4 + 2 * 2, 16); setU16(nhVtablePos + 4 + 3 * 2, 12);
            setU16(nhVtablePos + 4 + 4 * 2, 8); setU16(nhVtablePos + 4 + 5 * 2, 4);
        }
        setI32(nhPos, nhPos - nhVtablePos);
        if (!windowOnly) {
            setU32(nhPos + 24, metaPos - (nhPos + 24));
            setU32(nhPos + 20, condVecPos - (nhPos + 20));
            setU32(nhPos + 16, summVecPos - (nhPos + 16));
            setU32(nhPos + 4, minVecPos - (nhPos + 4));
        }
        setI32(nhPos + 12, Math.trunc(nh.forecastStart || 0));
        setI32(nhPos + 8, Math.trunc(nh.forecastEnd || 0));

        // ---- metadata ----
        setU16(metaVtablePos, 26); setU16(metaVtablePos + 2, 44);
        const metaOffs = [36, 32, 28, 24, 20, 16, 12, 8, 4, 0, 40];
        for (let f = 0; f < 11; f++) setU16(metaVtablePos + 4 + f * 2, metaOffs[f]);
        setI32(metaPos, metaPos - metaVtablePos);
        if (strPos.attributionUrl !== undefined) { writeString(strPos.attributionUrl, strBytes.attributionUrl); setU32(metaPos + 36, strPos.attributionUrl - (metaPos + 36)); }
        setI32(metaPos + 32, Math.trunc(md.expireTime || 0));
        if (strPos.language !== undefined) { writeString(strPos.language, strBytes.language); setU32(metaPos + 28, strPos.language - (metaPos + 28)); }
        setF32(metaPos + 24, md.latitude || 0);
        setF32(metaPos + 20, md.longitude || 0);
        if (strPos.providerLogo !== undefined) { writeString(strPos.providerLogo, strBytes.providerLogo); setU32(metaPos + 16, strPos.providerLogo - (metaPos + 16)); }
        if (strPos.providerName !== undefined) { writeString(strPos.providerName, strBytes.providerName); setU32(metaPos + 12, strPos.providerName - (metaPos + 12)); }
        setI32(metaPos + 8, Math.trunc(md.readTime || 0));
        setI32(metaPos + 4, Math.trunc(md.reportedTime || 0));
        setI8(metaPos + 40, SOURCE_TYPE[md.sourceType] ?? 1);

        // ---- condition vector + tables ----
        setU32(condVecPos, conditions.length);
        conditions.forEach((c, i) => {
            const t = condTables[i];
            setU32(condVecPos + 4 + i * 4, t.table - (condVecPos + 4 + i * 4));
            setU16(t.vtable, 16); setU16(t.vtable + 2, 20);
            setU16(t.vtable + 4 + 0 * 2, 16); setU16(t.vtable + 4 + 1 * 2, 12);
            setU16(t.vtable + 4 + 2 * 2, 10); setU16(t.vtable + 4 + 3 * 2, 9);
            setU16(t.vtable + 4 + 4 * 2, 8); setU16(t.vtable + 4 + 5 * 2, 4);
            setI32(t.table, t.table - t.vtable);
            setU32(t.table + 4, t.paramsVec - (t.table + 4));
            setI8(t.table + 8, CONDITION_TYPE[c.endCondition]);
            setI8(t.table + 9, CONDITION_TYPE[c.beginCondition]);
            setI8(t.table + 10, FORECAST_TOKEN[c.forecastToken]);
            setI32(t.table + 12, Math.trunc(c.endTime || 0));
            setI32(t.table + 16, Math.trunc(c.startTime || 0));
            setU32(t.paramsVec, t.params.length);
            t.params.forEach((p, j) => {
                const pt = t.ptables[j];
                setU32(t.paramsVec + 4 + j * 4, pt.table - (t.paramsVec + 4 + j * 4));
                setU16(pt.vtable, 8); setU16(pt.vtable + 2, 12);
                setU16(pt.vtable + 4 + 0 * 2, 4); setU16(pt.vtable + 4 + 1 * 2, 8);
                setI32(pt.table, pt.table - pt.vtable);
                setI8(pt.table + 4, PARAMETER_TYPE[p.type] ?? 0);
                setI32(pt.table + 8, Math.trunc(p.date || 0));
            });
        });

        // ---- summary vector + tables ----
        setU32(summVecPos, summaries.length);
        summaries.forEach((s, i) => {
            const t = summTables[i];
            setU32(summVecPos + 4 + i * 4, t.table - (summVecPos + 4 + i * 4));
            setU16(t.vtable, 14); setU16(t.vtable + 2, 20);
            setU16(t.vtable + 4 + 0 * 2, 16); setU16(t.vtable + 4 + 1 * 2, 12);
            setU16(t.vtable + 4 + 2 * 2, 9); setU16(t.vtable + 4 + 3 * 2, 8);
            setU16(t.vtable + 4 + 4 * 2, 4);
            setI32(t.table, t.table - t.vtable);
            setF32(t.table + 4, s.precipitationIntensity || 0);
            setI8(t.table + 8, s.precipitationChance || 0);
            setI8(t.table + 9, PRECIPITATION_TYPE[s.condition] ?? 0);
            setI32(t.table + 12, Math.trunc(s.endTime || 0));
            setI32(t.table + 16, Math.trunc(s.startTime || 0));
        });

        // ---- minutes vector + tables ----
        setU32(minVecPos, minutes.length);
        minutes.forEach((m, i) => {
            const t = minTables[i];
            setU32(minVecPos + 4 + i * 4, t.table - (minVecPos + 4 + i * 4));
            setU16(t.vtable, 12); setU16(t.vtable + 2, 20);
            setU16(t.vtable + 4 + 0 * 2, 16); setU16(t.vtable + 4 + 1 * 2, 12);
            setU16(t.vtable + 4 + 2 * 2, 8); setU16(t.vtable + 4 + 3 * 2, 4);
            setI32(t.table, t.table - t.vtable);
            setF32(t.table + 4, m.perceivedPrecipitationIntensity || 0);
            setF32(t.table + 8, m.precipitationIntensity || 0);
            setI8(t.table + 12, m.precipitationChance || 0);
            setI32(t.table + 16, Math.trunc(m.startTime || 0));
        });

        // ---- blob ----
        out.set(rawBody, blobOffset);

        // ---- self-check (unsigned forward offsets, like the beta13 AQ fix) ----
        const chk = new flatbuffers.ByteBuffer(out);
        const chkRoot = chk.readInt32(0);
        if (Math.floor((chk.readUint16(chkRoot - chk.readInt32(chkRoot)) - 4) / 2) !== 15) return fail("self-check root fields");
        const chkNhOff = chk.__offset(chkRoot, 4 + 5 * 2);
        if (!chkNhOff) return fail("self-check slot 5 absent");
        const chkNh = chk.__indirect(chkRoot + chkNhOff);
        if (windowOnly) {
            if (chk.__offset(chkNh, 4) || chk.__offset(chkNh, 6) || chk.__offset(chkNh, 8) || chk.__offset(chkNh, 14)) return fail("self-check windowOnly fields not absent");
            const chkStartOff = chk.__offset(chkNh, 10);
            const chkEndOff = chk.__offset(chkNh, 12);
            if (!chkStartOff || chk.readInt32(chkNh + chkStartOff) !== Math.trunc(nh.forecastStart || 0)) return fail("self-check windowOnly start");
            if (!chkEndOff || chk.readInt32(chkNh + chkEndOff) !== Math.trunc(nh.forecastEnd || 0)) return fail("self-check windowOnly end");
            return { body: out, log: `WK3 nhFill: slot 5 created (windowOnly)${opts.shiftToNow ? " (shiftToNow)" : ""} minutes=${minutes.length} summaries=${summaries.length} conditions=${conditions.length} provider=${md.providerName || "?"} body ${rawBody.length}->${out.length}` };
        }
        const chkNhMetaOff = chk.__offset(chkNh, 4);
        const chkMeta = chk.__indirect(chkNh + chkNhMetaOff);
        const chkProvOff = chk.__offset(chkMeta, 16);
        let chkProv = "";
        if (chkProvOff) {
            const sp = chk.__indirect(chkMeta + chkProvOff);
            const slen = chk.readUint32(sp);
            chkProv = new TextDecoder().decode(out.subarray(sp + 4, sp + 4 + slen));
        }
        if (chkProv !== (md.providerName || "")) return fail("self-check providerName mismatch");
        const checkVec = (vecPos, want) => {
            if (chk.readUint32(vecPos) !== want) return false;
            for (let i = 0; i < want; i++) {
                const off = chk.readUint32(vecPos + 4 + i * 4);
                if (off <= 0 || vecPos + 4 + i * 4 + off >= out.length) return false;
            }
            return true;
        };
        const chkCondOff = chk.__offset(chkNh, 6);
        const chkSummOff = chk.__offset(chkNh, 8);
        const chkMinOff = chk.__offset(chkNh, 14);
        if (!checkVec(chk.__indirect(chkNh + chkCondOff), conditions.length)) return fail("self-check condition vec");
        if (!checkVec(chk.__indirect(chkNh + chkSummOff), summaries.length)) return fail("self-check summary vec");
        if (!checkVec(chk.__indirect(chkNh + chkMinOff), minutes.length)) return fail("self-check minutes vec");
        const chkMinVec = chk.__indirect(chkNh + chkMinOff);
        for (let i = 0; i < minutes.length; i++) {
            const slot = chkMinVec + 4 + i * 4;
            const mt = slot + chk.readUint32(slot);
            const stOff = chk.__offset(mt, 4);
            if (!stOff || chk.readInt32(mt + stOff) !== Math.trunc(minutes[i].startTime)) return fail(`self-check minute ${i} startTime`);
        }
        return {
            body: out,
            log: `WK3 nhFill: slot 5 created${minimal ? " (minimal bisect)" : ""}${opts.shiftToNow ? " (shiftToNow)" : ""} minutes=${minutes.length} summaries=${summaries.length} conditions=${conditions.length} provider=${md.providerName || "?"} body ${rawBody.length}->${out.length}`,
        };
    } catch (e) {
        return { body: null, log: `WK3 nhFill: skipped (exception ${e?.message ?? e})` };
    }
}
