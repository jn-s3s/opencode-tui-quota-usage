/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, For, untrack } from "solid-js";
import packageJson from "../package.json";
import { createGoProvider, PROVIDERS, statusNote } from "./providers";
import {
    clearWindowsGoCredentials,
    loadWindowsGoCredentials,
    saveWindowsGoCredentials,
} from "./go-vault/windows";
import type { GoCredentials } from "./go-vault/windows";
import { formatReset } from "./usage";
import type { Usage, UsageSection, UsageWindow } from "./usage";

const POLL_MS = 2 * 60_000;
const STALE_MS = 5 * 60_000;
const PERCENT_LEFT_CRITICAL = 10;
const PERCENT_LEFT_WARNING = 45;

/** Package name and version shown in the main header row. */
export const PROJECT_NAME = packageJson.name;
export const PROJECT_VERSION = packageJson.version;
type ProviderId = "codex" | "opencode";
type ProviderEnablement = Record<ProviderId, boolean>;
const noop = () => {};
function vaultErrorCode(error: unknown): "unavailable" | "corrupt" | "invalid" | undefined {
    if (!error || typeof error !== "object" || !("code" in error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return code === "unavailable" || code === "corrupt" || code === "invalid" ? code : undefined;
}

/** Row glyphs for the main header and each section header toggle. */
export const TOGGLE_OPEN = "▼";
export const TOGGLE_CLOSED = "▶";

/**
 * Live state for one provider. A failed refresh keeps the last good snapshot
 * so a transient error never blanks a section that is still roughly right.
 */
interface ProviderEntry {
    windows: UsageWindow[];
    plan?: string;
    activeUntil?: string;
    accessEndsAt?: string;
    fetchedAt: number;
    metadataFetchedAt?: number;
    status: string;
    rateLimitedUntil?: number;
}

interface State {
    providers: Record<string, ProviderEntry>;
}
export type UsageSeverity = "normal" | "warning" | "critical";

/** Terminal background the sidebar is painting on, which selects the palette. */
export type ThemeMode = "dark" | "light";

/**
 * The two host-theme text colors the sidebar borrows for rows it does not
 * color itself. The TUI supplies these as resolved colors; the preview passes
 * hex equivalents so both paths resolve a row the same way.
 */
export interface RowTheme {
    /** Primary text color for headings and normal-severity meter labels. */
    base: string;
    /** Dimmed color for countdowns, notes, the stale marker and missing windows. */
    muted: string;
}

/**
 * One rendered line. `separator` marks a full-width horizontal rule,
 * `toggle` marks a collapsible header that owns the toggle glyph.
 */
export interface DisplayRow {
    text: string;
    heading?: boolean;
    meter?: number;
    label?: string;
    percentText?: string;
    muted?: boolean;
    reset?: boolean;
    severity?: Exclude<UsageSeverity, "normal">;
    /** Full-width horizontal rule drawn instead of text. */
    separator?: boolean;
    /** Collapse key this row toggles; absent on non-collapsible rows. */
    toggle?: string;
    /** Align this text row to the trailing edge of the sidebar. */
    rightAlign?: boolean;
}

/**
 * Sidebar hex palette keyed by terminal theme mode.
 * Dark values are tuned for black backgrounds; light values stay legible on white.
 * Every fill must clear the 3:1 WCAG non-text contrast minimum against its own track,
 * otherwise the meter length is unreadable even though the colors look distinct.
 */
export const USAGE_COLORS = {
    dark: {
        normal: "#6bd586",
        warning: "#f2cf76",
        critical: "#f17471",
        track: "#484848",
    },
    light: {
        normal: "#1a7f37",
        warning: "#8a6d00",
        critical: "#b3261e",
        track: "#d4d4d4",
    },
} as const;

/**
 * Resolve the sidebar color for one usage severity under the active terminal theme mode.
 *
 * @param severity - Usage severity tier of the row.
 * @param mode - Theme mode reported by the TUI context; light values stay readable on white backgrounds.
 * @param normalColor - Optional theme-derived color for normal rows, such as the theme text base.
 * @returns The hex color to paint the row or meter segment with.
 */
export function usageColor(
    severity: UsageSeverity,
    mode: ThemeMode,
    normalColor: string = USAGE_COLORS[mode].normal,
): string {
    return severity === "normal" ? normalColor : USAGE_COLORS[mode][severity];
}

/**
 * Resolve every color one display row paints with, so the TUI component and the
 * preview cannot drift apart in how they color the same row.
 *
 * Text color follows the same precedence the component applies: an explicit
 * severity wins, then the muted theme color, then the base theme color. The bar
 * fill always comes from the severity palette and never from the theme, because
 * the fill must stay readable against the track.
 *
 * @param row - Row produced by displayRows.
 * @param mode - Theme mode reported by the TUI context.
 * @param theme - Host theme base and muted text colors.
 * @returns Text color, bar fill color and track color for the row.
 */
export function rowColors(
    row: DisplayRow,
    mode: ThemeMode,
    theme: RowTheme,
): { text: string; fill: string; track: string } {
    const fill = usageColor(row.severity ?? "normal", mode);
    const text = row.severity ? fill : row.muted ? theme.muted : theme.base;
    return { text, fill, track: USAGE_COLORS[mode].track };
}

/**
 * Classify how much allowance remains into a severity tier.
 *
 * @param value - Percent left, not percent used; 100 is an untouched quota.
 * @returns "critical" at or below PERCENT_LEFT_CRITICAL, "warning" at or below PERCENT_LEFT_WARNING, otherwise "normal"; non-finite input returns "normal".
 */
export function usageSeverity(value: number): UsageSeverity {
    if (!Number.isFinite(value)) return "normal";
    if (value <= PERCENT_LEFT_CRITICAL) return "critical";
    if (value <= PERCENT_LEFT_WARNING) return "warning";
    return "normal";
}

/**
 * Parse the subscription active-until boundary into an epoch.
 *
 * @param value - ISO timestamp from the subscriptions endpoint, possibly absent or malformed.
 * @returns The epoch in milliseconds, or undefined when there is no usable boundary.
 */
export function parseActiveUntil(value?: string): number | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Decide whether the subscription active-until boundary needs the critical color.
 *
 * @param timestamp - Epoch in milliseconds from parseActiveUntil, which already rejects malformed input.
 * @param nowMs - Reference epoch in milliseconds the expiry window is measured against.
 * @returns True when access has expired or expires within the next 24 hours.
 */
export function activeUntilIsCritical(timestamp: number, nowMs = Date.now()): boolean {
    return timestamp < nowMs + 24 * 60 * 60_000;
}

/**
 * Clamp a usage percent so it can safely drive a box width, never text cells or an unbounded flex size.
 *
 * @param value - Raw percent left as reported by the provider, possibly NaN or Infinity.
 * @returns The percent clamped to 0..100, or undefined when the value is not finite.
 */
export function meterPercent(value: number): number | undefined {
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;
}

/**
 * Normalize an account-provided plan name into a short, safe sidebar label.
 *
 * @param plan - Raw plan name from a provider, possibly absent or hostile.
 * @returns An uppercased label of at most 16 characters, or undefined when nothing usable remains.
 */
export function planLabel(plan?: string): string | undefined {
    if (!plan) return undefined;
    const cleaned = plan
        .trim()
        // Stripping ANSI sequences means matching ESC, so the control char is intentional.
        // oxlint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
        .replace(/[_-]+/g, " ")
        .replace(/[^a-zA-Z0-9 ]/g, "")
        .trim();
    if (!cleaned) return undefined;
    if (cleaned.length <= 16) {
        return cleaned.toUpperCase();
    }
    // Uppercase first, then truncate, so the cut lands on the final characters.
    const upper = cleaned.toUpperCase();
    return `${upper
        .slice(0, 16)
        .replace(/\s+\S*$/, "")
        .trimEnd()}...`;
}

/**
 * Render the subscription active-period boundary with its distance from the reference time.
 *
 * @param timestamp - Epoch in milliseconds from parseActiveUntil, which already rejects malformed input.
 * @param nowMs - Reference epoch in milliseconds used to compute remaining or elapsed time.
 * @returns An "Until <date> ..." line.
 */
export function formatActiveUntil(timestamp: number, nowMs = Date.now()): string {
    const boundary = new Date(timestamp);
    const currentYear = new Date(nowMs).getUTCFullYear();
    const date = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        ...(boundary.getUTCFullYear() !== currentYear ? { year: "numeric" as const } : {}),
        timeZone: "UTC",
    }).format(boundary);
    const differenceMs = timestamp - nowMs;
    if (differenceMs === 0) {
        return `Until ${date} · now`;
    }
    if (differenceMs < 0 && differenceMs > -60_000) {
        return `Until ${date} · <1m ago`;
    }
    const minutes = Math.ceil(Math.abs(differenceMs) / 60_000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remainingMinutes = minutes % 60;
    const duration = [
        days ? `${days}d` : "",
        hours ? `${hours}h` : "",
        remainingMinutes ? `${remainingMinutes}m` : "",
    ]
        .filter(Boolean)
        .join(" ");
    return differenceMs > 0
        ? `Until ${date} · ${duration} left`
        : `Until ${date} · ${duration} ago`;
}

/**
 * Build the meter and reset rows for one provider's windows.
 *
 * Shared by every provider so a window is rendered identically wherever it
 * comes from: a missing window shows as unavailable, and the reset countdown
 * is always its own row so it stays readable at narrow sidebar widths.
 *
 * @param windows - Windows in display order; entries without usage render as unavailable.
 * @param nowMs - Reference epoch in milliseconds for the reset countdowns.
 * @returns Meter and reset rows in render order.
 */
export function windowRows(
    windows: readonly { label: string; usage?: Usage }[],
    nowMs: number,
): DisplayRow[] {
    const rows: DisplayRow[] = [];
    for (const { label, usage } of windows) {
        const percent = usage ? meterPercent(usage.percentLeft) : undefined;
        if (!usage || percent === undefined) {
            rows.push({ text: `${label} unavailable`, muted: true });
            continue;
        }
        const displayedPercent = Number(percent.toFixed(1));
        const percentText = `${displayedPercent}% left`;
        // Threshold on the rounded value so identical displayed text always gets identical color.
        const severity = usageSeverity(displayedPercent);
        rows.push({
            text: `${label} ${percentText}`,
            label,
            percentText,
            // Match the fill to the rounded value presented in the label.
            meter: displayedPercent,
            // Only urgent tiers are recorded, so a normal row keeps the theme text color.
            severity: severity === "normal" ? undefined : severity,
        });
        const seconds =
            usage.resetsAt === undefined
                ? undefined
                : Math.max(0, (Date.parse(usage.resetsAt) - nowMs) / 1000);
        const reset =
            seconds === undefined || !Number.isFinite(seconds)
                ? "Reset unavailable"
                : seconds === 0
                  ? "Resets now"
                  : `${formatReset(seconds)} to reset`;
        rows.push({ text: reset, muted: true, reset: true });
    }
    return rows;
}

/**
 * Build one provider's section: its header plus the body rows shown when expanded.
 *
 * @param entry - Live provider state, possibly holding only a status note.
 * @param provider - Display identity for the section header.
 * @param expanded - Whether the section body is visible.
 * @param nowMs - Reference epoch in milliseconds for countdowns and staleness.
 * @returns Rows for this section, ending with a separator when expanded.
 */
function sectionRows(
    entry: ProviderEntry | undefined,
    provider: { id: string; label: string },
    expanded: boolean,
    nowMs: number,
): DisplayRow[] {
    const section: UsageSection = {
        id: provider.id,
        label: provider.label,
        plan: entry?.plan,
        windows: entry?.windows ?? [],
        fetchedAt: entry?.fetchedAt ?? 0,
    };
    const rows = [sectionHeader(section, expanded)];
    if (!expanded) {
        return rows;
    }
    const status = statusNote(entry?.status, entry?.rateLimitedUntil, nowMs);
    rows.push(...(section.windows.length ? windowRows(section.windows, nowMs) : []));
    if (!section.windows.length) {
        rows.push({ text: status || "No data", muted: true });
    }
    const metadataStale =
        entry?.metadataFetchedAt !== undefined && nowMs - entry.metadataFetchedAt > STALE_MS;
    const boundarySuffix = metadataStale ? " (stale)" : "";
    const activeUntilMs = parseActiveUntil(entry?.activeUntil);
    if (provider.id !== "opencode" && activeUntilMs !== undefined) {
        rows.push({
            text: `${formatActiveUntil(activeUntilMs, nowMs)}${boundarySuffix}`,
            muted: true,
            severity: activeUntilIsCritical(activeUntilMs, nowMs) ? "critical" : undefined,
        });
    }
    const accessEndsAt =
        provider.id === "opencode" ? parseActiveUntil(entry?.accessEndsAt) : undefined;
    if (accessEndsAt !== undefined) {
        rows.push({
            text: `${formatActiveUntil(accessEndsAt, nowMs)}${boundarySuffix}`,
            muted: true,
            severity: activeUntilIsCritical(accessEndsAt, nowMs) ? "critical" : undefined,
        });
    }
    if (status && section.windows.length) {
        rows.push({ text: `Note: ${status}`, muted: true });
    }
    if (entry && nowMs - entry.fetchedAt > STALE_MS) {
        rows.push({ text: "(stale)", muted: true });
    }
    return rows;
}

/** A full-width rule between sections. */
export const SEPARATOR: DisplayRow = { text: "", separator: true };

/**
 * Build the collapsible section header row for one usage type.
 *
 * The header is the only place a section's plan name appears, and it carries
 * the toggle glyph plus the collapse key the command layer listens for.
 *
 * @param section - Provider identity to label the header with.
 * @param expanded - Whether the section body is currently visible.
 * @returns The header row.
 */
export function sectionHeader(section: UsageSection, expanded: boolean): DisplayRow {
    const plan = planLabel(section.plan);
    return {
        text: `${expanded ? TOGGLE_OPEN : TOGGLE_CLOSED} ${section.label}${plan ? ` · ${plan}` : ""}`,
        heading: true,
        toggle: section.id,
    };
}

/**
 * Build the whole sidebar: the main header, a rule, then each usage type as a
 * collapsible section followed by its own rule.
 *
 * The main header owns the "all" collapse key, so collapsing it hides every
 * section body at once while leaving each section's own state untouched.
 *
 * @param current - Latest plugin state, keyed by provider id.
 * @param collapsed - Collapse keys currently toggled shut, including "all" for the main header.
 * @param nowMs - Reference epoch in milliseconds for countdowns and staleness checks.
 * @returns Rows in render order, ready for the sidebar renderer.
 */
export function layoutRows(
    current: State,
    collapsed: ReadonlySet<string>,
    nowMs: number,
    enabled?: Readonly<ProviderEnablement>,
): DisplayRow[] {
    const allOpen = !collapsed.has("all");
    const rows: DisplayRow[] = [
        {
            text: `${allOpen ? TOGGLE_OPEN : TOGGLE_CLOSED} ${PROJECT_NAME} (${PROJECT_VERSION})`,
            heading: true,
            toggle: "all",
        },
        SEPARATOR,
    ];
    const disabled = enabled
        ? PROVIDERS.filter((provider) => enabled[provider.id as ProviderId] !== true)
        : [];
    if (disabled.length > 0) {
        rows.push({
            text:
                disabled.length === PROVIDERS.length
                    ? `Choose a provider: ${PROVIDERS.map((provider) => `/quota-${provider.id}`).join(" or ")}`
                    : `Also disabled: ${disabled.map((provider) => `/quota-${provider.id}`).join(", ")}`,
            muted: true,
        });
    }
    for (const provider of PROVIDERS) {
        if (enabled && enabled[provider.id as ProviderId] !== true) continue;
        rows.push(
            ...sectionRows(
                current.providers[provider.id],
                provider,
                allOpen && !collapsed.has(provider.id),
                nowMs,
            ),
        );
        // Each section closes with its own rule, matching the header rule.
        rows.push(SEPARATOR);
    }
    rows.push({ text: "/quota-help for help", muted: true, rightAlign: true });
    return rows;
}

/**
 * Plain-text form of the sidebar, one line per display row.
 *
 * @param current - State to render.
 * @param collapsed - Collapse keys currently toggled shut.
 * @param nowMs - Reference epoch in milliseconds.
 * @returns The sidebar text lines; separators render as a rule glyph.
 */
export function displayLines(
    current: State,
    collapsed: ReadonlySet<string>,
    nowMs: number,
): string[] {
    return layoutRows(current, collapsed, nowMs).map((row) =>
        row.separator ? "─".repeat(20) : row.text,
    );
}

export default Plugin.define({
    id: "quota-usage",
    async setup(context) {
        const windowsHost = process.platform === "win32";
        let storedCredentials: GoCredentials | undefined;
        type VaultState = "ready" | "unavailable" | "corrupt";
        let vaultState: VaultState = "ready";
        let vaultEntryExists = false;
        let vaultLoaded = false;
        let invalidateOpenCode = noop;
        let credentialMutation: Promise<void> = Promise.resolve();
        const readVault = async () => {
            if (!windowsHost) return;
            const read = credentialMutation.then(async () => {
                const previous = {
                    credentials: storedCredentials,
                    state: vaultState,
                    exists: vaultEntryExists,
                };
                try {
                    const value = await loadWindowsGoCredentials();
                    storedCredentials = value;
                    vaultEntryExists = value !== undefined;
                    vaultState = "ready";
                } catch (error) {
                    if (vaultErrorCode(error) === "unavailable") {
                        // Missing keytar/native support may use the environment key, never a cached vault key.
                        storedCredentials = undefined;
                        vaultEntryExists = false;
                        vaultState = "unavailable";
                    } else {
                        // Corrupt/unknown entries fail closed: do not silently fall back to env.
                        storedCredentials = undefined;
                        vaultEntryExists = true;
                        vaultState = "corrupt";
                    }
                }
                const sameCredentials =
                    previous.credentials?.apiKey === storedCredentials?.apiKey &&
                    previous.credentials?.orgId === storedCredentials?.orgId;
                const changed =
                    vaultLoaded &&
                    (previous.state !== vaultState ||
                        previous.exists !== vaultEntryExists ||
                        !sameCredentials);
                vaultLoaded = true;
                if (changed) invalidateOpenCode();
            });
            credentialMutation = read.then(
                () => undefined,
                () => undefined,
            );
            await read;
        };
        await readVault();
        const [settings, updateSettings] = context.storage.store("settings", {
            initial: {
                visible: true,
                enabled: { codex: false, opencode: false },
                collapsed: [] as string[],
            },
        });
        // Missing/legacy/corrupt provider choices are opt-out by default.
        const isEnabled = (id: ProviderId) => settings.enabled?.[id] === true;
        const [state, setState] = createSignal<State>({ providers: {} });
        const [now, setNow] = createSignal(Date.now());
        // Starts hidden, so the first applyVisibility call is what turns the sidebar on.
        const [shown, setShown] = createSignal(false);
        // Older settings have no collapsed keys; an absent value keeps all rows open.
        const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(
            new Set(Array.isArray(settings.collapsed) ? settings.collapsed : []),
        );
        let collapseMutation: Promise<void> = Promise.resolve();
        let controller: AbortController | undefined;
        let poll: ReturnType<typeof setInterval> | undefined;
        let clock: ReturnType<typeof setInterval> | undefined;
        let disposed = false;
        let running = false;
        let generation = 0;
        let refreshEpoch = 0;
        let goDialogRequest = 0;
        invalidateOpenCode = () => {
            generation++;
            controller?.abort();
            controller = undefined;
            setState((previous) => {
                const providers = { ...previous.providers };
                delete providers.opencode;
                return { providers };
            });
        };
        const getGoCredentials = () => storedCredentials;

        const refreshOne = async (
            provider: (typeof PROVIDERS)[number],
            signal: AbortSignal,
            current: number,
        ): Promise<void> => {
            try {
                const result = await provider.load(signal);
                if (disposed || !shown() || signal.aborted || current !== generation) {
                    return;
                }
                const fetchedAt = Date.now();
                const confirmsMetadata =
                    result.plan !== undefined ||
                    result.activeUntil !== undefined ||
                    result.accessEndsAt !== undefined;
                setState((previous) => {
                    const carried = previous.providers[provider.id];
                    return {
                        providers: {
                            ...previous.providers,
                            [provider.id]: {
                                ...result,
                                plan: result.plan ?? carried?.plan,
                                activeUntil: result.activeUntil ?? carried?.activeUntil,
                                accessEndsAt: result.accessEndsAt ?? carried?.accessEndsAt,
                                metadataFetchedAt: confirmsMetadata
                                    ? fetchedAt
                                    : carried?.metadataFetchedAt,
                                fetchedAt,
                                status: "",
                            },
                        },
                    };
                });
                if (!provider.followUp) {
                    return;
                }
                // The follow-up patches only its own field and is guarded by the
                // same generation, so it can neither delay nor overwrite the meters.
                void provider
                    .followUp(signal)
                    .then((followUp) => {
                        if (
                            followUp === undefined ||
                            disposed ||
                            !shown() ||
                            signal.aborted ||
                            current !== generation
                        ) {
                            return;
                        }
                        setState((previous) => {
                            const entry = previous.providers[provider.id];
                            return entry
                                ? {
                                      providers: {
                                          ...previous.providers,
                                          [provider.id]: {
                                              ...entry,
                                              ...(followUp.plan !== undefined
                                                  ? { plan: followUp.plan }
                                                  : {}),
                                              ...(followUp.activeUntil !== undefined
                                                  ? { activeUntil: followUp.activeUntil }
                                                  : {}),
                                              ...(followUp.accessEndsAt !== undefined
                                                  ? { accessEndsAt: followUp.accessEndsAt }
                                                  : {}),
                                              metadataFetchedAt: Date.now(),
                                          },
                                      },
                                  }
                                : previous;
                        });
                    })
                    .catch(() => undefined);
            } catch (error) {
                if (disposed || !shown() || signal.aborted || current !== generation) {
                    return;
                }
                setState((previous) => ({
                    providers: {
                        ...previous.providers,
                        [provider.id]: {
                            // Keep the last good snapshot so a transient failure
                            // never blanks a section that is still roughly right.
                            ...previous.providers[provider.id],
                            status: provider.errorText(error),
                            // A cooldown counts down from its deadline, which the
                            // render clock re-reads, so it is stored not formatted.
                            rateLimitedUntil: provider.cooldown?.(error)?.until,
                        },
                    },
                }));
            }
        };

        const refresh = async () => {
            if (running || disposed || !shown()) {
                return;
            }
            running = true;
            const intent = ++refreshEpoch;
            try {
                await readVault();
                if (disposed || !shown() || intent !== refreshEpoch) return;
                const refreshGeneration = ++generation;
                const request = new AbortController();
                controller = request;
                if (vaultState === "corrupt") {
                    if (isEnabled("opencode"))
                        setState((previous) => ({
                            providers: {
                                ...previous.providers,
                                opencode: {
                                    windows: [],
                                    fetchedAt: Date.now(),
                                    status: "Saved credentials need repair · /quota-opencode-key",
                                },
                            },
                        }));
                }
                await Promise.all(
                    PROVIDERS.filter(
                        (provider) =>
                            isEnabled(provider.id as ProviderId) &&
                            !(provider.id === "opencode" && vaultState === "corrupt"),
                    ).map((provider) =>
                        refreshOne(
                            provider.id === "opencode"
                                ? createGoProvider(getGoCredentials)
                                : provider,
                            request.signal,
                            refreshGeneration,
                        ),
                    ),
                );
            } finally {
                if (intent === refreshEpoch) {
                    running = false;
                }
            }
        };

        const restartRequests = () => {
            refreshEpoch++;
            generation++;
            controller?.abort();
            controller = undefined;
            running = false;
            void refresh();
        };
        const saveGoCredentials = async (
            value: { apiKey: string; orgId?: string },
            request: number,
            enableProvider = true,
        ) => {
            const write = credentialMutation.then(async () => {
                if (disposed || request !== goDialogRequest) return;
                await saveWindowsGoCredentials(value);
                storedCredentials = value;
                vaultEntryExists = true;
                vaultState = "ready";
                vaultLoaded = true;
                if (!disposed) invalidateOpenCode();
                if (disposed || request !== goDialogRequest) {
                    if (!disposed) restartRequests();
                    return;
                }
                let settingsSaved = true;
                if (enableProvider && !isEnabled("opencode")) {
                    try {
                        await updateSettings((draft) => {
                            draft.enabled ??= { codex: false, opencode: false };
                            draft.enabled.opencode = true;
                        });
                    } catch {
                        settingsSaved = false;
                    }
                }
                if (disposed || request !== goDialogRequest) {
                    if (!disposed) restartRequests();
                    return;
                }
                restartRequests();
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message: settingsSaved
                        ? enableProvider
                            ? "Credentials saved in Windows Credential Manager; OpenCode Go / Go Plus is enabled."
                            : "Credentials saved in Windows Credential Manager."
                        : "Credentials saved in Windows Credential Manager, but provider enablement was not saved. Run /quota-opencode to enable it. Credentials remain stored.",
                    ...(settingsSaved ? {} : { variant: "error" as const }),
                });
            });
            credentialMutation = write.then(
                () => undefined,
                () => undefined,
            );
            try {
                await write;
            } catch (cause) {
                if (disposed || request !== goDialogRequest) return;
                const code = vaultErrorCode(cause);
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message:
                        code === "invalid"
                            ? "The Go API key or org ID was rejected. Check the values and try again."
                            : "Could not save credentials to Windows Credential Manager.",
                    variant: "error",
                });
            }
        };
        const promptGoApiKey = async () => {
            const request = ++goDialogRequest;
            await credentialMutation;
            if (disposed || request !== goDialogRequest) return;
            const apiKey = await context.ui.dialog.prompt({
                title: "OpenCode Go / Go Plus API key",
                description: "Key entry is visible while typing. Avoid screen sharing.",
                placeholder: "Paste API key",
            });
            if (apiKey === undefined || disposed || request !== goDialogRequest) return;
            // Reject terminal control characters even if a native prompt returns them.
            // oxlint-disable-next-line no-control-regex
            if (
                !apiKey ||
                apiKey.length > 512 ||
                /\s/.test(apiKey) ||
                // oxlint-disable-next-line no-control-regex
                /[\u0000-\u001f\u007f]/.test(apiKey)
            ) {
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message: "Enter a non-empty API key without spaces.",
                    variant: "error",
                });
                return;
            }
            const orgId = vaultState === "ready" ? storedCredentials?.orgId : undefined;
            await saveGoCredentials({ apiKey, ...(orgId ? { orgId } : {}) }, request);
        };
        const promptGoOrgId = async (request: number) => {
            if (vaultState !== "ready" || !storedCredentials?.apiKey) {
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message: "Add a saved API key before setting an org ID.",
                });
                return;
            }
            const enteredOrg = await context.ui.dialog.prompt({
                title: "OpenCode Go / Go Plus workspace / org ID",
                description: "Blank clears the optional org ID.",
                placeholder: "Org ID (optional)",
                value: storedCredentials.orgId ?? "",
            });
            if (enteredOrg === undefined || disposed || request !== goDialogRequest) return;
            const orgId = enteredOrg.trim();
            // Reject terminal control characters in optional user-provided identifiers.
            // oxlint-disable-next-line no-control-regex
            if (orgId.length > 256 || /[\u0000-\u001f\u007f]/.test(orgId)) {
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message: "Org ID is too long or contains invalid characters.",
                    variant: "error",
                });
                return;
            }
            await saveGoCredentials(
                { apiKey: storedCredentials.apiKey, ...(orgId ? { orgId } : {}) },
                request,
                false,
            );
        };
        const removeGoCredentials = async () => {
            const request = ++goDialogRequest;
            const write = credentialMutation.then(async () => {
                if (disposed || request !== goDialogRequest) return;
                await clearWindowsGoCredentials();
                storedCredentials = undefined;
                vaultEntryExists = false;
                vaultState = "ready";
                vaultLoaded = true;
                if (!disposed) invalidateOpenCode();
                if (disposed || request !== goDialogRequest) {
                    if (!disposed) restartRequests();
                    return;
                }
                restartRequests();
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message: `Saved key removed. OPENCODE_QUOTA_GO_API_KEY may still be used if set; Go is ${isEnabled("opencode") ? "still enabled" : "disabled"}.`,
                });
            });
            credentialMutation = write.then(
                () => undefined,
                () => undefined,
            );
            try {
                await write;
            } catch (cause) {
                if (disposed || request !== goDialogRequest) return;
                const code = vaultErrorCode(cause);
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message:
                        code === "corrupt"
                            ? "Could not remove damaged saved credentials."
                            : "Could not remove credentials from Windows Credential Manager.",
                    variant: "error",
                });
            }
        };
        const manageGoCredentials = async () => {
            if (!windowsHost) {
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message:
                        "Set OPENCODE_QUOTA_GO_API_KEY in your environment to configure access.",
                });
                return;
            }
            await readVault();
            if (disposed) return;
            if (vaultState === "unavailable") {
                context.ui.toast.show({
                    title: "OpenCode Go / Go Plus",
                    message:
                        "Windows Credential Manager is unavailable. Existing environment credentials can still be used; set OPENCODE_QUOTA_GO_API_KEY to configure access.",
                    variant: "error",
                });
                return;
            }
            const request = ++goDialogRequest;
            const action = await context.ui.dialog.select({
                title: "OpenCode Go / Go Plus",
                options: [
                    {
                        title: "Add/Replace opencode api key",
                        value: "key",
                    },
                    {
                        title: "Add/Replace workspace id / org id",
                        value: "org",
                    },
                    {
                        title: "Removed saved keys",
                        value: "remove",
                    },
                ],
            });
            if (disposed || request !== goDialogRequest) return;
            if (action === "key") await promptGoApiKey();
            else if (action === "org") await promptGoOrgId(request);
            else if (action === "remove") {
                const confirmed = await context.ui.dialog.confirm({
                    title: "Remove saved Go key?",
                    message:
                        "The key will be removed from Windows Credential Manager. An environment key may still be used.",
                    label: { confirm: "Remove", cancel: "Cancel" },
                });
                if (confirmed) await removeGoCredentials();
            }
        };

        const toggleProvider = async (id: ProviderId) => {
            if (disposed) return;
            const next = !isEnabled(id);
            if (id === "opencode" && windowsHost && next) {
                await readVault();
                if (vaultState === "corrupt") {
                    context.ui.toast.show({
                        title: "OpenCode Go / Go Plus",
                        message:
                            "Saved Go credentials need repair. Use /quota-opencode-key to replace or remove them.",
                        variant: "error",
                    });
                    return;
                }
                if (
                    vaultState === "ready" &&
                    !storedCredentials &&
                    !process.env.OPENCODE_QUOTA_GO_API_KEY?.trim()
                ) {
                    await promptGoApiKey();
                    return;
                }
            }
            try {
                await updateSettings((draft) => {
                    draft.enabled ??= { codex: false, opencode: false };
                    draft.enabled[id] = next;
                });
            } catch {
                context.ui.toast.show({
                    title: "Quota usage",
                    message: "Failed to save provider setting to disk",
                    variant: "error",
                });
                return;
            }
            if (next) {
                // Restart the bounded shared generation so a newly opted-in provider starts promptly.
                restartRequests();
                context.ui.toast.show({
                    message:
                        id === "opencode"
                            ? windowsHost && storedCredentials
                                ? "OpenCode enabled"
                                : "OpenCode enabled · configure OPENCODE_QUOTA_GO_API_KEY"
                            : `${PROVIDERS.find((p) => p.id === id)?.label} enabled`,
                });
            } else {
                // Invalidate pending work without stopping another enabled provider's next poll.
                setState((previous) => {
                    const providers = { ...previous.providers };
                    delete providers[id];
                    return { providers };
                });
                restartRequests();
                context.ui.toast.show({
                    message: `${PROVIDERS.find((p) => p.id === id)?.label} disabled`,
                });
            }
        };

        const toggleCollapse = (key: string) => {
            const write = collapseMutation
                .then(async () => {
                    if (disposed) return;
                    const next = new Set(collapsed());
                    if (!next.delete(key)) next.add(key);
                    await updateSettings((draft) => {
                        draft.collapsed = [...next];
                    });
                    if (!disposed) setCollapsed(next);
                })
                .catch(() => {
                    if (!disposed) {
                        context.ui.toast.show({
                            title: "Quota usage",
                            message: "Failed to save collapse setting to disk",
                            variant: "error",
                        });
                    }
                });
            collapseMutation = write;
            return write;
        };

        const applyVisibility = (next: boolean) => {
            if (disposed || next === shown()) return;
            setShown(next);
            if (!next) {
                refreshEpoch++;
                generation++;
                controller?.abort();
                controller = undefined;
                running = false;
                if (poll !== undefined) clearInterval(poll);
                if (clock !== undefined) clearInterval(clock);
                poll = undefined;
                clock = undefined;
                return;
            }
            setNow(Date.now());
            void refresh();
            poll = setInterval(() => void refresh(), POLL_MS);
            clock = setInterval(() => setNow(Date.now()), 30_000);
        };

        applyVisibility(settings.visible);
        // Untracked: the apply reads shown(), so tracking would make this effect depend on
        // its own write. Only the stored setting should drive it.
        createEffect(() => {
            const next = settings.visible;
            untrack(() => applyVisibility(next));
        });
        let keymapRegistered = false;
        // The app slot renders inside the TUI providers; setup itself has no Keymap.Provider.
        const releaseAppSlot = context.ui.slot({
            append: "app",
            render: () => {
                if (!disposed && !keymapRegistered) {
                    keymapRegistered = true;
                    context.keymap.layer(() => ({
                        mode: "global",
                        commands: [
                            {
                                id: "quota-usage.toggle",
                                title: "Toggle quota usage sidebar",
                                slash: { name: "quota-usage" },
                                run: async () => {
                                    if (disposed) return;
                                    const next = !shown();
                                    applyVisibility(next);
                                    try {
                                        await updateSettings((draft) => {
                                            draft.visible = next;
                                        });
                                    } catch {
                                        // Never leave the UI ahead of the persisted store.
                                        applyVisibility(!next);
                                        context.ui.toast.show({
                                            title: "Quota usage",
                                            message: "Failed to save visibility setting to disk",
                                            variant: "error",
                                        });
                                        return;
                                    }
                                    context.ui.toast.show({
                                        message: `Quota usage ${next ? "shown" : "hidden"}`,
                                    });
                                },
                            },
                            {
                                id: "quota-help.help",
                                title: "Quota help",
                                slash: { name: "quota-help" },
                                run: () =>
                                    context.ui.toast.show({
                                        message: `To show quota, enable a provider with:\n${PROVIDERS.map(
                                            (provider) => `- /quota-${provider.id}`,
                                        ).join("\n")}`,
                                    }),
                            },
                            ...PROVIDERS.map((provider) => ({
                                id: `quota-${provider.id}.toggle`,
                                title: `Toggle ${provider.label} quota`,
                                slash: { name: `quota-${provider.id}` },
                                run: () => toggleProvider(provider.id as ProviderId),
                            })),
                            {
                                id: "quota-opencode-key.manage",
                                title: "Manage OpenCode Go / Go Plus key",
                                slash: { name: "quota-opencode-key" },
                                run: () => manageGoCredentials(),
                            },
                            {
                                id: "quota-usage.collapse",
                                title: "Collapse or expand quota usage",
                                palette: true as const,
                                run: () => toggleCollapse("all"),
                            },
                            ...PROVIDERS.map((provider) => ({
                                id: `quota-usage.toggle.${provider.id}`,
                                title: `Toggle ${provider.label} section`,
                                palette: true as const,
                                run: () => toggleCollapse(provider.id),
                            })),
                        ],
                    }));
                }
                return null;
            },
        });
        const releaseSlot = context.ui.slot({
            append: "sidebar.content",
            render: () =>
                shown() ? (
                    <box flexDirection="column">
                        <For
                            each={layoutRows(state(), collapsed(), now(), {
                                codex: isEnabled("codex"),
                                opencode: isEnabled("opencode"),
                            })}
                        >
                            {(row) => {
                                const colors = rowColors(row, context.themeMode, {
                                    base: context.theme.text.base,
                                    muted: context.theme.text.muted,
                                });
                                return (
                                    <>
                                        {row.separator ? (
                                            // A top-bordered box is a rule that always spans the
                                            // sidebar, so it needs no glyph or width arithmetic.
                                            <box
                                                width="100%"
                                                height={1}
                                                flexShrink={0}
                                                border={["top"]}
                                                borderStyle="single"
                                                borderColor={colors.text}
                                            />
                                        ) : row.meter !== undefined ? (
                                            <box width="100%" height={1} flexDirection="row">
                                                <text
                                                    minWidth={0}
                                                    flexShrink={1}
                                                    wrapMode="none"
                                                    truncate
                                                    fg={colors.text}
                                                >
                                                    {row.label}
                                                </text>
                                                <text
                                                    flexGrow={1}
                                                    flexShrink={1}
                                                    minWidth={0}
                                                    textAlign="right"
                                                    wrapMode="none"
                                                    truncate
                                                    fg={colors.text}
                                                >
                                                    {row.percentText}
                                                </text>
                                            </box>
                                        ) : (
                                            <text
                                                width={
                                                    row.reset || row.rightAlign ? "100%" : undefined
                                                }
                                                textAlign={
                                                    row.reset || row.rightAlign
                                                        ? "right"
                                                        : undefined
                                                }
                                                wrapMode="none"
                                                truncate
                                                fg={colors.text}
                                                onMouseDown={
                                                    row.toggle
                                                        ? (event) => {
                                                              if (event.button === 0) {
                                                                  event.preventDefault();
                                                                  event.stopPropagation();
                                                                  void toggleCollapse(row.toggle!);
                                                              }
                                                          }
                                                        : undefined
                                                }
                                            >
                                                {row.heading ? (
                                                    <strong>{row.text}</strong>
                                                ) : (
                                                    row.text
                                                )}
                                            </text>
                                        )}
                                        {row.meter !== undefined ? (
                                            <box
                                                width="100%"
                                                height={1}
                                                flexDirection="row"
                                                // Bars yield before text rows: the label keeps the number even when the track clips away.
                                                flexShrink={1}
                                                overflow="hidden"
                                                backgroundColor={colors.track}
                                            >
                                                {row.meter > 0 ? (
                                                    <box
                                                        width={`${row.meter}%`}
                                                        height={1}
                                                        flexShrink={0}
                                                        backgroundColor={colors.fill}
                                                    />
                                                ) : null}
                                            </box>
                                        ) : null}
                                    </>
                                );
                            }}
                        </For>
                        {/* Cursor spacer, shown only once real data exists so an empty
                            sidebar does not flash a stray line while loading. */}
                        {Object.keys(state().providers).length ? <text> </text> : null}
                    </box>
                ) : null,
        });
        return () => {
            disposed = true;
            refreshEpoch++;
            generation++;
            goDialogRequest++;
            controller?.abort();
            if (poll !== undefined) clearInterval(poll);
            if (clock !== undefined) clearInterval(clock);
            releaseAppSlot?.();
            releaseSlot?.();
        };
    },
});
