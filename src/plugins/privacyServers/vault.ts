/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Password-protected local vault (no OS keyring). scrypt(password) → AES-256-GCM.
// (Argon2 would be preferable, but Electron's BoringSSL doesn't support it.)
// Ported from apps/launcher/src/main/vault-core.ts (unit-tested there).

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "crypto";
import { readFile, rename, rm, writeFile } from "fs/promises";

interface KdfParams {
    alg: "scrypt";
    salt: string;
    N: number;
    r: number;
    p: number;
}

interface VaultFile {
    v: 1;
    kdf: KdfParams;
    nonce: string;
    ct: string;
}

// ~128 MiB, a few hundred ms: the usual interactive-login recommendation.
const KDF_COST = { N: 2 ** 17, r: 8, p: 1 };
export const MIN_PASSWORD = 8;

export class WrongPasswordError extends Error {
    constructor() {
        super("Wrong password");
    }
}

function deriveKey(password: string, kdf: KdfParams): Promise<Buffer> {
    return new Promise((resolve, reject) =>
        scrypt(Buffer.from(password, "utf8"), Buffer.from(kdf.salt, "base64"), 32,
            { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 },
            (err, key) => err ? reject(err) : resolve(key))
    );
}

const aad = (kdf: KdfParams) => Buffer.from(JSON.stringify({ v: 1, kdf }));

export class Vault<T extends object> {
    private key: Buffer | null = null;
    private kdf: KdfParams | null = null;
    private data: T | null = null;
    private readonly path: string;
    private readonly empty: () => T;

    constructor(path: string, empty: () => T) {
        this.path = path;
        this.empty = empty;
    }

    async exists() {
        try {
            await readFile(this.path);
            return true;
        } catch {
            return false;
        }
    }

    get unlocked() {
        return this.key !== null;
    }

    async create(password: string) {
        if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
        const kdf: KdfParams = { alg: "scrypt", salt: randomBytes(16).toString("base64"), ...KDF_COST };
        this.lock();
        this.kdf = kdf;
        this.key = await deriveKey(password, kdf);
        this.data = this.empty();
        await this.persist();
    }

    async unlock(password: string) {
        const file: VaultFile = JSON.parse(await readFile(this.path, "utf8"));
        if (file.v !== 1 || file.kdf?.alg !== "scrypt") throw new Error("Unsupported vault format");
        const key = await deriveKey(password, file.kdf);
        const blob = Buffer.from(file.ct, "base64");
        let data: T;
        try {
            const d = createDecipheriv("aes-256-gcm", key, Buffer.from(file.nonce, "base64"));
            d.setAAD(aad(file.kdf));
            d.setAuthTag(blob.subarray(blob.length - 16));
            const plain = Buffer.concat([d.update(blob.subarray(0, blob.length - 16)), d.final()]);
            data = { ...this.empty(), ...JSON.parse(plain.toString("utf8")) };
        } catch {
            key.fill(0);
            throw new WrongPasswordError();
        }
        this.lock();
        this.key = key;
        this.kdf = file.kdf;
        this.data = data;
    }

    lock() {
        this.key?.fill(0);
        this.key = null;
        this.kdf = null;
        this.data = null;
    }

    async destroy() {
        this.lock();
        await rm(this.path, { force: true });
    }

    read(): T {
        if (!this.data) throw new Error("Vault is locked");
        return this.data;
    }

    async update(fn: (data: T) => void) {
        if (!this.data) throw new Error("Vault is locked");
        fn(this.data);
        await this.persist();
    }

    private async persist() {
        if (!this.key || !this.kdf || !this.data) throw new Error("Vault is locked");
        const nonce = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", this.key, nonce);
        c.setAAD(aad(this.kdf));
        const ct = Buffer.concat([c.update(JSON.stringify(this.data), "utf8"), c.final(), c.getAuthTag()]);
        const file: VaultFile = { v: 1, kdf: this.kdf, nonce: nonce.toString("base64"), ct: ct.toString("base64") };
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
        await rename(tmp, this.path);
    }
}
