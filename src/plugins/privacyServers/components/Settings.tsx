/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { addGuild, guildInstance, Native } from "@plugins/privacyServers/bridge";
import type { InstanceStatus, VaultStatus } from "@plugins/privacyServers/types";
import { copyWithToast } from "@utils/discord";
import { ChannelStore, GuildStore, React, showToast, TextInput, useEffect, useState } from "@webpack/common";

const gap = { display: "flex", flexDirection: "column", gap: 8 } as const;
const row = { display: "flex", gap: 8, alignItems: "center" } as const;

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void] {
    const [value, setValue] = useState<T | null>(null);
    const [tick, setTick] = useState(0);
    useEffect(() => { let live = true; fn().then(v => live && setValue(v)); return () => { live = false; }; }, [...deps, tick]);
    return [value, () => setTick(t => t + 1)];
}

function Field({ label, ...props }: { label: string; value: string; onChange(v: string): void; type?: string; placeholder?: string; }) {
    return (
        <div style={{ ...gap, gap: 4, flex: 1 }}>
            <Heading tag="h5">{label}</Heading>
            <TextInput {...props as any} />
        </div>
    );
}

function VaultSection({ status, onChange }: { status: VaultStatus; onChange(): void; }) {
    const [pw, setPw] = useState("");
    const [confirm, setConfirm] = useState("");
    const [busy, setBusy] = useState(false);

    if (status === "unlocked") return (
        <div style={row}>
            <Paragraph>🔓 Vault unlocked. Sign-ins to your instances are available.</Paragraph>
            <Button size="small" variant="secondary" onClick={async () => { await Native.vaultLock(); onChange(); }}>Lock</Button>
        </div>
    );

    const creating = status === "none";
    const submit = async () => {
        if (creating && pw !== confirm) return showToast({ text: "Passwords do not match", variant: "critical" });
        setBusy(true);
        const r = creating ? await Native.vaultCreate(pw) : await Native.vaultUnlock(pw);
        setBusy(false);
        setPw("");
        setConfirm("");
        if (!r.ok) return showToast({ text: r.message, variant: "critical" });
        onChange();
    };

    return (
        <div style={gap}>
            <Paragraph>
                {creating
                    ? "Create a PrivacyDW password. It encrypts your instance sign-ins on this device and cannot be recovered."
                    : "🔒 Enter your PrivacyDW password to connect to your privacy servers."}
            </Paragraph>
            <div style={row}>
                <Field label="Password" type="password" value={pw} onChange={setPw} />
                {creating && <Field label="Confirm password" type="password" value={confirm} onChange={setConfirm} />}
            </div>
            <div style={row}>
                <Button disabled={busy || pw.length < 8} onClick={submit}>{creating ? "Create password" : "Unlock"}</Button>
                {!creating && (
                    <Button variant="dangerSecondary" size="small" onClick={async () => {
                        if (!window.confirm("Forget your PrivacyDW password? Saved sign-ins are erased; instances are kept.")) return;
                        await Native.vaultReset();
                        onChange();
                    }}>Forgot password? Reset</Button>
                )}
            </div>
        </div>
    );
}

function SignIn({ inst, onDone }: { inst: InstanceStatus; onDone(): void; }) {
    const [mode, setMode] = useState<"login" | "register">("login");
    const [name, setName] = useState("");
    const [pw, setPw] = useState("");
    const [totp, setTotp] = useState("");
    const [needTotp, setNeedTotp] = useState(false);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        setBusy(true);
        const r = mode === "login"
            ? await Native.login(inst.url, name, pw, needTotp ? totp : undefined)
            : await Native.register(inst.url, name, pw);
        setBusy(false);
        if (!r.ok) {
            if (r.code === "totp_required") return setNeedTotp(true);
            return showToast({ text: r.message, variant: "critical" });
        }
        showToast({ text: `Signed in to ${inst.name}`, variant: "success" });
        onDone();
    };

    return (
        <div style={gap}>
            <div style={row}>
                <Button size="small" variant={mode === "login" ? "primary" : "secondary"} onClick={() => setMode("login")}>Sign in</Button>
                <Button size="small" variant={mode === "register" ? "primary" : "secondary"} onClick={() => setMode("register")}>Create account</Button>
            </div>
            <div style={row}>
                <Field label={mode === "login" ? "Username or email" : "Username"} value={name} onChange={setName} />
                <Field label="Password" type="password" value={pw} onChange={setPw} />
                {needTotp && <Field label="2FA code" value={totp} onChange={setTotp} placeholder="123456" />}
            </div>
            <Button disabled={busy || !name || pw.length < 8} onClick={submit}>{mode === "login" ? "Sign in" : "Create account"}</Button>
        </div>
    );
}

// How others on this instance see you (your Discord profile is never sent to it).
function Profile({ inst }: { inst: InstanceStatus; }) {
    const [name, setName] = useState("");
    const [bio, setBio] = useState("");
    const [busy, setBusy] = useState(false);

    const save = async (body: Record<string, unknown>, done: string) => {
        setBusy(true);
        const r = await Native.rest(inst.url, "PATCH", "/users/@me", body);
        setBusy(false);
        if (!r.ok) return showToast({ text: r.message, variant: "critical" });
        showToast({ text: done, variant: "success" });
    };
    const pickAvatar = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/gif,image/webp";
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) return showToast({ text: "Avatars can be at most 10 MB", variant: "critical" });
            const reader = new FileReader();
            reader.onload = () => save({ avatar: String(reader.result) }, "Avatar updated");
            reader.readAsDataURL(file);
        };
        input.click();
    };

    return (
        <div style={gap}>
            <Heading tag="h5">Your profile on this instance</Heading>
            <div style={{ ...row, alignItems: "flex-end" }}>
                <Field label="Display name" value={name} onChange={setName} placeholder={inst.user?.username} />
                <Field label="About me" value={bio} onChange={setBio} />
                <Button disabled={busy || (!name.trim() && !bio.trim())} onClick={() => save({
                    ...(name.trim() ? { global_name: name.trim() } : {}), ...(bio.trim() ? { bio: bio.trim() } : {}),
                }, "Profile updated")}>Save</Button>
            </div>
            <div style={row}>
                <Button size="small" variant="secondary" disabled={busy} onClick={pickAvatar}>Change avatar</Button>
                <Button size="small" variant="secondary" disabled={busy} onClick={() => save({ avatar: null }, "Avatar removed")}>Remove avatar</Button>
            </div>
        </div>
    );
}

function ServerActions({ inst }: { inst: InstanceStatus; }) {
    const [newName, setNewName] = useState("");
    const [invite, setInvite] = useState("");
    const guilds = Object.values(GuildStore.getGuilds()).filter(g => guildInstance.get(g.id) === inst.url);

    const create = async () => {
        const r = await Native.createGuild(inst.url, newName);
        if (!r.ok) return showToast({ text: r.message, variant: "critical" });
        await addGuild(inst.url, r.data);
        setNewName("");
        showToast({ text: `Created ${r.data.name}`, variant: "success" });
    };
    const join = async () => {
        const r = await Native.joinInvite(inst.url, invite);
        if (!r.ok) return showToast({ text: r.message, variant: "critical" });
        await addGuild(inst.url, r.data);
        setInvite("");
        showToast({ text: `Joined ${r.data.name}`, variant: "success" });
    };

    return (
        <div style={gap}>
            <div style={{ ...row, alignItems: "flex-end" }}>
                <Field label="New server name" value={newName} onChange={setNewName} />
                <Button disabled={!newName.trim()} onClick={create}>Create server</Button>
            </div>
            <div style={{ ...row, alignItems: "flex-end" }}>
                <Field label="Invite code" value={invite} onChange={setInvite} />
                <Button disabled={!invite.trim()} onClick={join}>Join</Button>
            </div>
            {guilds.length > 0 && <Heading tag="h5">Your servers here</Heading>}
            {guilds.map(g => (
                <div key={g.id} style={row}>
                    <Paragraph style={{ flex: 1 }}>{g.name}</Paragraph>
                    <Button size="small" variant="secondary" onClick={async () => {
                        // Same call Discord's own invite dialog makes (routed to the instance).
                        const channel = Object.values(ChannelStore.getMutableGuildChannelsForGuild(g.id)).find(c => c.type === 0);
                        if (!channel) return showToast({ text: "This server has no text channel to invite to", variant: "critical" });
                        const r = await Native.rest(inst.url, "POST", `/channels/${channel.id}/invites`, { max_age: 7 * 24 * 3600 });
                        if (!r.ok) return showToast({ text: r.message, variant: "critical" });
                        copyWithToast(r.data.code, "Invite code copied (valid for 7 days)");
                    }}>Copy invite</Button>
                </div>
            ))}
        </div>
    );
}

function InstanceCard({ inst, onChange }: { inst: InstanceStatus; onChange(): void; }) {
    return (
        <div style={{ ...gap, padding: 12, borderRadius: 8, border: "1px solid var(--border-subtle, #3f4147)" }}>
            <div style={row}>
                <Heading tag="h4" style={{ flex: 1 }}>{inst.name}</Heading>
                <Paragraph>{inst.connected ? "🟢 connected" : inst.signedIn ? "🟡 connecting" : "⚪ signed out"}</Paragraph>
            </div>
            <Paragraph>{inst.url}{inst.user ? ` · signed in as ${inst.user.username}` : ""}</Paragraph>
            {inst.signedIn ? <><ServerActions inst={inst} /><Profile inst={inst} /></> : <SignIn inst={inst} onDone={onChange} />}
            <div style={row}>
                {inst.signedIn && <Button size="small" variant="secondary" onClick={async () => { await Native.logout(inst.url); onChange(); }}>Sign out</Button>}
                <Button size="small" variant="dangerSecondary" onClick={async () => {
                    if (!window.confirm(`Remove ${inst.name}? You will be signed out.`)) return;
                    await Native.removeInstance(inst.url);
                    onChange();
                }}>Remove instance</Button>
            </div>
        </div>
    );
}

export function SettingsPanel() {
    const [vault, refreshVault] = useAsync(() => Native.vaultStatus(), []);
    const [instances, refreshInstances] = useAsync(() => Native.status(), [vault]);
    const [url, setUrl] = useState("");
    const refresh = () => { refreshVault(); refreshInstances(); };

    // Connection state changes in the background; refresh periodically while the panel is open.
    useEffect(() => { const t = setInterval(refreshInstances, 3000); return () => clearInterval(t); }, []);

    if (!vault) return null;
    return (
        <div style={{ ...gap, gap: 16 }}>
            <VaultSection status={vault} onChange={refresh} />
            {vault === "unlocked" && (
                <>
                    {instances?.map(i => <InstanceCard key={i.url} inst={i} onChange={refresh} />)}
                    <div style={{ ...row, alignItems: "flex-end" }}>
                        <Field label="Add a privacy instance" value={url} onChange={setUrl} placeholder="chat.example.org or http://localhost:8080" />
                        <Button disabled={!url.trim()} onClick={async () => {
                            const r = await Native.addInstance(url);
                            if (!r.ok) return showToast({ text: r.message, variant: "critical" });
                            setUrl("");
                            refresh();
                        }}>Add</Button>
                    </div>
                </>
            )}
        </div>
    );
}
