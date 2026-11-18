/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Renderer-side registry of privacy IDs, mirrored into the main-process network filter.

import { PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.PrivacyHardening as PluginNative<typeof import("./native")>;

export const privacyIds = new Set<string>();

const SNOWFLAKE_RE = /^\d{17,20}$/;
const SNOWFLAKE_SCAN = /\d{17,20}/g;
const MARKER_WORKER = 31n;

// Privacy instances mint snowflakes with worker bits = 31 (see server `snowflake.rs`).
export function isMarkedSnowflake(s: string): boolean {
    return SNOWFLAKE_RE.test(s) && ((BigInt(s) >> 17n) & 0x1fn) === MARKER_WORKER;
}

export function mentionsPrivacyId(text: string): boolean {
    if (!privacyIds.size) return false;
    for (const m of text.matchAll(SNOWFLAKE_SCAN)) if (privacyIds.has(m[0])) return true;
    return false;
}

// Every privacy snowflake inside an instance payload. Real Discord IDs carried in
// `privacy_discord_id` are skipped: registering them would block that real user's requests.
// Keys whose values look like snowflakes but aren't privacy IDs: real Discord IDs of linked users,
// client-generated nonces echoed back, and permission bitfields.
export const NOT_IDS = new Set(["privacy_discord_id", "nonce", "permissions", "allow", "deny"]);

export function collectPrivacyIds(value: unknown, out = new Set<string>()): Set<string> {
    if (typeof value === "string") {
        if (isMarkedSnowflake(value)) out.add(value);
    } else if (Array.isArray(value)) {
        for (const v of value) collectPrivacyIds(v, out);
    } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) if (!NOT_IDS.has(k)) collectPrivacyIds(v, out);
    }
    return out;
}

// Must be awaited BEFORE handing a payload to Discord: the main-process filter has to know the IDs
// before Discord can issue a request mentioning them (IPC and network are separate channels).
export async function registerPrivacyIds(ids: Iterable<string>): Promise<void> {
    const fresh: string[] = [];
    for (const id of ids) {
        if (!privacyIds.has(id)) {
            privacyIds.add(id);
            fresh.push(id);
        }
    }
    if (fresh.length) await Native.addPrivacyIds(fresh);
}
