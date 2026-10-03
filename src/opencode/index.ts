/**
 * Bounded read-only OpenCode Go usage provider for the account-wide
 * usage endpoint: GET https://opencode.ai/zen/go/v1/usage with an opt-in
 * session process environment key as Bearer auth.
 *
 * This endpoint is visible in OpenCode's source but is not a documented public
 * API. The key is never logged or echoed: parse helpers are pure and error
 * messages are fixed strings plus HTTP status codes.
 */

import { fromPercentUsed } from "../usage";
import type { UsageWindow } from "../usage";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
// Undocumented hosted console endpoint: optional enrichment, never quota auth.
const GO_STATUS_URL = "https://opencode.ai/console/api/go/status";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_KEY_LENGTH = 512;
const MAX_ORG_ID_LENGTH = 256;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Windows in sidebar display order; keyed by their payload name, never position. */
const WINDOW_ORDER: { key: string; label: string }[] = [
    { key: "rolling", label: "5h" },
    { key: "weekly", label: "Weekly" },
    { key: "monthly", label: "Monthly" },
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Pure parsing (no I/O, no network; exported for tests)              */
/* ------------------------------------------------------------------ */

/**
 * Parse the observed usage payload into sidebar windows.
 *
 * The endpoint reports `percent` as percent USED, so each window is inverted
 * to percent LEFT. Windows are matched only by their observed key; unknown
 * keys are ignored and malformed windows are dropped rather than failing the
 * whole payload.
 *
 * @param payload - Decoded JSON body from the usage endpoint.
 * @returns Windows in display order; empty when the payload carries none.
 */
export function parseOpenCodeUsage(payload: unknown): UsageWindow[] {
    if (!isRecord(payload)) {
        return [];
    }
    const usage = payload.usage;
    if (!isRecord(usage)) {
        return [];
    }
    const windows: UsageWindow[] = [];
    for (const { key, label } of WINDOW_ORDER) {
        const window = usage[key];
        if (!isRecord(window)) {
            continue;
        }
        const percentUsed = finiteNumber(window.percent);
        if (percentUsed === undefined) {
            continue;
        }
        const entry = fromPercentUsed(percentUsed);
        const resetsAt = isoTimestamp(window.resetsAt);
        if (resetsAt !== undefined) {
            entry.resetsAt = resetsAt;
        }
        windows.push({ label, usage: entry });
    }
    return windows;
}

/** Finite number or numeric string > finite number, else undefined. */
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
/* Credential handling (opt-in session environment only)               */
/* ------------------------------------------------------------------ */

/**
 * Validate an opt-in Go API key without accessing any other credentials.
 * Reject whitespace, control characters, non-ASCII and oversized values rather
 * than silently changing the supplied credential or building an unsafe header.
 *
 * @param value - Value of OPENCODE_QUOTA_GO_API_KEY.
 * @returns The validated key.
 * @throws OpenCodeProviderError (missing-login) when unset or invalid.
 */
export function readOpenCodeGoKey(value: string | undefined): string {
    if (!value || value.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(value)) {
        throw new OpenCodeProviderError(
            "missing-login",
            "OpenCode Go environment key missing or invalid",
        );
    }
    return value;
}

/**
 * Build the request headers for the usage endpoint.
 *
 * @param apiKey - The Go API key to validate.
 * @returns Header map carrying the key as Bearer auth.
 * @throws OpenCodeProviderError (missing-login) when the key is invalid.
 */
export function buildOpenCodeHeaders(apiKey: string): Record<string, string> {
    return {
        Authorization: `Bearer ${readOpenCodeGoKey(apiKey)}`,
        accept: "application/json",
    };
}

/** Only session-provided, header-safe org identifiers are eligible for status lookup. */
export function readOpenCodeGoOrgId(value: string | undefined): string | undefined {
    return value && value.length <= MAX_ORG_ID_LENGTH && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
        ? value
        : undefined;
}

/** Status is independent of quota: never infer a plan from a missing/unknown token. */
export function parseOpenCodeGoStatus(
    payload: unknown,
): { plan?: string; accessEndsAt?: string } | undefined {
    if (!isRecord(payload)) {
        return undefined;
    }
    const plan =
        payload.product === "go"
            ? "Go"
            : payload.product === "go-plus" || payload.product === "go_plus"
              ? "Go Plus"
              : undefined;
    const accessEndsAt = isRecord(payload.access)
        ? strictAccessTimestamp(payload.access.endsAt)
        : undefined;
    return plan || accessEndsAt
        ? { ...(plan ? { plan } : {}), ...(accessEndsAt ? { accessEndsAt } : {}) }
        : undefined;
}

/** Require an actual timezone-qualified ISO date, not Date.parse's permissive formats. */
function strictAccessTimestamp(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const match =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
            value,
        );
    if (!match) {
        return undefined;
    }
    const [, year, month, day, hour, minute, second, , zone, , zoneHour, zoneMinute] = match;
    const base = new Date(
        Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
        ),
    );
    if (
        Number(year) < 100 ||
        base.getUTCFullYear() !== Number(year) ||
        base.getUTCMonth() + 1 !== Number(month) ||
        base.getUTCDate() !== Number(day) ||
        base.getUTCHours() !== Number(hour) ||
        base.getUTCMinutes() !== Number(minute) ||
        base.getUTCSeconds() !== Number(second) ||
        (zone !== "Z" && (Number(zoneHour) > 23 || Number(zoneMinute) > 59))
    ) {
        return undefined;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/* ------------------------------------------------------------------ */
/* HTTP fetch                                                          */
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
    body: ReadableStream<Uint8Array> | null;
}>;

/** Read bounded JSON from the response stream; never use unbounded response.json(). */
async function boundedJson(response: Awaited<ReturnType<FetchImpl>>): Promise<unknown> {
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
        throw new Error("response too large");
    }
    if (!response.body) {
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

function abortError(): Error {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}

/** Safe, displayable category for provider failures (never any secrets). */
export type OpenCodeStatus = "missing-login" | "auth" | "no-subscription" | "unavailable";

/**
 * Error carrying a safe display category. Messages are fixed strings plus
 * HTTP status codes: no key, header or body data is ever included.
 */
export class OpenCodeProviderError extends Error {
    readonly status: OpenCodeStatus;

    constructor(status: OpenCodeStatus, message: string) {
        super(message);
        this.name = "OpenCodeProviderError";
        this.status = status;
    }
}

/**
 * Classify any thrown value into a safe display category; never throws and
 * never inspects payloads.
 *
 * @param error - Any thrown value.
 * @returns The error's own category for OpenCodeProviderError, otherwise "unavailable".
 */
export function openCodeStatusOf(error: unknown): OpenCodeStatus {
    return error instanceof OpenCodeProviderError ? error.status : "unavailable";
}

/**
 * Fetch and parse Go usage with an explicit key.
 *
 * @param apiKey - Explicit Go API key for the request.
 * @param signal - Abort signal ending the call.
 * @param fetchImpl - Injectable fetch; tests pass a fake to avoid the network.
 * @returns Parsed usage windows from the endpoint.
 * @throws AbortError when the signal aborts; OpenCodeProviderError on auth, entitlement, HTTP or payload failures.
 */
export async function fetchOpenCodeUsageWith(
    apiKey: string,
    signal: AbortSignal,
    fetchImpl: FetchImpl = fetch,
): Promise<UsageWindow[]> {
    if (signal.aborted) {
        throw abortError();
    }
    const headers = buildOpenCodeHeaders(apiKey);
    let response: Awaited<ReturnType<FetchImpl>>;
    try {
        response = await fetchImpl(USAGE_URL, {
            method: "GET",
            headers,
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
    } catch {
        if (signal.aborted) {
            throw abortError();
        }
        throw new OpenCodeProviderError("unavailable", "OpenCode usage endpoint unavailable");
    }
    const status =
        Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status
            : 0;
    if (status === 401 || status === 403) {
        // The endpoint answers 403 EntitlementError when the key is valid but
        // the account has no Go subscription, so the two cases stay distinct.
        throw new OpenCodeProviderError(
            status === 403 ? "no-subscription" : "auth",
            `OpenCode usage endpoint rejected the key (HTTP ${status})`,
        );
    }
    if (status >= 300 && status < 400) {
        throw new OpenCodeProviderError("auth", "OpenCode usage endpoint authentication redirect");
    }
    if (!response.ok) {
        throw new OpenCodeProviderError("unavailable", `OpenCode usage endpoint HTTP ${status}`);
    }
    if (!isJsonContentType(response.headers.get("content-type") ?? "")) {
        throw new OpenCodeProviderError(
            "unavailable",
            "OpenCode usage endpoint did not return JSON",
        );
    }
    let payload: unknown;
    try {
        payload = await boundedJson(response);
    } catch {
        throw new OpenCodeProviderError(
            "unavailable",
            "OpenCode usage endpoint returned invalid JSON",
        );
    }
    const windows = parseOpenCodeUsage(payload);
    if (windows.length === 0) {
        throw new OpenCodeProviderError(
            "unavailable",
            "OpenCode usage data missing or unsupported",
        );
    }
    return windows;
}

/**
 * Validate the supplied session environment value before any network request.
 * Injectable for tests; never looks up alternate credentials.
 */
export async function fetchOpenCodeUsageFromEnv(
    value: string | undefined,
    signal: AbortSignal,
    fetchImpl: FetchImpl = fetch,
): Promise<UsageWindow[]> {
    return fetchOpenCodeUsageWith(readOpenCodeGoKey(value), signal, fetchImpl);
}

/**
 * Runtime entry point: reads only the opt-in session process environment key.
 *
 * @param signal - Abort signal for the request.
 * @returns Parsed usage windows from the authenticated endpoint.
 * @throws AbortError when the signal aborts; OpenCodeProviderError on credential, auth, HTTP or payload failures.
 */
export async function fetchOpenCodeUsage(signal: AbortSignal): Promise<UsageWindow[]> {
    return fetchOpenCodeUsageFromEnv(process.env.OPENCODE_QUOTA_GO_API_KEY, signal);
}

/** Optional hosted Go access status. Any failure leaves already-loaded quota untouched. */
export async function fetchOpenCodeGoStatusWith(
    apiKey: string | undefined,
    orgId: string | undefined,
    signal: AbortSignal,
    fetchImpl: FetchImpl = fetch,
): Promise<{ plan?: string; accessEndsAt?: string } | undefined> {
    const validOrgId = readOpenCodeGoOrgId(orgId);
    if (!validOrgId || signal.aborted) {
        return undefined;
    }
    let key: string;
    try {
        key = readOpenCodeGoKey(apiKey);
    } catch {
        return undefined;
    }
    try {
        const response = await fetchImpl(GO_STATUS_URL, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${key}`,
                "x-org-id": validOrgId,
                accept: "application/json",
            },
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (
            response.status !== 200 ||
            !response.ok ||
            !isJsonContentType(response.headers.get("content-type") ?? "")
        ) {
            return undefined;
        }
        return parseOpenCodeGoStatus(await boundedJson(response));
    } catch {
        // Never surface transport, response, or body errors (which may contain secrets).
        return undefined;
    }
}

/** Runtime status uses only the two opt-in session environment values. */
export function fetchOpenCodeGoStatus(
    signal: AbortSignal,
): Promise<{ plan?: string; accessEndsAt?: string } | undefined> {
    return fetchOpenCodeGoStatusWith(
        process.env.OPENCODE_QUOTA_GO_API_KEY,
        process.env.OPENCODE_QUOTA_GO_ORG_ID,
        signal,
    );
}
