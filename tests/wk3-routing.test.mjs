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

test("Response 对 v3 只做透传探针，不走 WK2 解码", () => {
    assert.match(response, /startsWith\("\/api\/v3\/weather\/"\)/);
    assert.match(response, /WK3 weather response passthrough \(experiment, not a fix\)/);
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
