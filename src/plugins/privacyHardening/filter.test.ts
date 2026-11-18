/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run: node --test src/plugins/privacyHardening/filter.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import type * as Filter from "./filter";

// Node's type stripping needs the ".ts" extension at runtime, which tsc rejects in static imports.
const filterPath = "./filter.ts";
const { classify, decide, matchPattern, privacyIds, SAFE_LANDING, setMediaResolver, wants }: typeof Filter = await import(filterPath);

const req = (url: string, extra: Record<string, unknown> = {}) =>
    ({ url, method: "GET", resourceType: "xhr", ...extra }) as any;
const body = (text: string) => ({ method: "POST", uploadData: [{ bytes: Buffer.from(text) }] });

test("telemetry endpoints are blocked", () => {
    for (const url of [
        "https://discord.com/api/v9/science",
        "https://discord.com/api/v10/track",
        "https://discord.com/api/v9/metrics/v2",
        "https://discord.com/error-reporting-proxy/web",
        "https://o64374.ingest.sentry.io/api/146342/envelope/",
        "https://idt-x.loc-en-us.chk-webapp.res-ok.dur-0.v1.dc-telemetry.net/",
        "sentry-ipc://scope/sentry_key",
    ]) assert.equal(classify(req(url)), "telemetry", url);
});

test("normal Discord traffic is allowed", () => {
    for (const url of [
        "https://discord.com/api/v9/users/@me",
        "https://discord.com/api/v9/channels/123456789012345678/messages",
        "https://cdn.discordapp.com/avatars/1/a.png",
        "https://latency.discord.media/rtc",
        "https://discord.com/cdn-cgi/challenge-platform/scripts/jsd/main.js",
        "https://discord.com/api/v9/sciencefiction", // word boundary: not /science
    ]) assert.equal(classify(req(url)), null, url);
});

test("requests to Discord mentioning a privacy ID are cancelled (URL or body)", () => {
    const id = "999000000000000001";
    privacyIds.add(id);
    assert.equal(classify(req(`https://discord.com/api/v9/channels/${id}/messages`)), "privacy");
    assert.equal(classify(req(`https://discord.com/api/v9/channels/${id}/typing`)), "privacy");
    assert.equal(classify(req("https://discord.com/api/v9/read-states/ack-bulk", body(`{"read_states":[{"channel_id":"${id}"}]}`))), "privacy");
    assert.equal(classify(req(`https://media.discordapp.net/attachments/${id}/x.png`)), "privacy");
    // Non-Discord hosts (e.g. our own instance) are not affected; neither are other IDs.
    assert.equal(classify(req(`https://chat.example.org/channels/${id}`)), null);
    assert.equal(classify(req("https://discord.com/api/v9/channels/123456789012345678/messages")), null);
    // A longer number that merely contains the ID must not match.
    assert.equal(classify(req(`https://discord.com/api/v9/x/1${id}`)), null);
});

test("chained listener filters follow Chrome match-pattern semantics", () => {
    const re = matchPattern("https://*.discord.com/api/*");
    assert.ok(re.test("https://discord.com/api/v9/x"));
    assert.ok(re.test("https://canary.discord.com/api/v9/x?y=1"));
    assert.ok(!re.test("https://evildiscord.com/api/v9/x"));
    assert.ok(!re.test("http://discord.com/api/v9/x"));
    assert.ok(matchPattern("*://*/*").test("http://a.b/c"));
    assert.ok(matchPattern("<all_urls>").test("file:///x"));

    const ds = { listener: () => {}, include: [matchPattern("https://discord.com/*")], exclude: [matchPattern("https://discord.com/assets/*")], types: null };
    assert.ok(wants(ds, req("https://discord.com/api")));
    assert.ok(!wants(ds, req("https://discord.com/assets/a.js")));
    assert.ok(!wants(ds, req("https://cdn.discordapp.com/x")));
    assert.ok(!wants({ ...ds, types: new Set(["mainFrame"]) }, req("https://discord.com/api")));
});

test("settings-proto writes containing a privacy guild ID in binary are cancelled", () => {
    const id = "999000000000000777";
    privacyIds.add(id);
    const fixed = Buffer.alloc(8);
    fixed.writeBigUInt64LE(BigInt(id));
    // Fake GuildFolder: field 1 (packed fixed64) holding one real-looking ID and our privacy ID.
    const other = Buffer.alloc(8);
    other.writeBigUInt64LE(123456789012345678n);
    const proto = Buffer.concat([Buffer.from([0x0a, 16]), other, fixed]);
    const url = "https://discord.com/api/v9/users/@me/settings-proto/1";
    const patch = (b: Buffer) => ({ method: "PATCH", uploadData: [{ bytes: Buffer.from(JSON.stringify({ settings: b.toString("base64") })) }] });
    assert.equal(classify(req(url, patch(proto))), "privacy");
    assert.equal(classify(req(url, patch(Buffer.concat([Buffer.from([0x0a, 8]), other])))), null);
});

test("page loads of privacy URLs are redirected home, not cancelled (cancel = blank client)", () => {
    const id = "999000000000000555";
    privacyIds.add(id);
    const page = decide(req(`https://discord.com/channels/${id}/1`, { resourceType: "mainFrame" }));
    assert.deepEqual(page, { verdict: "privacy", response: { redirectURL: SAFE_LANDING } });
    // API requests are still cancelled outright; normal pages load untouched.
    assert.deepEqual(decide(req(`https://discord.com/api/v9/channels/${id}/messages`)).response, { cancel: true });
    assert.deepEqual(decide(req("https://discord.com/channels/@me", { resourceType: "mainFrame" })).response, {});
});

test("privacy media is redirected to its instance, everything else stays blocked", () => {
    const [guild, other, foreign] = ["1300000000000000001", "1300000000000000002", "1300000000000000003"];
    privacyIds.add(guild);
    privacyIds.add(other);
    privacyIds.add(foreign);
    const owners: Record<string, string> = { [guild]: "https://inst.example", [other]: "https://inst.example", [foreign]: "https://evil.example" };
    setMediaResolver(id => owners[id]);
    try {
        const icon = decide(req(`https://cdn.discordapp.com/icons/${guild}/abc.webp?size=96`, { resourceType: "image" }));
        assert.equal(icon.response.redirectURL, `https://inst.example/cdn/icons/${guild}/abc.webp?size=96`);
        const att = decide(req(`https://media.discordapp.net/attachments/${guild}/${other}/a.png?hm=x`, { resourceType: "image" }));
        assert.equal(att.response.redirectURL, `https://inst.example/cdn/attachments/${guild}/${other}/a.png?hm=x`);
        // Mixed instances, real Discord IDs, non-GET, and API calls are cancelled.
        for (const d of [
            req(`https://cdn.discordapp.com/attachments/${guild}/${foreign}/a.png`),
            req(`https://cdn.discordapp.com/guilds/${guild}/users/1234567890123456789/avatars/x.png`),
            req(`https://cdn.discordapp.com/icons/${guild}/abc.png`, { method: "POST" }),
            req(`https://discord.com/api/v9/guilds/${guild}`),
        ]) assert.deepEqual(decide(d).response, { cancel: true });
    } finally {
        setMediaResolver(null);
    }
});
