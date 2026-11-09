/**
 * Bounded read-only Antigravity usage provider for Google's Cloud Code API:
 * POST /v1internal:retrieveUserQuotaSummary (plus the optional
 * /v1internal:loadCodeAssist lookup for plan tier and companion project ID).
 *
 * Credentials are read at runtime from `$ANTIGRAVITY_CLI_HOME/antigravity-oauth-token`
 * when `ANTIGRAVITY_CLI_HOME` is set, otherwise from the Antigravity CLI (`agy`)
 * session in the OS keyring (`service: "gemini"`, `account: "antigravity"`, or
 * Windows target `gemini:antigravity`) with a fallback to
 * `~/.gemini/antigravity-cli/antigravity-oauth-token`. Refresh tokens are
 * never exchanged or written back, and nothing in this module logs or echoes
 * tokens, headers or response bodies.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { rateLimitPlan } from "../codex/index";
import type { Usage, UsageWindow } from "../usage";

const USAGE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const LOAD_CODE_ASSIST_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
/**
 * Antigravity CLI User-Agent required so the backend includes the Gemini Models
 * and Gemini 4 Argon quota groups alongside the third-party model group.
 */
const USER_AGENT = "antigravity/cli/1.4.7";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_AUTH_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const GO_KEYRING_PREFIX = "go-keyring-base64:";
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";
const WINDOWS_KEYRING_TARGET = "gemini:antigravity";
/** Only auto-retry a 429 when the server asks us to wait at most this long. */
const MAX_RETRY_WAIT_S = 120;
/** Default cooldown when a 429 carries no usable Retry-After. */
const DEFAULT_429_COOLDOWN_MS = 60_000;
/** Cap so a pathological Retry-After can't pin the panel out of service. */
const MAX_BACKOFF_PERSIST_MS = 60 * 60_000;

type SlotKey =
    | "gemini:5h"
    | "gemini:weekly"
    | "claude-gpt:5h"
    | "claude-gpt:weekly"
    | "argon:5h"
    | "argon:weekly";

/**
 * Canonical sidebar order: 5h then Weekly within each model pool, matching the
 * window ordering used across OpenCode and Codex. Only reported pools render.
 */
const WINDOW_ORDER: readonly { key: SlotKey; label: string }[] = [
    { key: "gemini:5h", label: "Gemini 5h" },
    { key: "gemini:weekly", label: "Gemini Weekly" },
    { key: "claude-gpt:5h", label: "Claude/GPT 5h" },
    { key: "claude-gpt:weekly", label: "Claude/GPT Weekly" },
    { key: "argon:5h", label: "Argon 5h" },
    { key: "argon:weekly", label: "Argon Weekly" },
];

const EXACT_BUCKET_SLOTS: Readonly<Record<string, SlotKey>> = {
    "gemini-5h": "gemini:5h",
    "gemini-weekly": "gemini:weekly",
    "3p-5h": "claude-gpt:5h",
    "3p-weekly": "claude-gpt:weekly",
    "gemini-argon-5h": "argon:5h",
    "gemini-argon-wtu-5h": "argon:5h",
    "gemini-argon-weekly": "argon:weekly",
    "gemini-argon-wtu-weekly": "argon:weekly",
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Pure parsing (no I/O, no network; exported for tests)              */
/* ------------------------------------------------------------------ */

/**
 * Convert a provider's remainingFraction (0..1) into a percent-LEFT Usage entry
 * rounded to four decimals to avoid binary float artifacts.
 *
 * @param remainingFraction - Remaining quota fraction in the range 0..1.
 * @returns Usage object with percentLeft clamped to 0..100.
 */
export function fromRemainingFraction(remainingFraction: number): Usage {
    const clamped = Math.min(1, Math.max(0, remainingFraction));
    return { percentLeft: Number((clamped * 100).toFixed(4)) };
}

/**
 * Parse a `retrieveUserQuotaSummary` payload into ordered sidebar windows.
 *
 * Only buckets actually reported (and not marked `disabled: true`) are emitted,
 * so Free/Plus (weekly-only), Pro (Gemini + Claude/GPT + separate Argon weekly)
 * and Ultra (shared Gemini + Claude/GPT) each display their exact active pools.
 * Argon is matched before generic Gemini so `"Gemini 4 Argon"` never collides
 * with `"Gemini Models"`.
 *
 * @param payload - Decoded JSON body from retrieveUserQuotaSummary.
 * @returns Windows in canonical sidebar display order; empty when none are usable.
 */
export function parseAntigravityUsage(payload: unknown): UsageWindow[] {
    if (!isRecord(payload)) {
        return [];
    }
    const root = isRecord(payload.response) ? payload.response : payload;
    if (!Array.isArray(root.groups)) {
        return [];
    }

    const found = new Map<SlotKey, Usage>();
    for (const group of root.groups) {
        if (!isRecord(group) || !Array.isArray(group.buckets)) {
            continue;
        }
        const groupName = typeof group.displayName === "string" ? group.displayName : "";
        for (const bucket of group.buckets) {
            if (!isRecord(bucket) || bucket.disabled === true) {
                continue;
            }
            const slot = classifyBucketSlot(bucket, groupName);
            if (!slot || found.has(slot)) {
                continue;
            }
            const fraction = finiteNumber(bucket.remainingFraction);
            if (fraction === undefined) {
                continue;
            }
            const usage = fromRemainingFraction(fraction);
            const resetsAt = isoTimestamp(bucket.resetTime);
            if (resetsAt !== undefined) {
                usage.resetsAt = resetsAt;
            }
            found.set(slot, usage);
        }
    }

    const windows: UsageWindow[] = [];
    for (const { key, label } of WINDOW_ORDER) {
        const usage = found.get(key);
        if (usage !== undefined) {
            windows.push({ label, usage });
        }
    }
    return windows;
}

function classifyBucketSlot(bucket: JsonRecord, groupName: string): SlotKey | undefined {
    const rawId = typeof bucket.bucketId === "string" ? bucket.bucketId.trim().toLowerCase() : "";
    if (rawId && Object.hasOwn(EXACT_BUCKET_SLOTS, rawId)) {
        return EXACT_BUCKET_SLOTS[rawId];
    }

    const cadence = classifyCadence(rawId, bucket.window);
    if (!cadence) {
        return undefined;
    }
    const bucketDisplay = typeof bucket.displayName === "string" ? bucket.displayName : "";
    const family = classifyFamily(rawId, bucketDisplay, groupName);
    if (!family) {
        return undefined;
    }
    return `${family}:${cadence}`;
}

function classifyCadence(bucketId: string, rawWindow: unknown): "5h" | "weekly" | undefined {
    if (typeof rawWindow === "string" && rawWindow.trim()) {
        const normalized = rawWindow
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_");
        if (normalized === "5h" || normalized === "five_hour") {
            return "5h";
        }
        if (normalized === "weekly") {
            return "weekly";
        }
        return undefined;
    }
    if (bucketId.endsWith("-5h")) {
        return "5h";
    }
    if (bucketId.endsWith("-weekly")) {
        return "weekly";
    }
    return undefined;
}

function classifyFamily(
    bucketId: string,
    bucketDisplayName: string,
    groupDisplayName: string,
): "gemini" | "claude-gpt" | "argon" | undefined {
    const combined = `${bucketId} ${bucketDisplayName} ${groupDisplayName}`.toLowerCase();
    // Argon must be checked before generic "gemini" because its group is named "Gemini 4 Argon".
    if (/\bargon\b/.test(combined) || bucketId.startsWith("gemini-argon")) {
        return "argon";
    }
    if (bucketId.startsWith("3p-") || /\bclaude\b/.test(combined) || /\bgpt\b/.test(combined)) {
        return "claude-gpt";
    }
    if (bucketId.startsWith("gemini-") || /\bgemini\b/.test(combined)) {
        return "gemini";
    }
    return undefined;
}

/**
 * Parse a `loadCodeAssist` payload for the account's effective subscription
 * tier and optional Cloud AI Companion project ID.
 *
 * Consumer accounts often report `currentTier.id = "free-tier"` and
 * `currentTier.name = "Antigravity"` even when a paid Google One AI plan is
 * active in `paidTier`, so `paidTier` always takes precedence over `currentTier`.
 *
 * @param payload - Decoded JSON body from loadCodeAssist.
 * @returns Normalized plan tier and/or companion project ID, or undefined when neither is present.
 */
export function parseAntigravityStatus(
    payload: unknown,
): { plan?: string; projectId?: string } | undefined {
    if (!isRecord(payload)) {
        return undefined;
    }
    const root = isRecord(payload.response) ? payload.response : payload;
    const plan =
        extractTierLabel(root.paidTier) ??
        extractTierLabel(root.currentTier) ??
        extractPlanInfoLabel(root.planInfo);
    const projectId = extractProjectId(root.cloudaicompanionProject);
    return plan || projectId
        ? { ...(plan ? { plan } : {}), ...(projectId ? { projectId } : {}) }
        : undefined;
}

function extractTierLabel(tier: unknown): string | undefined {
    if (!isRecord(tier)) {
        return undefined;
    }
    const id = typeof tier.id === "string" ? tier.id.trim() : "";
    const name = typeof tier.name === "string" ? tier.name.trim() : "";
    return normalizeTierString(id) ?? normalizeTierString(name);
}

function extractPlanInfoLabel(planInfo: unknown): string | undefined {
    if (!isRecord(planInfo)) {
        return undefined;
    }
    const planType = typeof planInfo.planType === "string" ? planInfo.planType.trim() : "";
    const planName = typeof planInfo.planName === "string" ? planInfo.planName.trim() : "";
    return normalizeTierString(planType) ?? normalizeTierString(planName);
}

function normalizeTierString(raw: string): string | undefined {
    if (!raw) {
        return undefined;
    }
    const words = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) {
        return undefined;
    }
    // "Antigravity" is the generic product name on currentTier, not a plan tier.
    if (words.length === 1 && words[0] === "antigravity") {
        return undefined;
    }
    if (words.includes("ultra") && words.includes("lite")) {
        return "Ultra Lite";
    }
    if (words.includes("ultra")) {
        return "Ultra";
    }
    if (words.includes("pro")) {
        return "Pro";
    }
    if (words.includes("plus")) {
        return "Plus";
    }
    if (words.includes("free")) {
        return "Free";
    }
    if (words.includes("enterprise")) {
        return "Enterprise";
    }
    if (words.includes("standard")) {
        return "Standard";
    }
    if (words.includes("legacy")) {
        return "Legacy";
    }
    return undefined;
}

/**
 * Validate a Cloud AI Companion project identifier so it is safe to serialize.
 *
 * @param value - Candidate project identifier from credentials, settings or loadCodeAssist.
 * @returns Trimmed project identifier when valid, otherwise undefined.
 */
export function readAntigravityProjectId(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(trimmed)
        ? trimmed
        : undefined;
}

function extractProjectId(value: unknown): string | undefined {
    if (typeof value === "string") {
        return readAntigravityProjectId(value);
    }
    if (isRecord(value)) {
        return readAntigravityProjectId(value.id ?? value.projectId);
    }
    return undefined;
}

/** Finite number or numeric string -> finite number, else undefined. */
function finiteNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string" && value.trim() && /^-?[0-9]+(\.[0-9]+)?$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** A real, parseable timestamp, else undefined. Absent means "reset unavailable". */
function isoTimestamp(value: unknown): string | undefined {
    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/* ------------------------------------------------------------------ */
/* Credential handling (Antigravity CLI keyring and file fallback)     */
/* ------------------------------------------------------------------ */

export interface AntigravityCredentials {
    accessToken: string;
    projectId?: string;
}

/**
 * Resolve the Antigravity CLI directory: `$ANTIGRAVITY_CLI_HOME` when set,
 * otherwise `<homeDir>/.gemini/antigravity-cli`. Pure - never touches disk.
 *
 * @param homeDir - User home directory used when ANTIGRAVITY_CLI_HOME is unset.
 * @param agyHome - Value of $ANTIGRAVITY_CLI_HOME; blank or non-string values fall back to homeDir.
 * @returns Absolute path to the Antigravity CLI configuration directory.
 * @throws AntigravityProviderError (missing-login) when the resolved path contains control characters or is not absolute.
 */
export function antigravityCliDir(homeDir: string, agyHome: string | undefined): string {
    const base =
        typeof agyHome === "string" && agyHome.trim()
            ? agyHome
            : join(homeDir, ".gemini", "antigravity-cli");
    // Rejecting control characters is intentional.
    // oxlint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(base)) {
        throw new AntigravityProviderError(
            "missing-login",
            "Antigravity config invalid (ANTIGRAVITY_CLI_HOME)",
        );
    }
    if (!isAbsolute(base)) {
        throw new AntigravityProviderError(
            "missing-login",
            "Antigravity config invalid (ANTIGRAVITY_CLI_HOME must be absolute)",
        );
    }
    return base;
}

/**
 * Resolve the Antigravity CLI OAuth token file path. Pure - never touches disk.
 *
 * @param homeDir - User home directory used when ANTIGRAVITY_CLI_HOME is unset.
 * @param agyHome - Value of $ANTIGRAVITY_CLI_HOME; blank or non-string values fall back to homeDir.
 * @returns Absolute path to the antigravity-oauth-token file.
 * @throws AntigravityProviderError (missing-login) when the resolved directory is invalid.
 */
export function antigravityAuthPath(homeDir: string, agyHome: string | undefined): string {
    return join(antigravityCliDir(homeDir, agyHome), "antigravity-oauth-token");
}

/**
 * Decode and validate a raw credential blob from `go-keyring` or the CLI's
 * `antigravity-oauth-token` JSON file. Refresh tokens are ignored.
 *
 * @param raw - Raw string from the OS keyring or CLI token file.
 * @returns Validated access token and optional project ID.
 * @throws AntigravityProviderError (missing-login) when empty, malformed or lacking an access token.
 */
export function parseAntigravityCredentials(raw: string): AntigravityCredentials {
    if (!raw || raw.length > MAX_AUTH_BYTES) {
        throw new AntigravityProviderError(
            "missing-login",
            "Antigravity credentials missing or invalid",
        );
    }
    // Strip surrounding whitespace and any NUL padding from Windows credential blobs.
    // oxlint-disable-next-line no-control-regex
    const trimmed = raw.replace(/\x00/g, "").trim();
    if (!trimmed) {
        throw new AntigravityProviderError(
            "missing-login",
            "Antigravity credentials missing or invalid",
        );
    }
    let jsonText = trimmed;
    if (trimmed.startsWith(GO_KEYRING_PREFIX)) {
        const encoded = trimmed.slice(GO_KEYRING_PREFIX.length).trim();
        if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
            throw new AntigravityProviderError(
                "missing-login",
                "Antigravity keyring session invalid base64",
            );
        }
        jsonText = Buffer.from(encoded, "base64").toString("utf8");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new AntigravityProviderError("missing-login", "Antigravity credentials invalid JSON");
    }
    if (!isRecord(parsed)) {
        throw new AntigravityProviderError("missing-login", "Antigravity credentials invalid JSON");
    }
    const tokenObj = isRecord(parsed.token) ? parsed.token : parsed;
    const rawAccess =
        typeof tokenObj.access_token === "string" && tokenObj.access_token.trim()
            ? tokenObj.access_token.trim()
            : typeof tokenObj.accessToken === "string" && tokenObj.accessToken.trim()
              ? tokenObj.accessToken.trim()
              : undefined;
    if (!rawAccess || !/^[\x21-\x7e]+$/.test(rawAccess)) {
        throw new AntigravityProviderError(
            "missing-login",
            "Antigravity credentials missing access_token",
        );
    }
    const projectId =
        readAntigravityProjectId(tokenObj.project_id) ??
        readAntigravityProjectId(tokenObj.projectId) ??
        readAntigravityProjectId(parsed.project_id) ??
        readAntigravityProjectId(parsed.projectId) ??
        (isRecord(parsed.gcp) ? readAntigravityProjectId(parsed.gcp.project) : undefined);

    return projectId ? { accessToken: rawAccess, projectId } : { accessToken: rawAccess };
}

function readBoundedFile(path: string): string {
    const flags =
        constants.O_RDONLY |
        (process.platform === "win32"
            ? 0
            : (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const fd = openSync(path, flags);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
            throw new AntigravityProviderError(
                "missing-login",
                "Antigravity auth file missing or unreadable",
            );
        }
        if (stat.size > MAX_AUTH_BYTES) {
            throw new AntigravityProviderError("missing-login", "Antigravity auth file too large");
        }
        const buffer = Buffer.alloc(MAX_AUTH_BYTES + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (count === 0) {
                break;
            }
            bytes += count;
        }
        if (bytes > MAX_AUTH_BYTES) {
            throw new AntigravityProviderError("missing-login", "Antigravity auth file too large");
        }
        return buffer.toString("utf8", 0, bytes);
    } finally {
        closeSync(fd);
    }
}

/**
 * Read optional GCP project ID from `<cliDir>/settings.json` (`gcp.project`).
 * Any missing or malformed file quietly returns undefined.
 *
 * @param cliDir - Directory containing the Antigravity CLI settings.json file.
 * @returns Validated GCP project ID when configured, otherwise undefined.
 */
export function readAntigravitySettingsProject(cliDir: string): string | undefined {
    try {
        const raw = readBoundedFile(join(cliDir, "settings.json"));
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || !isRecord(parsed.gcp)) {
            return undefined;
        }
        return readAntigravityProjectId(parsed.gcp.project);
    } catch {
        return undefined;
    }
}

/**
 * Read and validate an `antigravity-oauth-token` file at an explicit path.
 *
 * @param path - Filesystem path of the antigravity-oauth-token file to read.
 * @param settingsDir - Optional CLI directory from which to read a fallback gcp.project in settings.json.
 * @returns Validated access token and optional project ID.
 * @throws AntigravityProviderError (missing-login) when the file is absent, unreadable, oversized, invalid JSON or missing an access token.
 */
export function readAntigravityAuthFile(
    path: string,
    settingsDir?: string,
): AntigravityCredentials {
    let raw: string;
    try {
        raw = readBoundedFile(path);
    } catch (error) {
        if (error instanceof AntigravityProviderError) {
            throw error;
        }
        throw new AntigravityProviderError(
            "missing-login",
            "Antigravity auth file missing or unreadable",
        );
    }
    const credentials = parseAntigravityCredentials(raw);
    if (!credentials.projectId && settingsDir) {
        const projectId = readAntigravitySettingsProject(settingsDir);
        if (projectId) {
            return { ...credentials, projectId };
        }
    }
    return credentials;
}

export interface KeyringReader {
    getPassword(service: string, account: string): Promise<string | null>;
    findPassword?(service: string): Promise<string | null>;
}

async function defaultKeyringLoader(): Promise<KeyringReader | undefined> {
    try {
        return await import("@github/keytar");
    } catch {
        return undefined;
    }
}

/**
 * Read Antigravity CLI credentials from the OS keyring (`service: "gemini"`,
 * `account: "antigravity"`, plus Windows target `gemini:antigravity`), falling
 * back to `~/.gemini/antigravity-cli/antigravity-oauth-token`.
 *
 * When `ANTIGRAVITY_CLI_HOME` is explicitly set, reads from that directory's
 * token file directly.
 *
 * @param homeDir - User home directory used when ANTIGRAVITY_CLI_HOME is unset.
 * @param agyHome - Value of $ANTIGRAVITY_CLI_HOME; when set, selects its token file directly.
 * @param loadKeyring - Injectable OS keyring loader; tests pass a fake to avoid touching the system vault.
 * @returns Validated access token and optional companion project ID.
 * @throws AntigravityProviderError (missing-login) when credentials are missing or invalid.
 */
export async function readAntigravityAuth(
    homeDir: string = homedir(),
    agyHome: string | undefined = process.env.ANTIGRAVITY_CLI_HOME,
    loadKeyring: () => Promise<KeyringReader | undefined> = defaultKeyringLoader,
): Promise<AntigravityCredentials> {
    const cliDir = antigravityCliDir(homeDir, agyHome);
    const tokenPath = join(cliDir, "antigravity-oauth-token");

    if (typeof agyHome === "string" && agyHome.trim()) {
        return readAntigravityAuthFile(tokenPath, cliDir);
    }

    let blob: string | null = null;
    try {
        const keyring = await loadKeyring();
        if (keyring) {
            blob = await keyring.getPassword(KEYRING_SERVICE, KEYRING_ACCOUNT);
            if (
                !blob?.trim() &&
                process.platform === "win32" &&
                typeof keyring.findPassword === "function"
            ) {
                blob = await keyring.findPassword(WINDOWS_KEYRING_TARGET);
            }
        }
    } catch {
        // Keyring unavailable, locked or unreadable: fall through to CLI token file.
        blob = null;
    }

    if (typeof blob === "string" && blob.trim()) {
        const credentials = parseAntigravityCredentials(blob);
        if (!credentials.projectId) {
            const projectId = readAntigravitySettingsProject(cliDir);
            if (projectId) {
                return { ...credentials, projectId };
            }
        }
        return credentials;
    }

    return readAntigravityAuthFile(tokenPath, cliDir);
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the Cloud Code API request headers from a validated access token.
 * Rejects empty, padded, whitespace-bearing or non-visible-ASCII tokens.
 *
 * @param accessToken - Raw OAuth access token.
 * @returns Header record for Cloud Code API requests.
 * @throws AntigravityProviderError (missing-login) when the token is empty, padded or contains bytes outside visible ASCII.
 */
export function buildAntigravityHeaders(accessToken: string): Record<string, string> {
    if (!accessToken.trim()) {
        throw new AntigravityProviderError("missing-login", "Antigravity access token missing");
    }
    if (accessToken !== accessToken.trim() || !/^[\x21-\x7e]+$/.test(accessToken)) {
        throw new AntigravityProviderError("missing-login", "Antigravity access token invalid");
    }
    return {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        accept: "application/json",
        "User-Agent": USER_AGENT,
    };
}

/* ------------------------------------------------------------------ */
/* HTTP fetch with bounded backoff                                     */
/* ------------------------------------------------------------------ */

export type FetchImpl = (
    url: string,
    init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        redirect: "manual";
        signal: AbortSignal;
    },
) => Promise<{
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    body?: ReadableStream<Uint8Array> | null;
    json(): Promise<unknown>;
}>;

async function boundedJson(response: Awaited<ReturnType<FetchImpl>>): Promise<unknown> {
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
        throw new Error("response too large");
    }
    if (response.body === undefined) {
        return response.json();
    }
    if (response.body === null) {
        throw new Error("empty response");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                throw new Error("response too large");
            }
            chunks.push(value);
        }
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, size)));
}

function isJsonContentType(value: string): boolean {
    return /^application\/json(?:\s*;|\s*$)/i.test(value);
}

/** Safe, displayable category for provider failures (never any secrets). */
export type AntigravityStatus =
    "missing-login" | "auth" | "no-subscription" | "rate-limited" | "unavailable";

/**
 * Error carrying a safe display category. Messages are fixed strings plus
 * HTTP status codes: no token, header or body data is ever included.
 */
export class AntigravityProviderError extends Error {
    readonly status: AntigravityStatus;

    constructor(status: AntigravityStatus, message: string) {
        super(message);
        this.name = "AntigravityProviderError";
        this.status = status;
    }
}

/** Rate-limited: a 429 was received, or a persisted backoff is active. */
export class AntigravityRateLimitedError extends AntigravityProviderError {
    readonly retryAfterMs: number | undefined;

    constructor(retryAfterMs?: number) {
        super("rate-limited", "Antigravity usage endpoint rate limited (HTTP 429), retry later");
        this.name = "AntigravityRateLimitedError";
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * Classify any thrown value into a safe display category; never throws and
 * never inspects payloads.
 *
 * @param error - Any thrown value.
 * @returns The error's own category for AntigravityProviderError, otherwise "unavailable".
 */
export function antigravityStatusOf(error: unknown): AntigravityStatus {
    return error instanceof AntigravityProviderError ? error.status : "unavailable";
}

function abortError(): Error {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        throw abortError();
    }
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/* ------------------------------------------------------------------ */
/* Persisted 429 backoff and session-paired project cache              */
/* ------------------------------------------------------------------ */

let nextAllowedAt = 0;
let cachedProject: { accessToken: string; projectId: string } | undefined;
let lastLoadedAccessToken: string | undefined;

/**
 * Current persisted 429 backoff (epoch-ms gate + ms remaining).
 *
 * @returns The epoch-ms time the next request is allowed plus the milliseconds still to wait (0 when clear).
 */
export function getAntigravityBackoff(): {
    nextAllowedAt: number;
    remainingMs: number;
} {
    const now = Date.now();
    return {
        nextAllowedAt,
        remainingMs: nextAllowedAt > now ? nextAllowedAt - now : 0,
    };
}

/** Clear the persisted backoff and cached project state. Exported for test isolation. */
export function resetAntigravityBackoff(): void {
    nextAllowedAt = 0;
    cachedProject = undefined;
    lastLoadedAccessToken = undefined;
}

function recordRateLimited(delayMs: number | undefined, nowMs: number): void {
    nextAllowedAt =
        nowMs +
        (delayMs !== undefined && delayMs > 0
            ? Math.min(delayMs, MAX_BACKOFF_PERSIST_MS)
            : DEFAULT_429_COOLDOWN_MS);
}

function hasSubscriptionRequired(payload: unknown): boolean {
    if (!isRecord(payload) || !isRecord(payload.error)) {
        return false;
    }
    const details = payload.error.details;
    if (!Array.isArray(details)) {
        return false;
    }
    return details.some((detail) => isRecord(detail) && detail.reason === "SUBSCRIPTION_REQUIRED");
}

/**
 * Fetch and parse Antigravity quota windows with explicit credentials.
 *
 * When `projectId` is absent and the endpoint answers 400/403 (some accounts
 * require `{"project": "<cloudaicompanionProject>"}`), a single `loadCodeAssist`
 * discovery call is attempted to resolve the companion project ID and retry.
 *
 * @param accessToken - OAuth access token for the request.
 * @param signal - Abort signal ending the call and any in-flight wait.
 * @param fetchImpl - Injectable fetch; tests pass a fake to avoid the network.
 * @param wait - Injectable sleeper; tests pass a no-op to skip real backoff delays.
 * @param projectId - Optional Cloud AI Companion project ID.
 * @returns Parsed usage windows plus optional discovered plan tier and project ID.
 * @throws AbortError when the signal aborts; AntigravityRateLimitedError while rate limited; AntigravityProviderError on auth, entitlement, HTTP or payload failures.
 */
export async function fetchAntigravityUsageWith(
    accessToken: string,
    signal: AbortSignal,
    fetchImpl: FetchImpl = fetch,
    wait: (ms: number, signal: AbortSignal) => Promise<void> = sleep,
    projectId?: string,
): Promise<{ windows: UsageWindow[]; plan?: string; projectId?: string }> {
    if (signal.aborted) {
        throw abortError();
    }
    const headers = buildAntigravityHeaders(accessToken);
    const validProject = readAntigravityProjectId(projectId);
    const now = Date.now();
    if (now < nextAllowedAt) {
        throw new AntigravityRateLimitedError(nextAllowedAt - now);
    }

    const request = (project: string | undefined) =>
        fetchImpl(USAGE_URL, {
            method: "POST",
            headers,
            body: JSON.stringify(project ? { project } : {}),
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });

    const sendWithRateLimit = async (
        project: string | undefined,
    ): Promise<Awaited<ReturnType<FetchImpl>>> => {
        let current: Awaited<ReturnType<FetchImpl>>;
        try {
            current = await request(project);
        } catch {
            if (signal.aborted) {
                throw abortError();
            }
            throw new AntigravityProviderError(
                "unavailable",
                "Antigravity usage endpoint unavailable",
            );
        }
        if (current.status === 429) {
            const plan = rateLimitPlan(current.headers.get("retry-after"), MAX_RETRY_WAIT_S);
            recordRateLimited(plan.retryAfterMs, Date.now());
            if (plan.retry && plan.retryAfterMs !== undefined) {
                await wait(plan.retryAfterMs, signal);
                try {
                    current = await request(project);
                } catch {
                    if (signal.aborted) {
                        throw abortError();
                    }
                    throw new AntigravityProviderError(
                        "unavailable",
                        "Antigravity usage endpoint unavailable",
                    );
                }
                if (current.status === 429) {
                    const retryPlan = rateLimitPlan(
                        current.headers.get("retry-after"),
                        MAX_RETRY_WAIT_S,
                    );
                    recordRateLimited(retryPlan.retryAfterMs, Date.now());
                    throw new AntigravityRateLimitedError(retryPlan.retryAfterMs);
                }
            } else {
                throw new AntigravityRateLimitedError(plan.retryAfterMs);
            }
        }
        return current;
    };

    let response = await sendWithRateLimit(validProject);

    let discoveredPlan: string | undefined;
    let discoveredProject: string | undefined = validProject;

    // Some accounts reject an empty body on retrieveUserQuotaSummary with 400/403
    // until loadCodeAssist supplies their cloudaicompanionProject.
    if (!validProject && (response.status === 400 || response.status === 403)) {
        const assist = await fetchAntigravityStatusWith(accessToken, signal, fetchImpl);
        if (assist?.plan) {
            discoveredPlan = assist.plan;
        }
        if (assist?.projectId) {
            discoveredProject = assist.projectId;
            response = await sendWithRateLimit(assist.projectId);
        }
    }

    const status =
        Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status
            : 0;
    if (status === 401) {
        throw new AntigravityProviderError(
            "auth",
            "Antigravity usage endpoint requires authentication (HTTP 401)",
        );
    }
    if (status === 403) {
        let subscriptionRequired = false;
        if (isJsonContentType(response.headers.get("content-type") ?? "")) {
            try {
                subscriptionRequired = hasSubscriptionRequired(await boundedJson(response));
            } catch {
                subscriptionRequired = false;
            }
        }
        throw new AntigravityProviderError(
            subscriptionRequired ? "no-subscription" : "auth",
            `Antigravity usage endpoint rejected access (HTTP 403)`,
        );
    }
    if (status >= 300 && status < 400) {
        throw new AntigravityProviderError(
            "auth",
            "Antigravity usage endpoint authentication redirect",
        );
    }
    if (!response.ok) {
        throw new AntigravityProviderError(
            "unavailable",
            `Antigravity usage endpoint HTTP ${status}`,
        );
    }
    if (!isJsonContentType(response.headers.get("content-type") ?? "")) {
        throw new AntigravityProviderError(
            "unavailable",
            "Antigravity usage endpoint did not return JSON",
        );
    }
    let payload: unknown;
    try {
        payload = await boundedJson(response);
    } catch {
        throw new AntigravityProviderError(
            "unavailable",
            "Antigravity usage endpoint returned invalid JSON",
        );
    }
    const windows = parseAntigravityUsage(payload);
    if (!windows.length) {
        throw new AntigravityProviderError(
            "unavailable",
            "Antigravity usage data missing or unsupported",
        );
    }
    nextAllowedAt = 0;
    return {
        windows,
        ...(discoveredPlan ? { plan: discoveredPlan } : {}),
        ...(discoveredProject ? { projectId: discoveredProject } : {}),
    };
}

/**
 * Runtime entry point: reads credentials from the Antigravity CLI keyring or
 * token file at call time, then fetches and parses usage.
 *
 * @param signal - Abort signal for the request.
 * @returns Parsed usage windows plus optional discovered plan tier and project ID.
 * @throws AntigravityProviderError on credential, auth, HTTP or payload failures; AbortError when the signal aborts.
 */
export async function fetchAntigravityUsage(
    signal: AbortSignal,
): Promise<{ windows: UsageWindow[]; plan?: string; projectId?: string }> {
    lastLoadedAccessToken = undefined;
    const { accessToken, projectId } = await readAntigravityAuth();
    const effectiveProject =
        projectId ??
        (cachedProject?.accessToken === accessToken ? cachedProject.projectId : undefined);
    try {
        const result = await fetchAntigravityUsageWith(
            accessToken,
            signal,
            fetch,
            sleep,
            effectiveProject,
        );
        lastLoadedAccessToken = accessToken;
        if (result.projectId) {
            cachedProject = { accessToken, projectId: result.projectId };
        }
        return result;
    } catch (error) {
        if (!projectId && cachedProject?.accessToken === accessToken) {
            cachedProject = undefined;
        }
        throw error;
    }
}

/**
 * Optional subscription tier and companion project lookup via `loadCodeAssist`;
 * failures never block usage.
 *
 * @param accessToken - OAuth access token for the request.
 * @param signal - Abort signal ending the call.
 * @param fetchImpl - Injectable fetch; tests pass a fake to avoid the network.
 * @returns Normalized plan tier and/or companion project ID, or undefined when unavailable or malformed.
 * @throws AbortError when the signal aborts; every other failure resolves to undefined.
 */
export async function fetchAntigravityStatusWith(
    accessToken: string,
    signal: AbortSignal,
    fetchImpl: FetchImpl = fetch,
): Promise<{ plan?: string; projectId?: string } | undefined> {
    if (signal.aborted) {
        throw abortError();
    }
    try {
        const headers = buildAntigravityHeaders(accessToken);
        const response = await fetchImpl(LOAD_CODE_ASSIST_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({
                metadata: {
                    ideType: "ANTIGRAVITY",
                    platform: "PLATFORM_UNSPECIFIED",
                    pluginType: "GEMINI",
                },
            }),
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (!response.ok || response.status !== 200) {
            return undefined;
        }
        if (!isJsonContentType(response.headers.get("content-type") ?? "")) {
            return undefined;
        }
        return parseAntigravityStatus(await boundedJson(response));
    } catch {
        if (signal.aborted) {
            throw abortError();
        }
        return undefined;
    }
}

/**
 * Runtime entry point for optional subscription tier lookup via `loadCodeAssist`.
 * Reuses the access token from the preceding usage load when available so the
 * keyring/file is not read twice in a single refresh cycle.
 *
 * @param signal - Abort signal for the request.
 * @returns Normalized plan tier when available, otherwise undefined.
 * @throws AbortError when the signal aborts; credential and endpoint failures resolve to undefined.
 */
export async function fetchAntigravityStatus(
    signal: AbortSignal,
): Promise<{ plan?: string } | undefined> {
    if (signal.aborted) {
        throw abortError();
    }
    const pairedToken = lastLoadedAccessToken;
    lastLoadedAccessToken = undefined;
    try {
        const accessToken = pairedToken ?? (await readAntigravityAuth()).accessToken;
        const status = await fetchAntigravityStatusWith(accessToken, signal);
        if (status?.projectId) {
            cachedProject = { accessToken, projectId: status.projectId };
        }
        return status?.plan ? { plan: status.plan } : undefined;
    } catch {
        if (signal.aborted) {
            throw abortError();
        }
        return undefined;
    }
}
