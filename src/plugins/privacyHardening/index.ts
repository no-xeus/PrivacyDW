/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";

import { mentionsPrivacyId, privacyIds } from "./registry";

export const PrivacyDWAuthor = { name: "PrivacyDW", id: 0n };

const Native = VencordNative.pluginHelpers.PrivacyHardening as PluginNative<typeof import("./native")>;
const logger = new Logger("PrivacyHardening");

const GATEWAY_HEARTBEAT = 1;
const GUILD_SUBSCRIPTIONS_BULK = 37;
export const gatewayStats = { stripped: 0, dropped: 0 };

export default definePlugin({
    name: "PrivacyHardening",
    description: "Blocks Discord telemetry and crash dumps, and stops any Discord request or gateway message that mentions privacy-server data.",
    authors: [PrivacyDWAuthor],
    required: true,

    patches: [
        {
            // GatewaySocket.send: filter the payload before it is packed (ETF/JSON) and compressed,
            // where IDs are still plain strings. webRequest can't see WebSocket frames.
            find: "Attempted to send while not being in a connected state opcode",
            replacement: {
                match: /let (\i)=(\i)\.pack\(\{op:(\i),d:(\i)\}\);/,
                replace: "$4=$self.filterGatewayPayload($3,$4);if($4===null)return;let $1=$2.pack({op:$3,d:$4});"
            }
        }
    ],

    // Returns the payload to send (possibly with privacy guilds stripped), or null to drop it.
    // Runs inline in Discord's socket send: must never throw. Returns the payload to send (with
    // privacy guilds stripped if needed), or null to drop it.
    filterGatewayPayload(op: number, d: any): any {
        try {
            if (!privacyIds.size || d == null || !mentionsPrivacyId(JSON.stringify(d))) return d;

            if (op === GUILD_SUBSCRIPTIONS_BULK && d.subscriptions && typeof d.subscriptions === "object") {
                const subscriptions = Object.fromEntries(Object.entries(d.subscriptions).filter(([id]) => !privacyIds.has(id)));
                const out = { ...d, subscriptions };
                if (!mentionsPrivacyId(JSON.stringify(out))) {
                    gatewayStats.stripped++;
                    return Object.keys(subscriptions).length ? out : null;
                }
            }
            gatewayStats.dropped++;
            logger.warn(`Dropped gateway op ${op}: it mentioned privacy-server data`);
            return null;
        } catch (e) {
            // Can't tell whether it mentions privacy data: fail closed, except heartbeats, which
            // never carry IDs and would otherwise kill the connection.
            logger.error(`Gateway filter failed for op ${op}`, e);
            return op === GATEWAY_HEARTBEAT || !privacyIds.size ? d : null;
        }
    },

    async start() {
        logger.info("hardening active", await Native.getStats());
    },
});
