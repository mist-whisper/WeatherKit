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
                                // category / index / 主污染物 / scale 串；昨日对比在原值
                                // UNKNOWN（或 ReplaceWhenCurrentChange）时按 v2 逻辑重算
                                // （默认走彩云昨日/今日美标或国标对比），元数据拼接
                                // providerName；污染物空了不补（先只做污染物本来就有
                                // 的城市）；对比或元数据任一失败只退回原值，不影响
                                // 指数替换与 CW。国家门跟 Weather.Replace，scale 门跟
                                // AirQuality.Current.Index.Replace。
                                let aqComparisonEnv = null;
                                if (Settings?.Weather?.Replace?.includes(parameters.country)) {
                                    aqComparisonEnv = new ColorfulClouds({ ...parameters }, Settings?.API?.ColorfulClouds?.Token || "Y2FpeXVuX25vdGlmeQ==");
                                }
                                const aqReplace = await calculateWK3AQ(ByteBuffer, rawBody, parameters.country, Settings, aqComparisonEnv);
                                let workingBody = rawBody;
                                let workingByteBuffer = ByteBuffer;
                                if (aqReplace.body) {
                                    workingBody = aqReplace.body;
                                    workingByteBuffer = new flatbuffers.ByteBuffer(workingBody);
                                }
                                const cwReplace = replaceWK3CWTemperature(workingByteBuffer, workingBody, parameters.country, Settings?.Weather?.Provider, providerCurrentWeather);
                                if (cwReplace.body) workingBody = cwReplace.body;
                                // 未来一小时填空（WK3）：仅槽 5 缺失且数据集选中时，
                                // 按 Settings.NextHour.Provider 拉 provider 分钟数据新建槽 5；
                                // Apple 给了就不动；拉不到或自检失败一律原样返回。
                                const nhDefaultLog = "WK3 nh: skipped (slot 5 present or NextHour off)";
                                let nhReplace = { body: null, log: nhDefaultLog };
                                {
                                    const workingRootPos = workingByteBuffer.readInt32(workingByteBuffer.position()) + workingByteBuffer.position();
                                    const slot5Absent = !workingByteBuffer.__offset(workingRootPos, 4 + 5 * 2);
                                    const nhDataSetsOn = (Settings?.DataSets || []).includes("forecastNextHour");
                                    if (slot5Absent && nhDataSetsOn) {
                                        const nhProvider = Settings?.NextHour?.Provider ?? "ColorfulClouds";
                                        let nhData = null;
                                        let nhAttempted = false;
                                        try {
                                            if (nhProvider === "QWeather") {
                                                nhAttempted = true;
                                                const qWeather = new QWeather({ ...parameters }, Settings?.API?.QWeather?.Token || "bdd98ec1d87747f3a2e8b1741a5af796", Settings?.API?.QWeather?.Host);
                                                nhData = await qWeather.Minutely();
                                            } else if (nhProvider === "ColorfulClouds") {
                                                nhAttempted = true;
                                                const colorfulClouds = new ColorfulClouds({ ...parameters }, Settings?.API?.ColorfulClouds?.Token || "Y2FpeXVuX25vdGlmeQ==");
                                                nhData = await colorfulClouds.Minutely();
                                            } else {
                                                nhReplace = { body: null, log: `WK3 nh: skipped (provider ${nhProvider} not wired)` };
                                            }
                                        } catch (error) {
                                            nhReplace = { body: null, log: "WK3 nh: skipped (provider error)" };
                                        }
                                        if (nhData?.minutes?.length) {
                                            nhReplace = fillWK3NextHour(workingByteBuffer, workingBody, nhData, { windowOnly: true, shiftToNow: true }); // BISECT beta5: window-only slot 5, window shifted to now
                                            if (nhReplace.body) {
                                                workingBody = nhReplace.body;
                                                workingByteBuffer = new flatbuffers.ByteBuffer(workingBody);
                                            }
                                        } else if (nhAttempted && nhReplace.log === nhDefaultLog) {
                                            nhReplace = { body: null, log: "WK3 nh: skipped (provider returned no minutes)" };
                                        }
                                    }
                                }
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
async function calculateWK3AQ(ByteBuffer, rawBody, country, Settings, colorfulClouds = null) {
    try {
        const replaceCountries = Settings?.Weather?.Replace ?? ["CN"];
        if (!replaceCountries.includes(country)) return { body: null, log: `WK3 aq: skipped (country ${country} not in Weather.Replace)` };
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
        if (vecLen <= 0 || vecLen > 20) return { body: null, log: `WK3 aq: skipped (pollutants empty or too many: ${vecLen})` };
        const pollutantTypes = ["NOT_AVAILABLE", "C6H6", "NH3", "NMHC", "NO", "NO2", "NOX", "OZONE", "PM2_5", "SO2", "PM10", "CO", "UNKNOWN12", "UNKNOWN13"];
        // WK2 的单位枚举：0 ppb、1 µg、2 UNKNOWN2、3 UNKNOWN3。WK3 原包体里
        // 大量出现单位字节 2，且浓度是 µg 量级，故计算时把它当作微克（推断，见函数注释）。
        const unitTypes = ["PARTS_PER_BILLION", "MICROGRAMS_PER_CUBIC_METER", "MICROGRAMS_PER_CUBIC_METER", "UNKNOWN3"];
        const pollutants = [];
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
        const effectiveSettings = {
            ...Settings,
            AirQuality: { ...(Settings?.AirQuality ?? {}), Calculate: { ...(Settings?.AirQuality?.Calculate ?? {}), Algorithm: algorithm } },
        };
        const calculated = AirQuality.Pollutants2AQI({ pollutants, metadata: { providerName } }, effectiveSettings);
        if (!Number.isFinite(calculated?.index) || calculated.index < 0 || !Number.isFinite(calculated?.categoryIndex) || calculated.categoryIndex < 1 || calculated.categoryIndex > 10) {
            return { body: null, log: `WK3 aq: skipped (calculation invalid: index=${calculated?.index} category=${calculated?.categoryIndex})` };
        }
        const primaryEnum = pollutantTypes.indexOf(calculated.primaryPollutant);
        if (primaryEnum < 0) return { body: null, log: `WK3 aq: skipped (primary pollutant unknown: ${calculated.primaryPollutant})` };
        const perPollutant = (calculated.pollutants ?? []).map(p => `${p.pollutantType}=${Number.isFinite(p.index) ? p.index.toFixed(2) : p.index}`).join(" ");
        // 污染物向量重建输入：按原顺序、按类型对齐计算结果；量或单位串
        // 没变的写回原字节（见函数注释），变了的写换算值与目标单位枚举。
        const unitEnumByName = { PARTS_PER_BILLION: 0, MICROGRAMS_PER_CUBIC_METER: 1, UNKNOWN3: 3 };
        const calcByType = new Map((calculated.pollutants ?? []).map(p => [p.pollutantType, p]));
        const newPollutants = origPollutants.map(orig => {
            const typeName = pollutantTypes[orig.typeByte] ?? "UNKNOWN";
            const calc = calcByType.get(typeName);
            const unchanged = { typeEnum: orig.typeByte, amount: orig.amount, unitsEnum: orig.unitsByte };
            if (!calc || !Number.isFinite(calc.amount) || calc.amount < 0) return unchanged;
            if (calc.amount === orig.amount && calc.units === orig.units) return unchanged;
            const unitsEnum = unitEnumByName[calc.units];
            if (!Number.isInteger(unitsEnum)) return unchanged;
            return { typeEnum: orig.typeByte, amount: calc.amount, unitsEnum };
        });
        const changedDesc = newPollutants.map((p, i) => {
            const orig = origPollutants[i];
            if (p.amount === orig.amount && p.unitsEnum === orig.unitsByte) return null;
            const unitLabel = p.unitsEnum === 0 ? "ppb" : p.unitsEnum === 1 ? "µg" : `byte${p.unitsEnum}`;
            return `${pollutantTypes[orig.typeByte] ?? "?"} ${orig.amount}->${Number(p.amount.toFixed(2))}${unitLabel}`;
        }).filter(Boolean).join(", ");
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
            // 默认昨日指数源为 ColorfulCloudsUS；国标源为 ColorfulCloudsCN；
            // 其余昨日源（QWeather/Calculate）在 WK3 暂不接线，失败只退回原值。
            const yesterdayProvider = Settings?.AirQuality?.Comparison?.Yesterday?.IndexProvider ?? "ColorfulCloudsUS";
            const useUsa = yesterdayProvider !== "ColorfulCloudsCN";
            if (!colorfulClouds) {
                comparisonLog = "comparison skipped (no colorfulClouds env)";
            } else if (yesterdayProvider !== "ColorfulCloudsUS" && yesterdayProvider !== "ColorfulCloudsCN") {
                comparisonLog = `comparison skipped (yesterday provider ${yesterdayProvider} not wired in WK3)`;
            } else {
                try {
                    const currentIndexProvider = Settings?.AirQuality?.Current?.Index?.Provider ?? "Calculate";
                    const isHj = currentIndexProvider === "Calculate"
                        ? Settings?.AirQuality?.Calculate?.Algorithm === "WAQI_InstantCast_CN"
                        : (currentIndexProvider === "QWeather" || currentIndexProvider === "ColorfulCloudsCN");
                    const isEpa = currentIndexProvider === "WAQI" || currentIndexProvider === "ColorfulCloudsUS";
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
                            comparisonLog = `comparison ${origComparisonStr}->${trend} (CC today ${todayCat} vs yesterday ${yesterday.categoryIndex})`;
                        }
                    }
                } catch (error) {
                    comparisonLog = `comparison skipped (${error?.message ?? error})`;
                }
            }
        }
        // 元数据拼接（v2 Step 5）：原 provider + 指数行 + 对比行；logo 保持原值
        // （首个有效 provider 即原 provider），故不重建 logo 字段。
        const indexLine = `指数：${AirQuality.appendScaleToProviderName({ metadata: { providerName: "iRingo" }, scale: probeScale }, Settings)}`;
        const providerLines = [];
        if (providerName) providerLines.push(providerName);
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
            log: `WK3 aq: provider ${providerName || "?"} pollutants ${pollutants.length} [${perPollutant}] scale ${oldScale}->${probeScale} category ${oldCategory}->${calculated.categoryIndex} index ${oldIndex}->${Math.round(calculated.index)} primary ${calculated.primaryPollutant} (pollutants vector rebuilt: ${changedDesc || "no changes"}) [${comparisonLog}] [metadata: ${metadataProviderName ? "providerName spliced" : "unchanged"}]`,
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
            for (let i = 0; i < rebuildPollutants.elems.length; i++) {
                const vtablePos = align4(cursor);
                newPolVtablePositions.push(vtablePos);
                cursor = vtablePos + rebuildPollutants.elems[i].vtableLen;
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
        if (country !== "CN") return { body: null, log: "WK3 cwReplace: skipped (country != CN)" };
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
