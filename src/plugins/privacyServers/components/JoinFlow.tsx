/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { addGuild, Native } from "@plugins/privacyServers/bridge";
import type { InstanceStatus, SavedInstance, VaultStatus } from "@plugins/privacyServers/types";
import { Modal, NavigationRouter, openModal, React, showToast, useEffect, useState } from "@webpack/common";

import { Field, gap, row, SignIn, VaultSection } from "./Settings";

/** What was typed in Discord's "Join a Server" box, when it points at a privacy instance. */
export interface PrivacyTarget {
    origin: string;
    /** From an invite link (`https://<instance>/invite/<code>`); absent for a bare address. */
    code?: string;
}

const DISCORD_HOSTS = /(^|\.)(discord\.gg|discord\.com|discordapp\.com|discord\.new|discord\.gift)$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `null` for anything Discord should handle (a bare invite code, a discord.gg link). Instance
 * addresses and links never reach Discord: the "Join a Server" box hands them to the plugin.
 * Returns `"invalid"` for something that looks like an address but can't be one.
 */
export function parsePrivacyInput(raw: string): PrivacyTarget | "invalid" | null {
    const s = raw.trim();
    // A plain code (letters, digits, dashes) is a Discord invite.
    if (!/[.:/]/.test(s)) return null;
    let url: URL;
    try {
        const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
        const host = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/:?#]/)[0].toLowerCase();
        url = new URL(hasScheme ? s : `${LOCAL_HOSTS.has(host) ? "http" : "https"}://${s}`);
    } catch {
        return "invalid";
    }
    if (DISCORD_HOSTS.test(url.hostname)) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return "invalid";
    if (!url.hostname.includes(".") && !LOCAL_HOSTS.has(url.hostname)) return "invalid";
    const m = url.pathname.match(/^\/invites?\/([A-Za-z0-9_-]{4,32})\/?$/);
    return { origin: url.origin, code: m?.[1] };
}

type Phase =
    | { kind: "working"; text: string; }
    | { kind: "vault"; status: VaultStatus; }
    | { kind: "instance"; info: SavedInstance; }
    | { kind: "account"; inst: InstanceStatus; }
    | { kind: "server"; inst: InstanceStatus; mine: { id: string; name: string; }[]; error?: string; }
    | { kind: "error"; text: string; };

const STEPS = ["Instance", "Account", "Server"] as const;

/** ① Instance ✓ ─ ② Account ─ ③ Server */
function Progress({ at }: { at: number; }) {
    return (
        <div style={{ ...row, gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
            {STEPS.map((name, i) => (
                <React.Fragment key={name}>
                    {i > 0 && <span style={{ color: "var(--text-muted)" }}>─</span>}
                    <span style={{
                        fontWeight: i === at ? 700 : 500,
                        color: i < at ? "var(--text-positive, #23a55a)" : i === at ? "var(--header-primary, #fff)" : "var(--text-muted)",
                    }}>
                        {i < at ? "✓" : `${i + 1}.`} {name}
                    </span>
                </React.Fragment>
            ))}
        </div>
    );
}

/**
 * The servers this account is in on the instance, asked from the instance itself (not from what
 * the live connection has delivered so far), and loaded into Discord's server list right away.
 */
async function myServers(url: string): Promise<{ id: string; name: string; }[]> {
    const r = await Native.rest(url, "GET", "/users/@me/guilds");
    if (!r.ok || !Array.isArray(r.data)) return [];
    for (const g of r.data) await addGuild(url, g);
    return r.data.map((g: any) => ({ id: String(g.id), name: String(g.name) }));
}

function JoinFlow({ target, onClose }: { target: PrivacyTarget; onClose(): void; }) {
    const [phase, setPhase] = useState<Phase>({ kind: "working", text: "Connecting…" });
    const [code, setCode] = useState(target.code ?? "");
    const [run, setRun] = useState(0);
    const again = () => setRun(n => n + 1);
    // Set by the Instance step's button; the instance is only added once the user agrees.
    const [confirmed, setConfirmed] = useState(false);
    const [joinNow, setJoinNow] = useState(!!target.code);

    const open = (guildId: string, text: string) => {
        onClose();
        showToast({ text, variant: "success" });
        NavigationRouter.transitionToGuild(guildId);
    };

    useEffect(() => {
        let live = true;
        const go = (p: Phase) => live && setPhase(p);
        (async () => {
            const vault = await Native.vaultStatus();
            if (vault !== "unlocked") return go({ kind: "vault", status: vault });

            // 1. Instance: shown, and added only after the user confirms.
            let inst = (await Native.status()).find(i => i.url === target.origin);
            if (!inst) {
                if (!confirmed) {
                    go({ kind: "working", text: `Contacting ${target.origin}…` });
                    const info = await Native.probeInstance(target.origin);
                    return go(info.ok ? { kind: "instance", info: info.data } : { kind: "error", text: info.message });
                }
                const added = await Native.addInstance(target.origin);
                if (!added.ok) return go({ kind: "error", text: added.message });
                inst = (await Native.status()).find(i => i.url === added.data.url);
                if (!inst) return go({ kind: "error", text: "The instance could not be added" });
            }

            // 2. Account.
            if (!inst.signedIn) return go({ kind: "account", inst });

            // 3. Server: join with the link's (or typed) code; with only an address, show the
            // servers this account is already in and offer joining another one.
            go({ kind: "working", text: "Loading your servers…" });
            const mine = await myServers(inst.url);
            if (!joinNow || !code.trim()) {
                // Only an address, and this account is already in servers there: onboarding is
                // done, go to the server. The code is only asked from people with no server yet.
                if (mine.length) return live && open(mine[0].id, mine.length === 1 ? `Welcome back to ${mine[0].name}` : `Welcome back: your ${mine.length} servers on ${inst.name} are in your server list`);
                return go({ kind: "server", inst, mine });
            }
            go({ kind: "working", text: "Joining…" });
            const before = new Set(mine.map(g => g.id));
            const r = await Native.joinInvite(inst.url, code);
            if (!r.ok) {
                setJoinNow(false);
                return go(target.code && code === target.code ? { kind: "error", text: r.message } : { kind: "server", inst, mine, error: r.message });
            }
            await addGuild(inst.url, r.data);
            if (live) open(r.data.id, before.has(r.data.id) ? `You're already in ${r.data.name}` : `Joined ${r.data.name}`);
        })().catch(e => go({ kind: "error", text: String(e?.message ?? e) }));
        return () => { live = false; };
    }, [run]);

    const host = target.origin.replace(/^https?:\/\//, "");
    switch (phase.kind) {
        case "working":
            return <Paragraph>{phase.text}</Paragraph>;
        case "error":
            return (
                <div style={gap}>
                    <Paragraph>{phase.text}</Paragraph>
                    <div style={row}><Button variant="secondary" onClick={onClose}>Close</Button></div>
                </div>
            );
        case "vault":
            return (
                <div style={gap}>
                    <Paragraph>Sign-ins to privacy servers are kept in your PrivacyDW vault. {phase.status === "none" ? "Create" : "Unlock"} it to continue.</Paragraph>
                    <VaultSection status={phase.status} onChange={again} />
                </div>
            );
        case "instance":
            return (
                <div style={gap}>
                    <Progress at={0} />
                    <Paragraph><b>{phase.info.info.name}</b> is a privacy instance at <b>{host}</b>.</Paragraph>
                    <Paragraph>Its servers' messages and files go only to this instance, never to Discord. Add it to continue.</Paragraph>
                    <div style={row}>
                        <Button onClick={() => { setConfirmed(true); again(); }}>Add instance</Button>
                        <Button variant="secondary" onClick={onClose}>Cancel</Button>
                    </div>
                </div>
            );
        case "account":
            return (
                <div style={gap}>
                    <Progress at={1} />
                    <Paragraph>Sign in to <b>{phase.inst.name}</b> or create an account there. It's separate from your Discord account, which is never sent to the instance.</Paragraph>
                    <SignIn inst={phase.inst} onDone={again} />
                </div>
            );
        case "server":
            return (
                <div style={gap}>
                    <Progress at={2} />
                    <Paragraph>
                        Enter the code of the server you want to join on <b>{phase.inst.name}</b>: its daily code
                        (like <code>ABCD-EFGH</code>) or an invite code. The server's members can give it to you.
                    </Paragraph>
                    <div style={{ ...row, alignItems: "flex-end" }}>
                        <Field label="Invite code" value={code} onChange={setCode} placeholder="ABCD-EFGH" />
                        <Button disabled={!code.trim()} onClick={() => { setJoinNow(true); again(); }}>Join</Button>
                    </div>
                    {phase.error && <Paragraph style={{ color: "var(--text-danger, #f23f43)" }}>{phase.error}</Paragraph>}
                </div>
            );
    }
}

export function openJoinFlow(target: PrivacyTarget) {
    openModal(props => (
        <Modal {...props} title="Join a privacy server">
            <ErrorBoundary>
                <JoinFlow target={target} onClose={props.onClose} />
            </ErrorBoundary>
        </Modal>
    ));
}

/**
 * Called by the patched "Join a Server" submit handler before Discord resolves the invite.
 * Returns true when the input was ours (then nothing is sent to Discord).
 */
export function joinFromInput(input: string, setError: (e: string | null) => void, closeDiscordModal: () => void): boolean {
    const target = parsePrivacyInput(input);
    if (target === null) return false;
    if (target === "invalid") {
        setError("That isn't a valid privacy server address or invite link (https is required, except for localhost).");
        return true;
    }
    setError(null);
    closeDiscordModal();
    openJoinFlow(target);
    return true;
}
