/**
 * Bounded read-only Codex usage provider for the authenticated
 * ChatGPT/Codex backend: GET /backend-api/wham/usage (plus the optional
 * subscriptions lookup) with Bearer auth and ChatGPT-Account-Id headers.
 *
 * Credentials are read at runtime only from $CODEX_HOME/auth.json (default
 * ~/.codex/auth.json); refresh tokens are never handled, so an expired
 * access token surfaces as a safe HTTP 401. Nothing in this module logs or
 * echoes the token, headers or response body - parse helpers are pure and
 * error messages are fixed strings plus HTTP status codes.
 */

import { openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fromPercentUsed, type Usage, type UsageWindows } from "../usage";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SUBSCRIPTIONS_URL = "https://chatgpt.com/backend-api/subscriptions";
const FIVE_HOUR_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Only auto-retry a 429 when the server asks us to wait at most this long. */
const MAX_RETRY_WAIT_S = 120;
/** Default cooldown when a 429 carries no usable Retry-After. */
const DEFAULT_429_COOLDOWN_MS = 60_000;
/** Cap so a pathological Retry-After can't pin the panel out of service. */
const MAX_BACKOFF_PERSIST_MS = 60 * 60_000;
/** new Date(ms) stays valid only up to 8.64e12 ms (year 275760). */
const MAX_SAFE_UNIX_S = 8_640_000_000;

/** Windows keyed by their limit_window_seconds rather than any position. */
const WINDOW_KEYS: Record<number, "fiveHour" | "week"> = {
    [FIVE_HOUR_SECONDS]: "fiveHour",
    [WEEK_SECONDS]: "week",
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Pure parsing (no I/O, no network; exported for tests)              */
/* ------------------------------------------------------------------ */

/**
 * Parse the documented GET /backend-api/wham/usage payload and compute
 * percent LEFT per supported window. Windows are matched only by
 * `limit_window_seconds` (18000 or 604800), never by position or
 * primary/secondary naming; malformed payloads return `{}` and never throw.
 *
 * @param payload - Decoded JSON body from the usage endpoint.
 * @returns Windows keyed as fiveHour/week plus planType when valid; empty for any malformed payload.
 */
export function parseCodexUsage(payload: unknown): UsageWindows {
    const result: UsageWindows = {};
    if (!isRecord(payload)) {
        return result;
    }
    const rateLimit = payload.rate_limit;
    if (!isRecord(rateLimit)) {
        return result;
    }
    const planType = payload.plan_type;
    if (typeof planType === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(planType)) {
        result.planType = planType.toLowerCase();
    }

    const candidates: unknown[] = [];
    const collect = (value: unknown) => {
        if (isRecord(value)) {
            candidates.push(value);
        }
    };
    collect(rateLimit.primary_window);
    collect(rateLimit.secondary_window);
    const modelLimits = rateLimit.model_limits;
    if (Array.isArray(modelLimits)) {
        for (const entry of modelLimits) {
            if (!isRecord(entry)) {
                continue;
            }
            collect(entry.primary_window);
            collect(entry.secondary_window);
        }
    }

    for (const candidate of candidates) {
        const window = parseWindow(candidate);
        if (window === undefined) {
            continue;
        }
        const key = WINDOW_KEYS[window.windowSeconds];
        if (key === undefined) {
            continue;
        }
        // First valid window wins for each key; duplicates are ignored.
        if (result[key] !== undefined) {
            continue;
        }
        const usage: Usage = { percentLeft: window.percentLeft };
        if (window.resetsAt !== undefined) {
            usage.resetsAt = window.resetsAt;
        }
        result[key] = usage;
    }
    return result;
}

interface ParsedWindow {
    windowSeconds: number;
    percentLeft: number;
    resetsAt?: string;
}

function parseWindow(value: unknown): ParsedWindow | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const windowSeconds = finiteNumber(value.limit_window_seconds);
    if (windowSeconds === undefined || !Number.isInteger(windowSeconds)) {
        return undefined;
    }
    if (windowSeconds !== FIVE_HOUR_SECONDS && windowSeconds !== WEEK_SECONDS) {
        return undefined;
    }
    const usedPercent = finiteNumber(value.used_percent);
    if (usedPercent === undefined) {
        return undefined;
    }
    const percentLeft = fromPercentUsed(usedPercent).percentLeft;
    let resetsAt: string | undefined;
    if (value.reset_at !== undefined) {
        const seconds = unixSeconds(value.reset_at);
        // Present-but-invalid reset_at rejects the window; only an absent
        // reset_at means "reset unavailable".
        if (seconds === undefined) {
            return undefined;
        }
        resetsAt = new Date(seconds * 1000).toISOString();
    }
    return { windowSeconds, percentLeft, resetsAt };
}

/** Finite number or numeric string > finite number, else undefined. */
function finiteNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string" && value.trim() && /^-?[0-9]+(\.[0-9]+)?$/.test(value.trim())) {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/** Non-negative UNIX seconds (number or digit string), else undefined. */
function unixSeconds(value: unknown): number | undefined {
    let seconds: number;
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) {
            return undefined;
        }
        seconds = value;
    } else if (typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/.test(value)) {
        seconds = Number(value);
        if (!Number.isFinite(seconds)) {
            return undefined;
        }
    } else {
        return undefined;
    }
    return seconds > MAX_SAFE_UNIX_S ? undefined : seconds;
}

/* ------------------------------------------------------------------ */
/* Credential handling (runtime file reads only)                      */
/* ------------------------------------------------------------------ */

export interface CodexCredentials {
    accessToken: string;
    accountId: string;
}

/**
 * Resolve the auth.json path: $CODEX_HOME/auth.json when set, otherwise
 * `<homeDir>/.codex/auth.json`. Pure - never touches the filesystem.
 *
 * @param homeDir - User home directory used when CODEX_HOME is unset.
 * @param codexHome - Value of $CODEX_HOME; blank or non-string values fall back to homeDir.
 * @returns Absolute path to the Codex auth.json file.
 * @throws CodexProviderError (missing-login) when the resolved base contains control characters or is not absolute.
 */
export function codexAuthPath(homeDir: string, codexHome: string | undefined): string {
    const base =
        typeof codexHome === "string" && codexHome.trim() ? codexHome : join(homeDir, ".codex");
    // Rejecting control characters is the point, so the range match is intentional.
    // oxlint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(base)) {
        throw new CodexProviderError("missing-login", "Codex config invalid (CODEX_HOME)");
    }
    if (!isAbsolute(base)) {
        throw new CodexProviderError(
            "missing-login",
            "Codex config invalid (CODEX_HOME must be absolute)",
        );
    }
    return join(base, "auth.json");
}

/**
 * Read and validate an auth.json file at an explicit path. Refresh tokens
 * are deliberately ignored.
 *
 * @param path - Filesystem path of the auth.json file to read.
 * @returns Trimmed access token and account id from the file's tokens object.
 * @throws CodexProviderError (missing-login) when the file is absent, unreadable, oversized, invalid JSON or missing usable tokens.
 */
export function readCodexAuthFile(path: string): CodexCredentials {
    let raw: string;
    try {
        const fd = openSync(path, "r");
        try {
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
                throw new CodexProviderError("missing-login", "Codex auth file too large");
            }
            raw = buffer.toString("utf8", 0, bytes);
        } finally {
            closeSync(fd);
        }
    } catch (error) {
        if (error instanceof CodexProviderError) {
            throw error;
        }
        throw new CodexProviderError("missing-login", "Codex auth file missing or unreadable");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new CodexProviderError("missing-login", "Codex auth file invalid JSON");
    }
    if (!isRecord(parsed)) {
        throw new CodexProviderError("missing-login", "Codex auth file invalid JSON");
    }
    const tokens = parsed.tokens;
    if (!isRecord(tokens)) {
        throw new CodexProviderError("missing-login", "Codex auth file missing tokens");
    }
    const rawToken = tokens.access_token;
    const rawAccountId = tokens.account_id;
    if (typeof rawToken !== "string" || !rawToken.trim()) {
        throw new CodexProviderError("missing-login", "Codex auth file missing access_token");
    }
    if (typeof rawAccountId !== "string" || !rawAccountId.trim()) {
        throw new CodexProviderError("missing-login", "Codex auth file missing account_id");
    }
    // Trim surrounding whitespace so accidental padding can never reach a
    // header; the header builder independently rejects padded values.
    return { accessToken: rawToken.trim(), accountId: rawAccountId.trim() };
}

/**
 * Runtime-only credentials: $CODEX_HOME/auth.json or ~/.codex/auth.json.
 *
 * @returns The current access token and account id.
 * @throws CodexProviderError (missing-login) when the auth file is missing or invalid.
 */
export function readCodexAuth(): CodexCredentials {
    return readCodexAuthFile(codexAuthPath(homedir(), process.env.CODEX_HOME));
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the usage request headers from the raw credential strings. Pure and
 * defensive: header values must be non-empty visible-ASCII tokens with no
 * surrounding whitespace (readCodexAuthFile trims auth.json values), so a
 * hostile auth.json cannot inject extra headers or smuggling bytes. Secrets
 * never appear in error messages.
 *
 * @param accessToken - Raw access token from auth.json.
 * @param accountId - Raw account id from auth.json.
 * @returns Header record for the Codex backend requests.
 * @throws CodexProviderError (missing-login) when either value is empty, padded or contains bytes outside visible ASCII.
 */
export function buildCodexHeaders(accessToken: string, accountId: string): Record<string, string> {
    if (!accessToken.trim()) {
        throw new CodexProviderError("missing-login", "Codex access token missing (auth.json)");
    }
    if (!accountId.trim()) {
        throw new CodexProviderError("missing-login", "Codex account id missing (auth.json)");
    }
    // Credentials are trimmed at read time; padded values here are malformed.
    if (accessToken !== accessToken.trim()) {
        throw new CodexProviderError("missing-login", "Codex access token invalid (auth.json)");
    }
    if (accountId !== accountId.trim()) {
        throw new CodexProviderError("missing-login", "Codex account id invalid (auth.json)");
    }
    // Visible ASCII only (JWTs / account ids are all 0x20-0x7E): rejects
    // control characters and non-ASCII bytes that could terminate a header
    // line or smuggle unexpected bytes.
    if (!/^[\x20-\x7e]+$/.test(accessToken)) {
        throw new CodexProviderError("missing-login", "Codex access token invalid (auth.json)");
    }
    if (!/^[\x20-\x7e]+$/.test(accountId)) {
        throw new CodexProviderError("missing-login", "Codex account id invalid (auth.json)");
    }
    return {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
        accept: "application/json",
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

/** Read bounded JSON; real fetch Responses provide a stream, synthetic fakes may only provide json(). */
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

/** Content-type must lead with application/json, optionally followed by parameters; no loose substring match. */
function isJsonContentType(value: string): boolean {
    return /^application\/json(?:\s*;|\s*$)/i.test(value);
}

/** Safe, displayable category for provider failures (never any secrets). */
export type CodexStatus = "missing-login" | "auth" | "rate-limited" | "unavailable";

/**
 * Error carrying a safe display category. Messages are fixed strings plus
 * HTTP status codes: no token, header or body data is ever included.
 */
export class CodexProviderError extends Error {
    readonly status: CodexStatus;

    constructor(status: CodexStatus, message: string) {
        super(message);
        this.name = "CodexProviderError";
        this.status = status;
    }
}

/** Rate-limited: a 429 was received, or a persisted backoff is active. */
export class CodexRateLimitedError extends CodexProviderError {
    readonly retryAfterMs: number | undefined;

    constructor(retryAfterMs?: number) {
        super("rate-limited", "Codex usage endpoint rate limited (HTTP 429), retry later");
        this.name = "CodexRateLimitedError";
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * Classify any thrown value into a safe display category; never throws and
 * never inspects payloads. Use it to tell "not logged in" apart from
 * "rate limited" (or a generic failure) in the UI.
 *
 * @param error - Any thrown value.
 * @returns The error's own category for CodexProviderError, otherwise "unavailable".
 */
export function codexStatusOf(error: unknown): CodexStatus {
    return error instanceof CodexProviderError ? error.status : "unavailable";
}

/**
 * Parse a Retry-After header per RFC 9110: integer delay-seconds or a
 * strict IMF-fixdate HTTP-date, otherwise undefined. No lenient parsing.
 *
 * @param value - Raw Retry-After header value, possibly null or absent.
 * @param nowMs - Reference epoch in milliseconds used to resolve HTTP-date values.
 * @returns Delay in seconds (negative when the date has already passed), or undefined for absent or malformed values.
 */
export function retryAfterDelay(
    value: string | null | undefined,
    nowMs: number = Date.now(),
): number | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (/^[0-9]+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isSafeInteger(seconds) ? seconds : undefined;
    }
    // Strict IMF-fixdate shape only - something like "12.5" or an ISO date
    // must not be reinterpreted by a lenient Date.parse.
    if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
        return undefined;
    }
    const time = Date.parse(trimmed);
    if (!Number.isFinite(time)) {
        return undefined;
    }
    return (time - nowMs) / 1000;
}

export interface RateLimitPlan {
    retry: boolean;
    retryAfterMs: number | undefined;
}

/**
 * Decide how to react to a 429: auto-retry once only when the server's
 * Retry-After is a positive delay at most maxRetryS seconds; otherwise give
 * up with the (bounded) delay for the caller to decide.
 *
 * @param retryAfter - Raw Retry-After header value.
 * @param maxRetryS - Longest delay worth an in-call retry.
 * @param nowMs - Reference epoch in milliseconds used to resolve HTTP-date values.
 * @returns Whether to retry once, plus the bounded delay for the caller.
 */
export function rateLimitPlan(
    retryAfter: string | null,
    maxRetryS: number = MAX_RETRY_WAIT_S,
    nowMs: number = Date.now(),
): RateLimitPlan {
    const delayS = retryAfterDelay(retryAfter, nowMs);
    if (delayS === undefined || delayS <= 0 || delayS > maxRetryS) {
        return {
            retry: false,
            retryAfterMs:
                delayS !== undefined && delayS > 0 ? Math.round(delayS * 1000) : undefined,
        };
    }
    return { retry: true, retryAfterMs: Math.round(delayS * 1000) };
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
/* Persisted 429 backoff (module-level)                               */
/* ------------------------------------------------------------------ */

// The sidebar polls on a fixed schedule (2 min), so a Retry-After seen by
// one call must suppress requests from later calls until it elapses -
// otherwise every poll would hit the endpoint while it is still cooling
// down and never let it recover.
let nextAllowedAt = 0;

/**
 * Current persisted 429 backoff (epoch-ms gate + ms remaining).
 *
 * @returns The epoch-ms time the next request is allowed plus the milliseconds still to wait (0 when clear).
 */
export function getCodexBackoff(): {
    nextAllowedAt: number;
    remainingMs: number;
} {
    const now = Date.now();
    return {
        nextAllowedAt,
        remainingMs: nextAllowedAt > now ? nextAllowedAt - now : 0,
    };
}

/** Clear the persisted backoff. Exported for test isolation. */
export function resetCodexBackoff(): void {
    nextAllowedAt = 0;
}

/** Moves the persisted 429 gate forward: the delay capped at MAX_BACKOFF_PERSIST_MS, or the default cooldown when unusable. */
function recordRateLimited(delayMs: number | undefined, nowMs: number): void {
    nextAllowedAt =
        nowMs +
        (delayMs !== undefined && delayMs > 0
            ? Math.min(delayMs, MAX_BACKOFF_PERSIST_MS)
            : DEFAULT_429_COOLDOWN_MS);
}

/**
 * Fetch and parse usage with explicit credentials (testable: pass a fake
 * fetchImpl and a no-op wait to exercise the 429 backoff without sleeping).
 *
 * @param accessToken - Access token for the request.
 * @param accountId - Account id for the request.
 * @param signal - Abort signal ending the call and any in-flight wait.
 * @param fetchImpl - Injectable fetch; tests pass a fake to avoid the network.
 * @param wait - Injectable sleeper; tests pass a no-op to skip real backoff delays.
 * @returns Parsed usage windows from the endpoint.
 * @throws AbortError when the signal aborts; CodexRateLimitedError while rate limited; CodexProviderError on auth, HTTP or payload failures.
 */
export async function fetchCodexUsageWith(
    accessToken: string,
    accountId: string,
    signal: AbortSignal,
    fetchImpl: FetchImpl = fetch,
    wait: (ms: number, signal: AbortSignal) => Promise<void> = sleep,
): Promise<UsageWindows> {
    const headers = buildCodexHeaders(accessToken, accountId);
    const now = Date.now();
    if (now < nextAllowedAt) {
        throw new CodexRateLimitedError(nextAllowedAt - now);
    }

    const request = () =>
        fetchImpl(USAGE_URL, {
            method: "GET",
            headers,
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });

    let response: Awaited<ReturnType<FetchImpl>>;
    try {
        response = await request();
    } catch {
        if (signal.aborted) {
            throw abortError();
        }
        throw new CodexProviderError("unavailable", "Codex usage endpoint unavailable");
    }
    if (response.status === 429) {
        const plan = rateLimitPlan(response.headers.get("retry-after"));
        recordRateLimited(plan.retryAfterMs, Date.now());
        if (plan.retry && plan.retryAfterMs !== undefined) {
            await wait(plan.retryAfterMs, signal);
            try {
                response = await request();
            } catch {
                if (signal.aborted) {
                    throw abortError();
                }
                throw new CodexProviderError("unavailable", "Codex usage endpoint unavailable");
            }
            // The in-call retry is the only retry: if it is still rate
            // limited, record its Retry-After into the persisted gate and
            // give up (no second retry).
            if (response.status === 429) {
                const retryPlan = rateLimitPlan(response.headers.get("retry-after"));
                recordRateLimited(retryPlan.retryAfterMs, Date.now());
                throw new CodexRateLimitedError(retryPlan.retryAfterMs);
            }
        } else {
            throw new CodexRateLimitedError(plan.retryAfterMs);
        }
    }
    const status =
        Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status
            : 0;
    if (status === 401 || status === 403) {
        throw new CodexProviderError(
            "auth",
            `Codex usage endpoint requires authentication (HTTP ${status}); check auth.json credentials`,
        );
    }
    if (status >= 300 && status < 400) {
        throw new CodexProviderError("auth", "Codex usage endpoint authentication redirect");
    }
    if (!response.ok) {
        throw new CodexProviderError("unavailable", `Codex usage endpoint HTTP ${status}`);
    }

    if (!isJsonContentType(response.headers.get("content-type") ?? "")) {
        throw new CodexProviderError("unavailable", "Codex usage endpoint did not return JSON");
    }
    let payload: unknown;
    try {
        payload = await boundedJson(response);
    } catch {
        throw new CodexProviderError("unavailable", "Codex usage endpoint returned invalid JSON");
    }
    const windows = parseCodexUsage(payload);
    if (windows.fiveHour === undefined && windows.week === undefined) {
        throw new CodexProviderError("unavailable", "Codex usage data missing or unsupported");
    }
    // A successful fetch means the rate limit has cleared.
    nextAllowedAt = 0;
    return windows;
}

/**
 * Runtime entry point: reads credentials from $CODEX_HOME/auth.json (or
 * ~/.codex/auth.json) at call time, then fetches and parses usage.
 *
 * @param signal - Abort signal for the request.
 * @returns Parsed usage windows from the authenticated endpoint.
 * @throws CodexProviderError on credential, auth, HTTP or payload failures; AbortError when the signal aborts.
 */
export async function fetchCodexUsage(signal: AbortSignal): Promise<UsageWindows> {
    const { accessToken, accountId } = readCodexAuth();
    return fetchCodexUsageWith(accessToken, accountId, signal);
}

/** Accept only a real, timezone-qualified ISO date-time from a subscription object. */
function subscriptionActiveUntil(payload: unknown): string | undefined {
    if (!isRecord(payload) || typeof payload.active_until !== "string") {
        return undefined;
    }
    const value = payload.active_until;
    const match =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
            value,
        );
    if (!match) {
        return undefined;
    }
    const [, year, month, day, hour, minute, second, zone] = match;
    const calendar = new Date(0);
    calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    if (
        calendar.getUTCFullYear() !== Number(year) ||
        calendar.getUTCMonth() !== Number(month) - 1 ||
        calendar.getUTCDate() !== Number(day) ||
        Number(hour) > 23 ||
        Number(minute) > 59 ||
        Number(second) > 59
    ) {
        return undefined;
    }
    if (zone !== "Z") {
        const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
        if (offsetHour > 23 || offsetMinute > 59) {
            return undefined;
        }
    }
    return Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * Optional subscription active-period boundary; failures never block usage.
 *
 * @param accessToken - Access token for the request.
 * @param accountId - Account id for the request.
 * @param signal - Abort signal ending the call.
 * @param fetchImpl - Injectable fetch; tests pass a fake to avoid the network.
 * @returns The validated active_until ISO string, or undefined when unavailable or malformed.
 * @throws AbortError when the signal aborts; every other failure resolves to undefined.
 */
export async function fetchCodexActiveUntilWith(
    accessToken: string,
    accountId: string,
    signal: AbortSignal,
    fetchImpl: FetchImpl = fetch,
): Promise<string | undefined> {
    if (signal.aborted) {
        throw abortError();
    }
    try {
        const headers = buildCodexHeaders(accessToken, accountId);
        const response = await fetchImpl(
            `${SUBSCRIPTIONS_URL}?account_id=${encodeURIComponent(accountId)}`,
            {
                method: "GET",
                headers,
                redirect: "manual",
                signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            },
        );
        if (!response.ok || response.status >= 300 || response.status < 200) {
            return undefined;
        }
        if (!isJsonContentType(response.headers.get("content-type") ?? "")) {
            return undefined;
        }
        return subscriptionActiveUntil(await boundedJson(response));
    } catch {
        if (signal.aborted) {
            throw abortError();
        }
        return undefined;
    }
}

/**
 * Runtime entry point; reads the existing Codex auth file at call time.
 *
 * @param signal - Abort signal for the request.
 * @returns The subscription active_until ISO string, or undefined when unavailable.
 * @throws AbortError when the signal aborts; credential and endpoint failures resolve to undefined.
 */
export async function fetchCodexActiveUntil(signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) {
        throw abortError();
    }
    try {
        const { accessToken, accountId } = readCodexAuth();
        return await fetchCodexActiveUntilWith(accessToken, accountId, signal);
    } catch {
        if (signal.aborted) {
            throw abortError();
        }
        return undefined;
    }
}
