/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface InstanceInfo {
    /** Stable identity of the instance, same on every node (newer servers). */
    instanceId?: string;
    name: string;
    protocolVersion: number;
    softwareVersion: string;
    auth: { discordClientId: string | null; localAccounts: boolean; };
}

export interface SavedInstance {
    url: string;
    info: InstanceInfo;
}

export interface PrivacyUser {
    id: string;
    sid: string;
    username: string;
    email: string | null;
    totpEnabled: boolean;
}

export type Result<T> = { ok: true; data: T; } | { ok: false; code: string; message: string; };
export type VaultStatus = "none" | "locked" | "unlocked";

// Pushed from main to renderer via the long-poll queue.
export type PrivacyEvent =
    | { instance: string; t: "READY"; d: { user: any; guilds: any[]; }; }
    | { instance: string; t: "DISCONNECTED"; d: { reason: string; }; }
    | { instance: string; t: string; d: any; };

export interface InstanceStatus {
    url: string;
    name: string;
    signedIn: boolean;
    user?: PrivacyUser;
    connected: boolean;
}
