import { readOpenCodeGoKey, readOpenCodeGoOrgId } from "../opencode";

/** Credentials stored only in Windows Credential Manager, never plugin settings. */
export type GoCredentials = { apiKey: string; orgId?: string };

const SERVICE = "opencode-tui-quota-usage";
const ACCOUNT = "opencode-go";
const WINDOWS_ONLY = "Go credential storage requires Windows";
const VAULT_UNAVAILABLE = "Windows credential storage unavailable";
const INVALID_CREDENTIALS = "Invalid OpenCode Go credentials";
const CORRUPT_ENTRY = "Invalid saved OpenCode Go credentials";

export type GoVaultErrorCode = "unavailable" | "corrupt" | "invalid";

/** Fixed, secret-free error category for UI handling. */
export class GoVaultError extends Error {
    readonly code: GoVaultErrorCode;

    constructor(code: GoVaultErrorCode, message: string) {
        super(message);
        this.name = "GoVaultError";
        this.code = code;
    }
}

function validate(credentials: GoCredentials): GoCredentials {
    const apiKey = readOpenCodeGoKey(credentials.apiKey);
    const orgId = credentials.orgId;
    if (orgId !== undefined && orgId !== "" && readOpenCodeGoOrgId(orgId) !== orgId) {
        throw new GoVaultError("invalid", INVALID_CREDENTIALS);
    }
    return orgId ? { apiKey, orgId } : { apiKey };
}

async function keytar() {
    if (process.platform !== "win32") {
        throw new GoVaultError("unavailable", WINDOWS_ONLY);
    }
    try {
        return await import("@github/keytar");
    } catch {
        throw new GoVaultError("unavailable", VAULT_UNAVAILABLE);
    }
}

/** A missing entry is distinct from an unavailable vault or an invalid entry. */
export async function loadWindowsGoCredentials(): Promise<GoCredentials | undefined> {
    if (process.platform !== "win32") {
        return undefined;
    }
    const vault = await keytar();
    let saved: string | null;
    try {
        saved = await vault.getPassword(SERVICE, ACCOUNT);
    } catch {
        throw new GoVaultError("unavailable", VAULT_UNAVAILABLE);
    }
    if (saved === null) {
        return undefined;
    }
    try {
        const value: unknown = JSON.parse(saved);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new GoVaultError("corrupt", CORRUPT_ENTRY);
        }
        const entry = value as Record<string, unknown>;
        if (
            entry.version !== 1 ||
            typeof entry.apiKey !== "string" ||
            (Object.hasOwn(entry, "orgId") && typeof entry.orgId !== "string") ||
            Object.keys(entry).some((key) => !["version", "apiKey", "orgId"].includes(key))
        ) {
            throw new GoVaultError("corrupt", CORRUPT_ENTRY);
        }
        return validate({ apiKey: entry.apiKey, orgId: entry.orgId as string | undefined });
    } catch {
        throw new GoVaultError("corrupt", CORRUPT_ENTRY);
    }
}

/** Writes one versioned entry only after both values have been validated. */
export async function saveWindowsGoCredentials(credentials: GoCredentials): Promise<void> {
    if (process.platform !== "win32") {
        throw new GoVaultError("unavailable", WINDOWS_ONLY);
    }
    let valid: GoCredentials;
    try {
        valid = validate(credentials);
    } catch {
        throw new GoVaultError("invalid", INVALID_CREDENTIALS);
    }
    const vault = await keytar();
    try {
        await vault.setPassword(SERVICE, ACCOUNT, JSON.stringify({ version: 1, ...valid }));
    } catch {
        throw new GoVaultError("unavailable", VAULT_UNAVAILABLE);
    }
}

/** Removes the saved entry; no environment or config files are touched. */
export async function clearWindowsGoCredentials(): Promise<void> {
    const vault = await keytar();
    try {
        if (!(await vault.deletePassword(SERVICE, ACCOUNT))) {
            throw new GoVaultError("unavailable", VAULT_UNAVAILABLE);
        }
    } catch {
        throw new GoVaultError("unavailable", VAULT_UNAVAILABLE);
    }
}
