export interface Usage {
    percentLeft: number;
    resetsAt?: string;
}
export type UsageWindows = Partial<Record<"fiveHour" | "week", Usage>> & {
    planType?: string;
};

/**
 * One quota window in a provider section, already normalized to percent LEFT
 * so the sidebar renders every provider through a single code path.
 */
export interface UsageWindow {
    /** Short sidebar label, such as "5h" or "Weekly". */
    label: string;
    /** Absent when the provider did not report this window. */
    usage?: Usage;
}

/**
 * A provider's quota snapshot plus the display identity the section header
 * needs. Providers own fetching and parsing; the sidebar owns rendering.
 */
export interface UsageSection {
    /** Stable provider id, used for collapse keys and refresh routing. */
    id: string;
    /** Display name shown in the section header, such as "Codex". */
    label: string;
    /** Plan or tier name shown after the label, omitted when unknown. */
    plan?: string;
    windows: UsageWindow[];
    /** Epoch ms of the successful fetch, used for the stale marker. */
    fetchedAt: number;
}

/**
 * Build a percent-LEFT usage entry from a provider's percent-USED value.
 * The result is rounded to four decimals so a binary float artifact such as
 * 100 - 78.9 never reaches the value the sidebar compares and prints.
 */
export function fromPercentUsed(percentUsed: number): Usage {
    const percentLeft = Math.min(100, Math.max(0, 100 - percentUsed));
    return { percentLeft: Number(percentLeft.toFixed(4)) };
}

/**
 * Turn a countdown into a compact duration for the sidebar.
 *
 * @param seconds - Time remaining until reset; non-finite or non-positive values mean the reset is due now.
 * @returns A duration like "2d 3h", "5h 12m", "7m" or "now" when nothing is left.
 */
export function formatReset(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return "now";
    }
    const minutes = Math.ceil(seconds / 60);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days) {
        return hours ? `${days}d ${hours}h` : `${days}d`;
    }
    if (hours) {
        return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
}
