import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// WK3 实验分支的路由守卫：只验证源码层面的路由，不证明 WK3 解码正确。
// 不 import 任何 src 模块，避免本测试依赖 @nsnanocat / @nsringo 等私有包。
const [loon, response, request, parse] = await Promise.all([
    readFile(new URL("../template/loon.handlebars", import.meta.url), "utf8"),
    readFile(new URL("../src/process/Response.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/process/Request.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/function/parseWeatherKitURL.mjs", import.meta.url), "utf8"),
]);

test("Loon 模板保留 v2 规则，并行新增 v3 规则", () => {
    assert.match(loon, /api\\\/v2\\\/weather\\\//);
    assert.match(loon, /http-response \^https\?:\\\/\\\/weatherkit\\\.apple\\\.com\\\/api\\\/v3\\\/weather\\\//);
    assert.match(loon, /WeatherKit\.api\.v3\.weather\.response/);
});

test("Response 对 v3 做探针 + 当前天气真实温度原位替换，不走 WK2 解码", () => {
    assert.match(response, /startsWith\("\/api\/v3\/weather\/"\)/);
    assert.match(response, /cwReplace: CW real provider temperature/);
});

test("Probe v2 只记槽位清单、不改包体，schema 版本取请求头", () => {
    assert.match(response, /dumpWK3Root\(ByteBuffer, rawBody\.length\)/);
    assert.match(response, /schema-version\(request\)/);
    assert.match(response, /schema-version\(response\)/);
    // v3 分支内不得出现 WK2 解码/编码，也不得写 $response.body。
    const v3Start = response.indexOf('startsWith("/api/v3/weather/")');
    const v2Start = response.indexOf('startsWith("/api/v2/weather/")', v3Start);
    const v3Block = response.slice(v3Start, v2Start);
    assert.doesNotMatch(v3Block, /WeatherKit2\.decode|WeatherKit2\.encode/);
    assert.doesNotMatch(v3Block, /\$response\.body\s*=/);
});

test("Probe v3 只记数值、不改包体：当前天气候选浮点、包装表向量、下一小时与预警", () => {
    assert.match(response, /WK3 cw: asOf=/);
    assert.match(response, /WK3 nextHour: start=/);
    assert.match(response, /WK3 alerts: vecLen=/);
    assert.match(response, /vec1Len=/);
    assert.match(response, /WK3 root: empty \(fields=0\)/);
});

test("CW 真实温度原位替换：第三方温度 / 体感 / 露点，ColorfulClouds 无露点时用 Magnus 重算，失败原样返回", () => {
    assert.match(response, /function replaceWK3CWTemperature/);
    assert.match(response, /providerCurrentWeather\.temperature/);
    assert.match(response, /temperatureDewPoint/);
    assert.match(response, /country !== "CN"/);
    assert.match(response, /new Uint8Array\(rawBody\)/);
    assert.match(response, /setFloat32/);
    assert.doesNotMatch(response, /TEST_TEMPERATURE/);
    assert.doesNotMatch(response, /TEST\.WK3\.00001/);
    // v3 分支内不得出现 WK2 解码/编码。
    const v3Start = response.indexOf('startsWith("/api/v3/weather/")');
    const v2Start = response.indexOf('startsWith("/api/v2/weather/")', v3Start);
    const v3Block = response.slice(v3Start, v2Start);
    assert.doesNotMatch(v3Block, /WeatherKit2\.decode|WeatherKit2\.encode/);
});

test("AQ overlay：新 AQ 表 + 其余槽位 opaque 保留，失败原样返回，不走 WK2 解码", () => {
    assert.match(response, /function overlayWK3AQ/);
    assert.match(response, /WK3 aqOverlay: scale/);
    assert.match(response, /opaque slots preserved/);
    assert.match(response, /self-check/);
    assert.doesNotMatch(response, /TEST\.WK3\.00001/);
    // v3 分支内不得出现 WK2 解码/编码，也不得写 $response.body。
    const v3Start = response.indexOf('startsWith("/api/v3/weather/")');
    const v2Start = response.indexOf('startsWith("/api/v2/weather/")', v3Start);
    const v3Block = response.slice(v3Start, v2Start);
    assert.doesNotMatch(v3Block, /WeatherKit2\.decode|WeatherKit2\.encode/);
    assert.doesNotMatch(v3Block, /\$response\.body\s*=/);
});

test("AQ 欧标全套：原污染物按 EU_EAQI 计算，一起换 category / index / 主污染物 / scale，昨日对比不动", () => {
    assert.match(response, /function calculateWK3AQEU/);
    assert.match(response, /Pollutants2AQI/);
    assert.match(response, /EU_EAQI/);
    assert.match(response, /WK3 aqEU:/);
    assert.doesNotMatch(response, /TEST\.WK3\.00001/);
    // v3 分支内不得出现 WK2 解码/编码，也不得写 $response.body。
    const v3Start = response.indexOf('startsWith("/api/v3/weather/")');
    const v2Start = response.indexOf('startsWith("/api/v2/weather/")', v3Start);
    const v3Block = response.slice(v3Start, v2Start);
    assert.doesNotMatch(v3Block, /WeatherKit2\.decode|WeatherKit2\.encode/);
    assert.doesNotMatch(v3Block, /\$response\.body\s*=/);
});

test("Request 对 v3 沿用 v2 的 country 补齐分支", () => {
    assert.match(request, /startsWith\("\/api\/v3\/weather\/"\)/);
});

test("Fork-only: Loon 模板的 script-path 指向 fork 的 Release（上游化时须剔除）", () => {
    assert.match(loon, /github\.com\/mist-whisper\/WeatherKit\/releases\/download/);
    assert.doesNotMatch(loon, /github\.com\/NSRingo\/WeatherKit\/releases\/download/);
});

test("parseWeatherKitURL 对 availability / weather 接受 v3", () => {
    assert.match(parse, /v1\|v2\|v3/);
});
