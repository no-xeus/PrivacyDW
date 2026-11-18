/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Main-process hardening. Loaded by ipcPlugins before Discord's own code (see patcher.ts),
// so the crash reporter and request filter are in place before Discord can use them.

import { app, crashReporter, OnBeforeRequestListenerDetails, session } from "electron";
import { appendFileSync } from "fs";

import { decide, Downstream, Listener, matchPattern, privacyIds, SNOWFLAKE, stats, wants } from "./filter";

// ---------- 1. No crash dumps at all ----------
// Crashpad only runs once start() is called, so skipping it means no dumps are written or uploaded.
// Dumps contain process memory, which could include decrypted privacy-server content, and Discord
// annotates them with account details (email, username, user ID).
crashReporter.start = () => {
    console.info("[PrivacyDW] blocked crashReporter.start (no crash dumps will be written)");
};

// Dev-only: log the shape (never query strings or bodies) of every request, to build the blocklist.
const LOG_PATH = process.env.PRIVACYDW_REQUEST_LOG;
const logged = new Set<string>();
function logShape(d: OnBeforeRequestListenerDetails, verdict: string) {
    if (!LOG_PATH) return;
    try {
        const u = new URL(d.url);
        const line = `${verdict}\t${d.method}\t${u.host}${u.pathname.replace(SNOWFLAKE, ":id")}`;
        if (logged.has(line)) return;
        logged.add(line);
        appendFileSync(LOG_PATH, line + "\n");
    } catch { }
}

// Electron allows one onBeforeRequest listener per session; registering another replaces it.
// We install ours and wrap the method so later registrants (Discord, other code) are chained
// after our filter instead of silently replacing it.
function installFilter() {
    const wr = session.defaultSession.webRequest;
    const register = wr.onBeforeRequest.bind(wr);
    let downstream: Downstream | null = null;

    register((details, callback) => {
        const { verdict, response } = decide(details);
        logShape(details, verdict ?? "allow");
        if (verdict) {
            stats[verdict]++;
            return callback(response);
        }
        if (downstream && wants(downstream, details)) return downstream.listener(details, callback);
        callback({});
    });

    // Later registrants are chained behind our filter, honouring their own URL filter.
    wr.onBeforeRequest = ((filterOrListener: any, maybeListener?: any) => {
        const hasFilter = typeof filterOrListener !== "function";
        const listener: Listener | null = hasFilter ? maybeListener ?? null : filterOrListener;
        const filter: Electron.WebRequestFilter | null = hasFilter ? filterOrListener : null;
        downstream = listener && {
            listener,
            include: filter?.urls?.length ? filter.urls.map(matchPattern) : null,
            exclude: (filter?.excludeUrls ?? []).map(matchPattern),
            types: filter?.types?.length ? new Set(filter.types) : null,
        };
        console.info("[PrivacyDW] chained onBeforeRequest listener behind the privacy filter", JSON.stringify(filter?.urls ?? "<all>"));
    }) as typeof wr.onBeforeRequest;
}

app.whenReady().then(installFilter);

// ---------- Renderer-callable natives ----------

export function addPrivacyIds(_: unknown, ids: unknown) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (typeof id === "string" && /^\d{17,20}$/.test(id)) privacyIds.add(id);
}

export function getStats() {
    return { ...stats, privacyIds: privacyIds.size };
}
