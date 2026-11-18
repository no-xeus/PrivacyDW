/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Translates instance payloads into Discord gateway events (shared by plugin and settings UI).

import { collectPrivacyIds, isMarkedSnowflake, NOT_IDS, registerPrivacyIds } from "@plugins/privacyHardening/registry";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { UserStore } from "@webpack/common";

import type { PrivacyEvent } from "./types";

export const Native = VencordNative.pluginHelpers.PrivacyServers as PluginNative<typeof import("./native")>;
export const logger = new Logger("PrivacyServers");
const GatewayConnectionStore = findByPropsLazy("getSocket");

// Which instance owns which guild, and each instance's snowflake for "me".
export const guildInstance = new Map<string, string>();
const selfSid = new Map<string, string>();
// Every privacy ID seen, mapped to the instance that minted it (used to route REST calls).
export const idInstance = new Map<string, string>();

// ---------- Payload translation ----------

// Show the logged-in Discord user wherever the instance refers to "me", so own messages render
// as yours. Done after ID registration: the real Discord ID is never registered as private.
export function mapSelf(instance: string, value: any): any {
    const sid = selfSid.get(instance);
    const me = UserStore.getCurrentUser();
    if (!sid || !me) return value;
    const meUser = {
        id: me.id, username: me.username, global_name: (me as any).globalName ?? null,
        avatar: me.avatar, discriminator: me.discriminator, public_flags: (me as any).publicFlags ?? 0, bot: false
    };
    const walk = (v: any): any => {
        // Also inside text, e.g. mentions (`<@sid>`) in message content.
        if (typeof v === "string") return v.includes(sid) ? v.split(sid).join(me.id) : v;
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
            if (v.id === sid && "username" in v) return { ...meUser };
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        }
        return v;
    };
    return walk(value);
}

function trackGuild(instance: string, guild: any) {
    guildInstance.set(guild.id, instance);
}

// Prepares an outgoing request: your real Discord ID becomes your snowflake on that instance, and
// BigInts (Discord passes permission bitfields as BigInt) become decimal strings for JSON.
export function unmapSelf(instance: string, value: any): any {
    const sid = selfSid.get(instance);
    const myId = UserStore.getCurrentUser()?.id;
    const walk = (v: any): any => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "string") return sid && myId ? v.split(myId).join(sid) : v;
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    return walk(value);
}

// Registers every privacy ID in an instance payload (awaited before Discord sees it) and records
// which instance owns it.
export async function adopt(instance: string, data: unknown) {
    const ids = collectPrivacyIds(data);
    await registerPrivacyIds(ids);
    const fresh = [...ids].filter(id => !idInstance.has(id));
    for (const id of ids) idInstance.set(id, instance);
    // Lets the network filter send this instance's media requests to it.
    if (fresh.length) await Native.claimIds(instance, fresh);
}

const SNOWFLAKE_SCAN = /\b\d{17,20}\b/g;

// An instance may only talk about its own (marked) objects. Rejects payloads carrying real Discord
// IDs, so a malicious instance can't e.g. send GUILD_DELETE for one of your real servers.
// Free text may quote Discord IDs (pasted links, `<#channel>`); Discord never treats those as objects
// the instance owns, so they aren't checked. Structured fields are.
const FREE_TEXT = new Set(["content", "description", "title", "value", "text", "topic", "bio", "custom_message"]);

export function onlyPrivacyIds(data: unknown): boolean {
    const json = JSON.stringify(data, (k, v) => NOT_IDS.has(k) || (FREE_TEXT.has(k) && typeof v === "string") ? undefined : v);
    for (const m of json.matchAll(SNOWFLAKE_SCAN)) if (!isMarkedSnowflake(m[0])) return false;
    return true;
}

// The instance owning the first privacy ID mentioned in `text`, if any.
export function instanceFor(text: string): string | undefined {
    for (const m of text.matchAll(SNOWFLAKE_SCAN)) {
        const inst = idInstance.get(m[0]);
        if (inst) return inst;
    }
}

// Hand a gateway-format event to Discord's own gateway pipeline.
function dispatchGateway(type: string, data: any) {
    GatewayConnectionStore.getSocket().dispatcher.receiveDispatch(data, type);
}

export async function ingest(instance: string, type: string, data: any) {
    if (!onlyPrivacyIds(data)) {
        logger.warn(`Ignored ${type} from ${instance}: it referenced non-privacy Discord IDs`);
        return;
    }
    // Fail-closed ordering: the network filter and gateway guard must know every ID first.
    await adopt(instance, data);
    if (type === "GUILD_CREATE") trackGuild(instance, data);
    dispatchGateway(type, mapSelf(instance, data));
}

const VALID_EVENT = /^[A-Z][A-Z_]{2,48}$/;

export async function handle(ev: PrivacyEvent) {
    if (ev.t === "READY") {
        const { d } = ev as any;
        selfSid.set(ev.instance, d.user.id);
        for (const g of d.guilds) await ingest(ev.instance, "GUILD_CREATE", g);
        // Unread state: replayed as "mark unread" acks so Discord restores the ack point and mention count.
        for (const rs of d.privacy_read_states ?? [])
            await ingest(ev.instance, "MESSAGE_ACK", { channel_id: rs.id, message_id: rs.last_message_id, mention_count: rs.mention_count, manual: true, ack_type: 0, version: 0 });
        logger.info(`connected to ${ev.instance}: ${d.guilds.length} server(s)`);
    } else if (ev.t === "DISCONNECTED") {
        logger.info(`disconnected from ${ev.instance}: ${(ev as any).d.reason}`);
    } else if (VALID_EVENT.test(ev.t) && ev.d && typeof ev.d === "object") {
        await ingest(ev.instance, ev.t, ev.d);
    }
}

// Used by the settings panel after creating/joining a server (the gateway may deliver it too).
export async function addGuild(instance: string, guild: any) {
    if (!guildInstance.has(guild.id)) await ingest(instance, "GUILD_CREATE", guild);
}
