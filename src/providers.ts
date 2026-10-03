/* ------------------------------------------------------------------ */
/* Provider registry (fetching and status text, no rendering)          */
/* ------------------------------------------------------------------ */

import {
    codexStatusOf,
    fetchCodexActiveUntil,
    fetchCodexUsage,
    getCodexBackoff,
} from "./codex/index";
import type { GoCredentials } from "./go-vault/windows";
import {
    fetchOpenCodeGoStatus,
    fetchOpenCodeGoStatusWith,
    fetchOpenCodeUsage,
    fetchOpenCodeUsageWith,
    openCodeStatusOf,
} from "./opencode/index";
import type { UsageWindow } from "./usage";

/** What one provider returned for the current refresh. */
export interface ProviderResult {
    windows: UsageWindow[];
    plan?: string;
    activeUntil?: string;
    /** Hosted Go access expiry; not a billing renewal date. */
    accessEndsAt?: string;
}

/** One tracked usage type: how to fetch it and how to describe its failures. */
export interface Provider {
    /** Stable id used for collapse keys and display. */
    id: string;
    /** Display name shown in the section header. */
    label: string;
    /** Loads the current quota, rejecting on failure. */
    load: (signal: AbortSignal) => Promise<ProviderResult>;
    /** Maps a failure to a short, safe status note. */
    errorText: (error: unknown) => string;
    /**
     * After a rejection, reports whether the failure is a live cooldown and
     * when it clears, so the sidebar can re-derive the countdown per render.
     */
    cooldown?: (error: unknown) => { until: number } | undefined;
    /**
     * Optional extra lookup issued only after `load` resolves. Its result
     * patches the stored section in place, so a slow or failing follow-up can
     * never block the quota meters it follows.
     */
    followUp?: (
        signal: AbortSignal,
    ) => Promise<Pick<ProviderResult, "plan" | "activeUntil" | "accessEndsAt"> | undefined>;
}

/** Codex window labels, matched by key so a missing window still renders. */
const CODEX_WINDOWS = [
    { key: "fiveHour", label: "5h" },
    { key: "week", label: "Weekly" },
] as const;

/**
 * Map an OpenCode failure to a short, fixed sidebar message containing no
 * secrets or raw error data.
 *
 * @param error - Unknown value thrown by an OpenCode fetch.
 * @returns A displayable status string such as "Set OPENCODE_QUOTA_GO_API_KEY" or "Unavailable".
 */
export function safeOpenCodeError(error: unknown): string {
    switch (openCodeStatusOf(error)) {
        case "missing-login":
            return "Set OPENCODE_QUOTA_GO_API_KEY";
        case "auth":
            return "OpenCode Go / Go Plus API key rejected";
        case "no-subscription":
            return "No OpenCode Go / Go Plus subscription";
        default:
            return "Unavailable";
    }
}

/**
 * Map a Codex failure to a short, fixed sidebar message containing no secrets
 * or raw error data.
 *
 * Rate-limited failures get the static fallback here; the live "retry in Xm"
 * countdown is re-derived per render from the section's cooldown deadline.
 *
 * @param error - Unknown value thrown by a Codex fetch.
 * @returns A displayable status string such as "Sign in with Codex CLI" or "Unavailable".
 */
export function safeCodexError(error: unknown): string {
    switch (codexStatusOf(error)) {
        case "missing-login":
            return "Sign in with Codex CLI";
        case "auth":
            return "Codex sign-in expired";
        case "rate-limited":
            return "Rate limited · retry later";
        default:
            return "Unavailable";
    }
}

/** OpenCode Go: rolling, weekly and monthly windows from a source-visible, undocumented API. */
export function createGoProvider(getCredentials: () => GoCredentials | undefined): Provider {
    let successfulSource: GoCredentials | undefined;
    let loaded = false;
    return {
        id: "opencode",
        label: "OpenCode",
        load: async (signal): Promise<ProviderResult> => {
            loaded = false;
            successfulSource = undefined;
            // A vault read error must propagate: never silently switch to env credentials.
            const source = getCredentials();
            const credentials = source && { ...source };
            const windows = credentials
                ? await fetchOpenCodeUsageWith(credentials.apiKey, signal)
                : await fetchOpenCodeUsage(signal);
            successfulSource = credentials;
            loaded = true;
            return { windows };
        },
        errorText: safeOpenCodeError,
        followUp: (signal) => {
            if (!loaded) {
                return Promise.resolve(undefined);
            }
            const credentials = successfulSource;
            loaded = false;
            successfulSource = undefined;
            return credentials
                ? fetchOpenCodeGoStatusWith(credentials.apiKey, credentials.orgId, signal)
                : fetchOpenCodeGoStatus(signal);
        },
    };
}

/**
 * Codex: the 5h and weekly windows from the ChatGPT usage endpoint, plus the
 * optional subscription boundary. That lookup never blocks or fails the usage
 * refresh, so it settles on its own and only patches the stored result.
 */
const codexProvider: Provider = {
    id: "codex",
    label: "Codex",
    load: async (signal): Promise<ProviderResult> => {
        const windows = await fetchCodexUsage(signal);
        return {
            windows: CODEX_WINDOWS.map(({ key, label }) => ({
                label,
                usage: windows[key],
            })),
            plan: windows.planType,
        };
    },
    errorText: safeCodexError,
    cooldown: (error) => {
        const backoff = getCodexBackoff();
        if (codexStatusOf(error) !== "rate-limited" || backoff.remainingMs <= 0) {
            return undefined;
        }
        return { until: backoff.nextAllowedAt };
    },
    /**
     * The optional subscription boundary is fetched after usage succeeds and
     * never blocks or fails the refresh: it settles on its own and patches only
     * the activeUntil field, so a slow or failing lookup cannot stall the meters.
     */
    followUp: async (signal) => {
        const activeUntil = await fetchCodexActiveUntil(signal);
        return activeUntil === undefined ? undefined : { activeUntil };
    },
};

/** Every tracked usage type, in sidebar display order. */
export const PROVIDERS: readonly Provider[] = [createGoProvider(() => undefined), codexProvider];

/**
 * Resolve the status note for a section at render time.
 *
 * The countdown is derived from the deadline here rather than frozen into the
 * status at failure time, so a 30s render clock shrinks it.
 *
 * @param status - Status note captured when the last refresh settled.
 * @param rateLimitedUntil - Epoch ms a cooldown clears, when one is active.
 * @param nowMs - Reference epoch in milliseconds.
 * @returns The note text to display, empty when there is nothing to say.
 */
export function statusNote(
    status: string | undefined,
    rateLimitedUntil: number | undefined,
    nowMs: number,
): string {
    if (rateLimitedUntil === undefined) {
        return status ?? "";
    }
    const remainingMs = rateLimitedUntil - nowMs;
    if (remainingMs <= 0) {
        return "Rate limited · retry later";
    }
    const minutes = Math.min(60, Math.max(1, Math.ceil(remainingMs / 60_000)));
    return `Rate limited · retry in ${minutes}m`;
}
