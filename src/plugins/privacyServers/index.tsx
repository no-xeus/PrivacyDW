/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { PrivacyDWAuthor } from "@plugins/privacyHardening";
import definePlugin, { OptionType } from "@utils/types";
import { RestAPI, showToast } from "@webpack/common";

import { adopt, handle, idInstance, instanceFor, logger, mapSelf, Native, onlyPrivacyIds, unmapSelf } from "./bridge";
import { joinFromInput } from "./components/JoinFlow";
import { withPrivacyButton } from "./components/ServerListButton";
import { SettingsPanel } from "./components/Settings";

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: ErrorBoundary.wrap(() => <SettingsPanel />, { noop: false })
    }
});

let running = false;
async function eventLoop() {
    while (running) {
        try {
            for (const ev of await Native.nextEvents()) {
                if (!running) return;
                await handle(ev).catch(e => logger.error("failed to handle", ev.t, e));
            }
        } catch (e) {
            logger.error("event loop error", e);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// ---------- Generic routing: Discord REST calls about privacy objects go to the instance ----------

type RestMethod = "get" | "post" | "put" | "patch" | "del";
const METHODS: RestMethod[] = ["get", "post", "put", "patch", "del"];
let originalRest: Partial<Record<RestMethod, (opts: any, ...rest: any[]) => any>> = {};

function buildPath(url: string, query: unknown) {
    if (!query || typeof query !== "object") return url;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (v == null) continue;
        for (const x of Array.isArray(v) ? v : [v]) q.append(k, String(x));
    }
    const qs = q.toString();
    return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

// Mirrors the response object of Discord's HTTP util so callers can't tell the difference.
function httpResponse(ok: boolean, status: number, body: any) {
    return { ok, status, body, headers: {}, hasErr: false, text: JSON.stringify(body ?? null) };
}

function dataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
    });
}

// Instances take JSON only: form uploads (e.g. stickers) become JSON with files as data URIs.
async function jsonBody(opts: any) {
    const out: Record<string, unknown> = {};
    if (typeof FormData !== "undefined" && opts.body instanceof FormData) {
        for (const [k, v] of opts.body.entries()) out[k] = typeof v === "string" ? v : await dataUrl(v);
    } else if (Array.isArray(opts.fields) || Array.isArray(opts.attachments)) {
        Object.assign(out, opts.body ?? {});
        for (const f of opts.fields ?? []) out[f.name] = f.value;
        for (const a of opts.attachments ?? []) out[a.name] = await dataUrl(a.file);
    } else {
        return opts.body;
    }
    if (typeof out.payload_json === "string") {
        try { Object.assign(out, JSON.parse(out.payload_json)); delete out.payload_json; } catch { }
    }
    return out;
}

async function routeToInstance(instance: string, method: RestMethod, opts: any) {
    const path = unmapSelf(instance, buildPath(opts.url, opts.query));
    const raw = await jsonBody(opts);
    const body = raw === undefined ? undefined : unmapSelf(instance, raw);
    const r = await Native.rest(instance, method === "del" ? "DELETE" : method.toUpperCase(), path, body, opts.reason);
    if (!r.ok) {
        const res = httpResponse(false, r.status || 500, { code: r.code, message: r.message });
        throw res;
    }
    if (!onlyPrivacyIds(r.data)) {
        logger.warn(`Rejected response from ${instance} for ${method.toUpperCase()} ${opts.url}: it referenced non-privacy Discord IDs`);
        throw httpResponse(false, 502, { code: "bad_instance_response", message: "The privacy instance sent an invalid response" });
    }
    await adopt(instance, r.data);
    return httpResponse(true, r.status, mapSelf(instance, r.data));
}

// Discord acks many channels in one request; privacy channels go to their instance, the rest to
// Discord, so neither side sees the other's IDs.
async function splitBulkAck(original: (opts: any, ...rest: any[]) => any, self: any, opts: any, rest: any[]) {
    const byInstance = new Map<string, any[]>();
    const discord: any[] = [];
    for (const rs of opts.body.read_states) {
        const inst = idInstance.get(String(rs?.channel_id));
        if (!inst) discord.push(rs);
        else if (byInstance.has(inst)) byInstance.get(inst)!.push(rs);
        else byInstance.set(inst, [rs]);
    }
    await Promise.all([...byInstance].map(([inst, list]) =>
        routeToInstance(inst, "post", { ...opts, body: { read_states: list } }).catch(e => logger.warn(`bulk ack to ${inst} failed`, e))));
    if (discord.length) return original.call(self, { ...opts, body: { ...opts.body, read_states: discord } }, ...rest);
    return httpResponse(true, 204, null);
}

// Discord asks for your event RSVPs across all servers at once; each side answers for its own.
async function splitScheduledEvents(original: (opts: any, ...rest: any[]) => any, self: any, opts: any, rest: any[]) {
    const ids: string[] = [].concat(opts.query.guild_ids).map(String);
    const byInstance = new Map<string, string[]>();
    const discord: string[] = [];
    for (const id of ids) {
        const inst = idInstance.get(id);
        if (!inst) discord.push(id);
        else if (byInstance.has(inst)) byInstance.get(inst)!.push(id);
        else byInstance.set(inst, [id]);
    }
    const parts = await Promise.all([...byInstance].map(([inst, list]) =>
        routeToInstance(inst, "get", { ...opts, query: { ...opts.query, guild_ids: list } }).then(r => r.body ?? [], () => [])));
    const res = discord.length
        ? await original.call(self, { ...opts, query: { ...opts.query, guild_ids: discord } }, ...rest)
        : httpResponse(true, 200, []);
    return { ...res, body: [...(Array.isArray(res.body) ? res.body : []), ...parts.flat()] };
}

function wrapRestApi() {
    originalRest = {};
    for (const m of METHODS) {
        const original = RestAPI[m] as (opts: any, ...rest: any[]) => any;
        originalRest[m] = original;
        (RestAPI as any)[m] = function (this: any, opts: any, ...rest: any[]) {
            try {
                const o = typeof opts === "string" ? { url: opts } : opts;
                // Absolute URLs (e.g. an instance's upload URL) go out as-is, never to the instance API.
                if (typeof o?.url === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(o.url)) return original.call(this, opts, ...rest);
                if (m === "post" && o?.url === "/read-states/ack-bulk" && Array.isArray(o.body?.read_states))
                    return splitBulkAck(original, this, o, rest);
                if (m === "get" && o?.url === "/users/@me/scheduled-events" && o.query?.guild_ids != null)
                    return splitScheduledEvents(original, this, o, rest);
                const instance = o?.url && (instanceFor(String(o.url)) ?? (o.body !== undefined ? instanceFor(JSON.stringify(o.body)) : undefined));
                if (instance) {
                    const result = routeToInstance(instance, m, o);
                    // Some callers (e.g. the message queue) pass a callback and ignore the promise; it gets the
                    // response on success and failure, like Discord's HTTP util.
                    const callback = rest.find(x => typeof x === "function");
                    if (callback) result.then(callback, e => callback(e?.status != null ? e : { ok: false, hasErr: true, status: 0, headers: {}, body: null, err: e }));
                    return result;
                }
            } catch (e) {
                logger.error("routing failed", e); // falls through: the network filter still blocks privacy IDs
            }
            return original.call(this, opts, ...rest);
        };
    }
}

function unwrapRestApi() {
    for (const m of METHODS) if (originalRest[m]) (RestAPI as any)[m] = originalRest[m];
    originalRest = {};
}

// ---------- Plugin ----------

export default definePlugin({
    name: "PrivacyServers",
    description: "Adds self-hosted privacy servers to Discord's server list. Their data goes only to your instance, never to Discord.",
    authors: [PrivacyDWAuthor],
    dependencies: ["PrivacyHardening"],
    enabledByDefault: true,
    settings,

    patches: [
        {
            // Discover button in the server list: render the privacy-servers button right after it.
            find: '"guild-discover-button"',
            replacement: {
                match: /return(\(0,\i\.jsx\)\((\i),\{id:"guild-discover-button",.+?icon:\i\.CompassIcon\}\))/,
                replace: "return $self.withPrivacyButton($2,$1)"
            }
        },
        {
            // "Join a Server" submit: instance links and addresses are handled by the plugin and
            // never reach Discord (which would otherwise resolve the link's last segment as a code).
            find: '"hTKzmak"',
            replacement: {
                match: /(let (\i)=\i\.trim\(\);)(if\(""===\2\)return void (\i)\()(?=.{0,1500}?callback:\i=>\{(\i)\(\))/,
                replace: "$1if($self.joinFromInput($2,$4,$5))return;$3"
            }
        }
    ],

    withPrivacyButton,
    joinFromInput,

    start() {
        wrapRestApi();

        running = true;
        void eventLoop();
        void Native.connectAll();
        void Native.vaultStatus().then(s => {
            if (s === "locked") showToast({ text: "PrivacyDW is locked. Unlock it with the shield button under Discover in the server list.", variant: "default" });
        });
    },

    stop() {
        running = false;
        unwrapRestApi();
    }
});
