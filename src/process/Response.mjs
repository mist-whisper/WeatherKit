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
                                const cwReplace = replaceWK3CWTemperature(ByteBuffer, rawBody, parameters.country, Settings?.Weather?.Provider, providerCurrentWeather);
                                if (cwReplace.body) rawBody = cwReplace.body;
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
                                    cwReplace.log,
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
