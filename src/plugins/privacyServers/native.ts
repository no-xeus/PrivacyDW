/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Main process: vault, instances, sign-in, API client and gateway connections.
// Tokens never leave this process. Every export here is callable from Discord's renderer (Vencord
// plugin natives are plain IPC handlers), so none of them returns a token or the vault password.

import { CspPolicies, ImageAndMediaSrc } from "@main/csp";
import { app } from "electron";
import { mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

import { setMediaResolver } from "../privacyHardening/filter";
import type { InstanceInfo, InstanceStatus, PrivacyEvent, PrivacyUser, Result, SavedInstance, VaultStatus } from "./types";
import { Vault, WrongPasswordError } from "./vault";

const PROTOCOL_VERSION = 1;
// Next to Discord's profile. DISCORD_USER_DATA_DIR is read directly: Discord applies it only after
// this module loads, so app.getPath("userData") would still point at the default profile.
const DATA_DIR = process.env.PRIVACYDW_DATA_DIR
    ?? join(process.env.DISCORD_USER_DATA_DIR ?? app.getPath("userData"), "..", "PrivacyDW");
mkdirSync(DATA_DIR, { recursive: true });
const INSTANCES_PATH = join(DATA_DIR, "privacydw-instances.json");

interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number; }
interface VaultData { sessions: Record<string, TokenPair>; }

const vault = new Vault<VaultData>(join(DATA_DIR, "privacydw-vault.json"), () => ({ sessions: {} }));

// ---------- Event queue (long-polled by the renderer) ----------

const queue: PrivacyEvent[] = [];
let waiter: ((events: PrivacyEvent[]) => void) | null = null;

function push(event: PrivacyEvent) {
    queue.push(event);
    if (waiter) {
        const w = waiter;
        waiter = null;
        w(queue.splice(0));
    }
}

export function nextEvents(): Promise<PrivacyEvent[]> {
    if (queue.length) return Promise.resolve(queue.splice(0));
    waiter?.([]); // a previous poller (e.g. before a renderer reload) gets released
    return new Promise(resolve => {
        waiter = resolve;
        setTimeout(() => {
            if (waiter === resolve) {
                waiter = null;
                resolve([]);
            }
        }, 25_000);
    });
}

// ---------- Instances ----------

// Media: Discord CDN requests for privacy IDs are redirected to the instance that owns the ID
// (see privacyHardening/filter.ts), and the page may load media from (and upload to) instances.
const owners = new Map<string, string>();
const origins = new Set<string>();

function allowOrigin(url: string) {
    origins.add(url);
    CspPolicies[url] = ImageAndMediaSrc; // applies from the next page load
}

function forgetOrigin(url: string) {
    origins.delete(url);
    delete CspPolicies[url];
    for (const [id, owner] of owners) if (owner === url) owners.delete(id);
}

setMediaResolver(id => {
    const owner = owners.get(id);
    return owner && origins.has(owner) ? owner : undefined;
});

// Called by the renderer for IDs it has seen from an instance. First claim wins, so one instance
// can't take over another's media.
export async function claimIds(_: unknown, url: string, ids: unknown) {
    url = await known(url);
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (typeof id === "string" && /^\d{17,20}$/.test(id) && !owners.has(id)) owners.set(id, url);
}

async function loadInstances(): Promise<SavedInstance[]> {
    try {
        return JSON.parse(await readFile(INSTANCES_PATH, "utf8"));
    } catch {
        return [];
    }
}

void loadInstances().then(list => list.forEach(i => allowOrigin(i.url)));

async function known(url: unknown): Promise<string> {
    if (typeof url !== "string" || !(await loadInstances()).some(i => i.url === url)) throw new Error("Unknown instance");
    return url;
}

function normalizeUrl(raw: string): string | null {
    const s = raw.trim();
    try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
        if (u.protocol === "http:" && !local) return null; // plain http only for local dev
        return u.origin;
    } catch {
        return null;
    }
}

export async function listInstances(): Promise<SavedInstance[]> {
    return loadInstances();
}

export async function addInstance(_: unknown, raw: string): Promise<Result<SavedInstance>> {
    const url = normalizeUrl(String(raw));
    if (!url) return { ok: false, code: "invalid_url", message: "Invalid URL (https required for remote instances)" };
    let info: InstanceInfo;
    try {
        const res = await fetch(`${url}/.well-known/privacy-instance`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { ok: false, code: "http_error", message: `Instance responded ${res.status}` };
        info = await res.json();
    } catch (e) {
        return { ok: false, code: "network", message: `Could not reach instance: ${(e as Error).message}` };
    }
    if (typeof info?.name !== "string" || info.protocolVersion !== PROTOCOL_VERSION)
        return { ok: false, code: "unsupported", message: "Not a supported privacy instance" };
    const list = (await loadInstances()).filter(i => i.url !== url);
    const saved = { url, info };
    list.push(saved);
    await writeFile(INSTANCES_PATH, JSON.stringify(list, null, 2));
    allowOrigin(url);
    return { ok: true, data: saved };
}

export async function removeInstance(_: unknown, url: string) {
    url = await known(url);
    disconnect(url);
    forgetOrigin(url);
    if (vault.unlocked) await vault.update(d => delete d.sessions[url]);
    await writeFile(INSTANCES_PATH, JSON.stringify((await loadInstances()).filter(i => i.url !== url), null, 2));
}

// ---------- HTTP ----------

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function raw<T>(base: string, method: Method, path: string, body?: unknown, token?: string, reason?: string): Promise<Result<T> & { status: number; }> {
    try {
        const res = await fetch(base + path, {
            method,
            headers: {
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(reason ? { "x-audit-log-reason": encodeURIComponent(reason.slice(0, 512)) } : {})
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15_000)
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (res.ok) return { ok: true, data: json as T, status: res.status };
        return { ok: false, code: json?.code ?? "http_error", message: json?.message ?? `HTTP ${res.status}`, status: res.status };
    } catch (e) {
        return { ok: false, code: "network", message: `Could not reach instance: ${(e as Error).message}`, status: 0 };
    }
}

const strip = <T>({ status: _, ...r }: Result<T> & { status: number; }): Result<T> => r as Result<T>;

function session(url: string): TokenPair | undefined {
    return vault.unlocked ? vault.read().sessions[url] : undefined;
}

const refreshing = new Map<string, Promise<TokenPair | null>>();

// Single-flight per instance: parallel 401s must not burn the rotating refresh token twice.
function refresh(url: string): Promise<TokenPair | null> {
    let p = refreshing.get(url);
    if (!p) {
        p = (async () => {
            const t = session(url);
            if (!t) return null;
            const r = await raw<TokenPair>(url, "POST", "/auth/refresh", { refreshToken: t.refreshToken });
            if (r.ok) {
                await vault.update(d => { d.sessions[url] = r.data; });
                return r.data;
            }
            if (r.status === 401) await vault.update(d => { delete d.sessions[url]; });
            return null;
        })().finally(() => refreshing.delete(url));
        refreshing.set(url, p);
    }
    return p;
}

async function authedRaw<T>(url: string, method: Method, path: string, body?: unknown, reason?: string) {
    const t = session(url);
    if (!t) return { ok: false, code: "unauthorized", message: vault.unlocked ? "Not signed in" : "Vault is locked", status: 401 } as Result<T> & { status: number; };
    let r = await raw<T>(url, method, path, body, t.accessToken, reason);
    if (r.status === 401) {
        const fresh = await refresh(url);
        if (!fresh) return { ok: false, code: "unauthorized", message: "Session expired, sign in again", status: 401 } as Result<T> & { status: number; };
        r = await raw<T>(url, method, path, body, fresh.accessToken, reason);
    }
    return r;
}

async function authed<T>(url: string, method: Method, path: string, body?: unknown): Promise<Result<T>> {
    return strip(await authedRaw<T>(url, method, path, body));
}

const METHODS = new Set<Method>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Generic Discord-API passthrough: the renderer routes any Discord REST call that mentions a
// privacy ID here, and the instance implements the same paths. Only relative API paths allowed.
export async function rest(_: unknown, url: string, method: string, path: string, body?: unknown, reason?: string) {
    url = await known(url);
    const m = String(method).toUpperCase() as Method;
    const p = String(path);
    if (!METHODS.has(m) || !p.startsWith("/") || p.startsWith("//") || p.includes("..") || /[\s\\]/.test(p))
        return { ok: false as const, status: 400, code: "invalid_request", message: "Invalid request" };
    return authedRaw<any>(url, m, p, body, typeof reason === "string" ? reason : undefined);
}

// ---------- Vault ----------

export async function vaultStatus(): Promise<VaultStatus> {
    return vault.unlocked ? "unlocked" : (await vault.exists()) ? "locked" : "none";
}

export async function vaultCreate(_: unknown, password: string): Promise<Result<null>> {
    if (await vault.exists()) return { ok: false, code: "exists", message: "A vault already exists" };
    try {
        await vault.create(String(password));
        return { ok: true, data: null };
    } catch (e) {
        return { ok: false, code: "invalid", message: (e as Error).message };
    }
}

export async function vaultUnlock(_: unknown, password: string): Promise<Result<null>> {
    try {
        await vault.unlock(String(password));
    } catch (e) {
        return { ok: false, code: "wrong_password", message: e instanceof WrongPasswordError ? "Wrong password" : (e as Error).message };
    }
    void connectAll();
    return { ok: true, data: null };
}

export function vaultLock() {
    for (const url of [...sockets.keys()]) disconnect(url);
    vault.lock();
}

// Forgotten password: erase saved sign-ins (instances are kept).
export async function vaultReset() {
    vaultLock();
    await vault.destroy();
}

// ---------- Auth ----------

async function signedIn(url: string, r: Result<TokenPair>): Promise<Result<PrivacyUser>> {
    if (!r.ok) return r;
    await vault.update(d => { d.sessions[url] = r.data; });
    connect(url);
    return authed<PrivacyUser>(url, "GET", "/users/@me");
}

export async function login(_: unknown, url: string, loginName: string, password: string, totp?: string): Promise<Result<PrivacyUser>> {
    url = await known(url);
    if (!vault.unlocked) return { ok: false, code: "locked", message: "Unlock the PrivacyDW vault first" };
    return signedIn(url, strip(await raw<TokenPair>(url, "POST", "/auth/local/login", { login: String(loginName), password: String(password), totp: totp || undefined })));
}

export async function register(_: unknown, url: string, username: string, password: string, email?: string): Promise<Result<PrivacyUser>> {
    url = await known(url);
    if (!vault.unlocked) return { ok: false, code: "locked", message: "Unlock the PrivacyDW vault first" };
    return signedIn(url, strip(await raw<TokenPair>(url, "POST", "/auth/local/register", { username: String(username), password: String(password), email: email || undefined })));
}

export async function logout(_: unknown, url: string) {
    url = await known(url);
    await authed(url, "POST", "/auth/logout");
    disconnect(url);
    if (vault.unlocked) await vault.update(d => { delete d.sessions[url]; });
}

export async function status(): Promise<InstanceStatus[]> {
    const out: InstanceStatus[] = [];
    for (const i of await loadInstances()) {
        const s: InstanceStatus = { url: i.url, name: i.info.name, signedIn: false, connected: sockets.get(i.url)?.readyState === WebSocket.OPEN };
        if (session(i.url)) {
            const me = await authed<PrivacyUser>(i.url, "GET", "/users/@me");
            if (me.ok) Object.assign(s, { signedIn: true, user: me.data });
        }
        out.push(s);
    }
    return out;
}

// ---------- Guild / message API (Discord-shaped payloads) ----------

export async function createGuild(_: unknown, url: string, name: string) {
    return authed<any>(await known(url), "POST", "/guilds", { name: String(name) });
}

export async function joinInvite(_: unknown, url: string, code: string) {
    const c = String(code).trim().split("/").pop() ?? "";
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(c)) return { ok: false, code: "invalid_invite", message: "Invalid invite code" } as Result<any>;
    return authed<any>(await known(url), "POST", `/invites/${c}`);
}

// ---------- Gateway ----------

const sockets = new Map<string, WebSocket>();
const retry = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout>; }>();
const wanted = new Set<string>();

function gatewayUrl(base: string) {
    return base.replace(/^http/, "ws") + "/gateway";
}

function disconnect(url: string) {
    wanted.delete(url);
    clearTimeout(retry.get(url)?.timer);
    retry.delete(url);
    const ws = sockets.get(url);
    sockets.delete(url);
    ws?.close();
}

function scheduleReconnect(url: string) {
    if (!wanted.has(url)) return;
    const r = retry.get(url) ?? { attempt: 0 };
    r.attempt++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(r.attempt, 5)) * (0.75 + Math.random() / 2);
    r.timer = setTimeout(() => connect(url), delay);
    retry.set(url, r);
}

function connect(url: string) {
    wanted.add(url);
    clearTimeout(retry.get(url)?.timer);
    sockets.get(url)?.close();

    const ws = new WebSocket(gatewayUrl(url));
    sockets.set(url, ws);
    let gotReady = false;

    ws.addEventListener("open", async () => {
        // Refresh first if the access token may be stale; the gateway only accepts valid tokens.
        let t = session(url);
        const me = t && await raw(url, "GET", "/users/@me", undefined, t.accessToken);
        if (me && !me.ok && me.status === 401) t = (await refresh(url)) ?? undefined;
        if (!t) {
            wanted.delete(url);
            ws.close();
            push({ instance: url, t: "DISCONNECTED", d: { reason: "signed_out" } });
            return;
        }
        ws.send(JSON.stringify({ op: "identify", token: t.accessToken }));
    });

    ws.addEventListener("message", ev => {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.op === "ready") {
            gotReady = true;
            retry.delete(url);
            push({ instance: url, t: "READY", d: msg.d });
        } else if (msg.op === "dispatch" && typeof msg.t === "string") {
            push({ instance: url, t: msg.t, d: msg.d });
        }
    });

    ws.addEventListener("close", () => {
        if (sockets.get(url) !== ws) return; // replaced by a newer connection
        sockets.delete(url);
        push({ instance: url, t: "DISCONNECTED", d: { reason: gotReady ? "closed" : "failed" } });
        scheduleReconnect(url);
    });
}

// (Re)connect every signed-in instance. Each connection emits a fresh READY (renderer resync).
export async function connectAll() {
    if (!vault.unlocked) return;
    for (const i of await loadInstances()) if (session(i.url)) connect(i.url);
}
