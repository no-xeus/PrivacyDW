/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure request-classification logic (no Electron imports) so it can be unit-tested.

import type { OnBeforeRequestListenerDetails } from "electron";

// ---------- 2. Analytics / telemetry blocklist ----------
// Initial list; refined from observed traffic (PRIVACYDW_REQUEST_LOG). Patterns match host + path.
export const TELEMETRY: RegExp[] = [
    /^discord\.com\/api\/v\d+\/science\b/,
    /^discord\.com\/api\/v\d+\/track\b/,
    /^discord\.com\/api\/v\d+\/metrics\b/,
    /^discord\.com\/error-reporting-proxy\b/,
    /(^|\.)sentry\.io\//,
    /(^|\.)dc-telemetry\.net\//, // network measurement beacons
];
// Custom protocols used to ferry telemetry from the renderer to the main process.
const TELEMETRY_PROTOCOLS = new Set(["sentry-ipc:"]);

// ---------- 3. Fail-closed privacy-ID filter ----------
// Any request to Discord mentioning a privacy guild/channel/message/user ID is cancelled, so a
// gap in our renderer interception can never send privacy data to Discord.
// IDs can only be added, never removed: Discord's renderer code can call plugin natives too.
export const privacyIds = new Set<string>();
export const SNOWFLAKE = /\d{17,20}/g;
const DISCORD_HOST = /(^|\.)(discord\.com|discordapp\.com|discordapp\.net|discord\.gg|discord\.media)$/;

export const stats = { telemetry: 0, privacy: 0 };

export function mentionsPrivacyId(text: string): boolean {
    if (!privacyIds.size) return false;
    for (const m of text.matchAll(SNOWFLAKE)) if (privacyIds.has(m[0])) return true;
    return false;
}

// Encodings protobuf uses for 64-bit IDs: fixed64 (8 bytes little-endian) and varint.
function binaryForms(id: string): Buffer[] {
    let n = BigInt(id);
    const fixed = Buffer.alloc(8);
    fixed.writeBigUInt64LE(n);
    const varint: number[] = [];
    do {
        let b = Number(n & 0x7fn);
        n >>= 7n;
        if (n) b |= 0x80;
        varint.push(b);
    } while (n);
    return [fixed, Buffer.from(varint)];
}

// Discord syncs settings (guild folders/order, per-guild settings) as base64 protobuf, where IDs
// are binary and invisible to the text check. Decode `{"settings":"<base64>"}` bodies and search
// for the binary encodings of privacy IDs.
export function settingsProtoMentionsPrivacyId(body: string): boolean {
    if (!privacyIds.size) return false;
    let b64: unknown;
    try { b64 = JSON.parse(body)?.settings; } catch { return false; }
    if (typeof b64 !== "string") return false;
    const bytes = Buffer.from(b64, "base64");
    for (const id of privacyIds)
        for (const form of binaryForms(id)) if (bytes.includes(form)) return true;
    return false;
}

function bodyText(d: OnBeforeRequestListenerDetails): string {
    if (!d.uploadData) return "";
    return d.uploadData.map(p => (p.bytes ? p.bytes.toString("latin1") : "")).join("");
}

export type Verdict = "telemetry" | "privacy" | null;
export function classify(d: OnBeforeRequestListenerDetails): Verdict {
    let u: URL;
    try { u = new URL(d.url); } catch { return null; }
    if (u.protocol === "devtools:" || u.protocol === "vencord:" || u.protocol === "file:") return null;
    if (TELEMETRY_PROTOCOLS.has(u.protocol)) return "telemetry";
    const hostPath = u.host + u.pathname;
    if (TELEMETRY.some(r => r.test(hostPath))) return "telemetry";
    if (DISCORD_HOST.test(u.hostname)) {
        const body = bodyText(d);
        if (mentionsPrivacyId(d.url) || mentionsPrivacyId(body)) return "privacy";
        if (/\/settings-proto\//.test(u.pathname) && settingsProtoMentionsPrivacyId(body)) return "privacy";
    }
    return null;
}

// Chrome-style match pattern (`scheme://host/path`, `*` wildcards, `<all_urls>`) → RegExp.
export function matchPattern(pattern: string): RegExp {
    if (pattern === "<all_urls>") return /^/;
    const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
    if (!m) return /$^/; // invalid pattern matches nothing
    const esc = (x: string) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const [, scheme, host, path = "/*"] = m;
    const schemeRe = scheme === "*" ? "https?" : esc(scheme);
    const hostRe = host === "*" ? "[^/]*" : host.startsWith("*.") ? `(?:[^/]*\\.)?${esc(host.slice(2))}` : esc(host);
    const pathRe = esc(path).replace(/\*/g, ".*");
    return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, "i");
}

export type Listener = (d: OnBeforeRequestListenerDetails, cb: (r: Electron.CallbackResponse) => void) => void;
export interface Downstream {
    listener: Listener;
    include: RegExp[] | null; // null = all URLs
    exclude: RegExp[];
    types: Set<string> | null;
}

export function wants(ds: Downstream, d: OnBeforeRequestListenerDetails): boolean {
    if (ds.types && !ds.types.has(d.resourceType)) return false;
    if (ds.exclude.some(r => r.test(d.url))) return false;
    return !ds.include || ds.include.some(r => r.test(d.url));
}


// ---------- 4. Privacy media ----------
// Discord builds CDN URLs (icons, avatars, emojis, stickers, attachments) itself. For privacy IDs
// they're redirected to the owning instance's /cdn instead of cancelled, so the media loads and
// Discord never sees the request. PrivacyServers installs the resolver (it knows the instances).
const MEDIA_HOST = /^(cdn\.discordapp\.com|media\.discordapp\.net)$/;
let ownerOf: ((id: string) => string | undefined) | null = null;

/** Installs the privacy ID → instance origin lookup used for media redirects. */
export function setMediaResolver(resolver: ((id: string) => string | undefined) | null) {
    ownerOf = resolver;
}

// Only when every ID in the path is a privacy ID of one instance: a real Discord ID in the path
// must not reach the instance either.
export function mediaRedirect(url: string): string | null {
    if (!ownerOf) return null;
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== "https:" || !MEDIA_HOST.test(u.hostname)) return null;
    let origin: string | undefined;
    for (const m of u.pathname.matchAll(SNOWFLAKE)) {
        const owner = privacyIds.has(m[0]) ? ownerOf(m[0]) : undefined;
        if (!owner || (origin && owner !== origin)) return null;
        origin = owner;
    }
    return origin ? `${origin}/cdn${u.pathname}${u.search}` : null;
}

export const SAFE_LANDING = "https://discord.com/app";

// What the network filter does with a request. Privacy-ID page loads (e.g. reloading while a
// privacy channel is open, URL /channels/<privacy guild>/...) are redirected to Discord's home
// instead of cancelled: cancelling a page load leaves a broken error page, and the IDs still
// never reach Discord either way.
export function decide(d: OnBeforeRequestListenerDetails): { verdict: Verdict; response: Electron.CallbackResponse; } {
    const verdict = classify(d);
    if (verdict === "privacy" && (d.resourceType === "mainFrame" || d.resourceType === "subFrame"))
        return { verdict, response: { redirectURL: SAFE_LANDING } };
    if (verdict === "privacy" && d.method === "GET") {
        const to = mediaRedirect(d.url);
        if (to) return { verdict, response: { redirectURL: to } };
    }
    return { verdict, response: verdict ? { cancel: true } : {} };
}
