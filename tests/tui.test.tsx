import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const codex = vi.hoisted(() => ({
    usage: vi.fn(),
    activeUntil: vi.fn(),
}));

const opencode = vi.hoisted(() => ({
    usage: vi.fn(),
    status: vi.fn(),
}));
const vault = vi.hoisted(() => ({
    load: vi.fn(async () => undefined),
    save: vi.fn(async (_value: unknown) => {}),
    clear: vi.fn(async () => {}),
}));
const dialog = vi.hoisted(() => ({
    show: vi.fn(),
    clear: vi.fn(),
    prompt: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
}));
const makeVaultError = (
    code: "unavailable" | "corrupt" | "invalid",
    message = "secret-bearing OS error",
) => Object.assign(new Error(message), { code });

vi.mock("../src/codex/index", () => ({
    fetchCodexUsage: codex.usage,
    fetchCodexActiveUntil: codex.activeUntil,
    codexStatusOf: () => "unavailable",
    getCodexBackoff: () => ({ nextAllowedAt: 0, remainingMs: 0 }),
}));

vi.mock("../src/opencode/index", () => ({
    fetchOpenCodeUsage: opencode.usage,
    fetchOpenCodeUsageWith: opencode.usage,
    fetchOpenCodeGoStatus: opencode.status,
    fetchOpenCodeGoStatusWith: opencode.status,
    openCodeStatusOf: () => "unavailable",
}));

vi.mock("../src/go-vault/windows", () => ({
    loadWindowsGoCredentials: vault.load,
    saveWindowsGoCredentials: vault.save,
    clearWindowsGoCredentials: vault.clear,
}));

import tui, {
    activeUntilIsCritical,
    displayLines,
    layoutRows,
    meterPercent,
    parseActiveUntil,
    planLabel,
    rowColors,
    USAGE_COLORS,
    usageColor,
    usageSeverity,
    windowRows,
} from "../src/tui";
import type { RowTheme } from "../src/tui";
import type { UsageWindow } from "../src/usage";

/** Shape of a single provider entry in sidebar state. */
type Entry = {
    windows: UsageWindow[];
    plan?: string;
    activeUntil?: string;
    accessEndsAt?: string;
    fetchedAt: number;
    status: string;
    rateLimitedUntil?: number;
};

const codexWindows = [
    { label: "5h", usage: { percentLeft: 70 } },
    { label: "Weekly", usage: { percentLeft: 75 } },
];

/** Raw Codex-shaped payload the mocked fetcher resolves with. */
const codexWindowsPayload = { fiveHour: { percentLeft: 70 }, week: { percentLeft: 75 } };
const settle = async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
};

/** WCAG relative luminance of a #rrggbb hex color. */
function luminance(hex: string): number {
    const linear = [1, 3, 5]
        .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
        .map((channel) =>
            channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        );
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG contrast ratio between two #rrggbb hex colors. */
function contrast(a: string, b: string): number {
    const first = luminance(a);
    const second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("sidebar layout", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const none = new Set<string>();
    const rule = "─".repeat(20);

    /** Build a state with one entry per provider id. */
    const stateWith = (providers: Record<string, Partial<Entry>>) => ({
        providers: Object.fromEntries(
            Object.entries(providers).map(([id, entry]) => [
                id,
                { windows: [], fetchedAt: now, status: "", ...entry },
            ]),
        ),
    });

    const rowFor = (accessEndsAt: string) =>
        layoutRows(stateWith({ opencode: { accessEndsAt, windows: [] } }), none, now).find((row) =>
            row.text.startsWith("Until"),
        );

    test("renders the main header, a rule, then one collapsible section per usage type", () => {
        expect(
            displayLines(
                stateWith({
                    opencode: {
                        plan: "Go Plus",
                        windows: [
                            {
                                label: "5h",
                                usage: { percentLeft: 70, resetsAt: "2026-10-01T13:30:00Z" },
                            },
                            {
                                label: "Weekly",
                                usage: { percentLeft: 5, resetsAt: "2026-10-02T12:00:00Z" },
                            },
                        ],
                    },
                    codex: {
                        plan: "plus",
                        windows: [{ label: "5h", usage: { percentLeft: 100 } }],
                        activeUntil: "2026-10-03T12:00:00Z",
                    },
                }),
                none,
                now,
            ),
        ).toEqual([
            "▼ opencode-tui-quota-usage (0.1.0)",
            rule,
            "▼ OpenCode · GO PLUS",
            "5h 70% left",
            "1h 30m to reset",
            "Weekly 5% left",
            "1d to reset",
            rule,
            "▼ Codex · PLUS",
            "5h 100% left",
            "Reset unavailable",
            "Until Oct 3 · 2d left",
            rule,
        ]);
    });

    test("collapsing the main header hides every body but keeps each section header", () => {
        const state = stateWith({
            opencode: { plan: "Go Plus", windows: [{ label: "5h", usage: { percentLeft: 70 } }] },
            codex: { plan: "plus", windows: [{ label: "5h", usage: { percentLeft: 100 } }] },
        });
        expect(displayLines(state, new Set(["all"]), now)).toEqual([
            "▶ opencode-tui-quota-usage (0.1.0)",
            rule,
            "▶ OpenCode · GO PLUS",
            rule,
            "▶ Codex · PLUS",
            rule,
        ]);
        // Re-expanding restores both bodies, so "all" does not consume section state.
        expect(displayLines(state, none, now).length).toBeGreaterThan(
            displayLines(state, new Set(["all"]), now).length,
        );
    });

    test("collapsing one section leaves the others expanded", () => {
        expect(
            displayLines(
                stateWith({
                    opencode: {
                        plan: "Go Plus",
                        windows: [{ label: "5h", usage: { percentLeft: 70 } }],
                    },
                    codex: {
                        plan: "plus",
                        windows: [{ label: "5h", usage: { percentLeft: 100 } }],
                    },
                }),
                new Set(["opencode"]),
                now,
            ),
        ).toEqual([
            "▼ opencode-tui-quota-usage (0.1.0)",
            rule,
            "▶ OpenCode · GO PLUS",
            rule,
            "▼ Codex · PLUS",
            "5h 100% left",
            "Reset unavailable",
            rule,
        ]);
    });

    test("keeps missing windows, status, and staleness visible per section", () => {
        expect(
            displayLines(
                stateWith({
                    opencode: {
                        windows: [{ label: "5h", usage: { percentLeft: 100 } }],
                        fetchedAt: now - 6 * 60_000,
                        status: "Unavailable",
                    },
                }),
                none,
                now,
            ),
        ).toEqual([
            "▼ opencode-tui-quota-usage (0.1.0)",
            rule,
            "▼ OpenCode",
            "5h 100% left",
            "Reset unavailable",
            "Note: Unavailable",
            "(stale)",
            rule,
            "▼ Codex",
            "No data",
            rule,
        ]);
    });

    test("surfaces a status once when a section reports one without any windows", () => {
        expect(
            displayLines(
                stateWith({ opencode: { status: "Set OPENCODE_QUOTA_GO_API_KEY" } }),
                none,
                now,
            ),
        ).toEqual([
            "▼ opencode-tui-quota-usage (0.1.0)",
            rule,
            "▼ OpenCode",
            "Set OPENCODE_QUOTA_GO_API_KEY",
            rule,
            "▼ Codex",
            "No data",
            rule,
        ]);
    });

    test("renders OpenCode expiry exactly like Codex without changing the source field", () => {
        const lines = displayLines(
            stateWith({
                opencode: {
                    plan: "Go Plus",
                    accessEndsAt: "2026-10-03T00:00:00Z",
                    windows: [],
                },
                codex: { activeUntil: "2026-10-03T00:00:00Z", windows: [] },
            }),
            none,
            now,
        );
        expect(lines).toContain("▼ OpenCode · GO PLUS");
        expect(lines).toContain("Until Oct 3 · 1d 12h left");
        expect(lines.filter((line) => line.startsWith("Until"))).toHaveLength(2);
        expect(lines.some((line) => line.includes("2026"))).toBe(false);
        const invalid = displayLines(
            stateWith({ opencode: { accessEndsAt: "invalid" } }),
            none,
            now,
        );
        expect(invalid.some((line) => line.startsWith("Access until"))).toBe(false);
        expect(invalid.some((line) => line.startsWith("Until"))).toBe(false);
        expect(displayLines(stateWith({ opencode: {} }), none, now)).toContain("▼ OpenCode");
    });

    test("colors OpenCode expiry critical within 24 hours, including under one hour and expired", () => {
        expect(rowFor("2026-10-02T12:00:00Z")).toMatchObject({
            text: "Until Oct 2 · 1d left",
            muted: true,
            severity: undefined,
        });
        expect(rowFor("2026-10-01T13:00:00Z")).toMatchObject({
            text: "Until Oct 1 · 1h left",
            severity: "critical",
        });
        expect(rowFor("2026-10-01T12:30:00Z")).toMatchObject({
            text: "Until Oct 1 · 30m left",
            severity: "critical",
        });
        expect(rowFor("2026-10-01T11:00:00Z")).toMatchObject({
            text: "Until Oct 1 · 1h ago",
            severity: "critical",
        });
        expect(rowFor("2026-10-01T12:00:00Z")).toMatchObject({
            text: "Until Oct 1 · now",
            severity: "critical",
        });
    });

    test("recomputes the rate-limit countdown from the render clock, not the frozen status", () => {
        const until = now + 10 * 60_000;
        const state = stateWith({
            codex: {
                windows: codexWindows,
                status: "Rate limited · retry later",
                rateLimitedUntil: until,
            },
        });
        expect(displayLines(state, none, now)).toContain("Note: Rate limited · retry in 10m");
        expect(displayLines(state, none, now + 30_000)).toContain(
            "Note: Rate limited · retry in 10m",
        );
        expect(displayLines(state, none, now + 9 * 60_000)).toContain(
            "Note: Rate limited · retry in 1m",
        );
        expect(displayLines(state, none, until)).toContain("Note: Rate limited · retry later");
    });

    test("does not print control characters or unbounded text from the plan", () => {
        const lines = displayLines(
            stateWith({ codex: { plan: "\u001b[31m super-long-plan-name-for-terminal" } }),
            none,
            now,
        );
        expect(lines.find((line) => line.includes("Codex"))).toBe("▼ Codex · SUPER LONG PLAN...");
    });

    test("native meter widths are bounded and only accompany valid windows", () => {
        expect([0, 100, -20, 160, Number.NaN, Infinity].map(meterPercent)).toEqual([
            0,
            100,
            0,
            100,
            undefined,
            undefined,
        ]);
        const rows = windowRows(
            [
                { label: "5h", usage: { percentLeft: 0 } },
                { label: "Weekly", usage: { percentLeft: 100 } },
            ],
            now,
        );
        expect(rows.filter((row) => row.meter !== undefined).map((row) => row.meter)).toEqual([
            0, 100,
        ]);
        expect(
            rows
                .filter((row) => row.meter !== undefined)
                .map(({ label, percentText }) => [label, percentText]),
        ).toEqual([
            ["5h", "0% left"],
            ["Weekly", "100% left"],
        ]);
        expect(rows.map((row) => row.text)).toContain("5h 0% left");
        expect(rows.map((row) => row.text)).toContain("Weekly 100% left");
        expect(rows.filter((row) => row.reset).map((row) => row.text)).toEqual([
            "Reset unavailable",
            "Reset unavailable",
        ]);
        expect(
            windowRows([{ label: "5h", usage: { percentLeft: NaN } }], now).filter(
                (row) => row.meter !== undefined,
            ),
        ).toEqual([]);
        // Bars are native boxes; no width-dependent glyphs leak into the text layout.
        expect(rows.every((row) => !/[#[\]-]/.test(row.text))).toBe(true);
    });

    test("meter fill follows the displayed rounded percent at boundaries", () => {
        const rows = windowRows(
            [
                { label: "5h", usage: { percentLeft: 99.96 } },
                { label: "Weekly", usage: { percentLeft: 0.04 } },
            ],
            now,
        ).filter((row) => row.meter !== undefined);
        expect(rows.map(({ text, percentText, meter }) => [text, percentText, meter])).toEqual([
            ["5h 100% left", "100% left", 100],
            ["Weekly 0% left", "0% left", 0],
        ]);
    });

    test("colors usage at left-percent warning and critical thresholds", () => {
        expect(usageColor("normal", "dark", "theme-base")).toBe("theme-base");
        expect(usageColor("warning", "dark")).toBe("#f2cf76");
        expect(usageColor("critical", "dark")).toBe("#f17471");
        expect(usageColor("warning", "light")).toBe("#8a6d00");
        expect(usageColor("critical", "light")).toBe("#b3261e");
        expect(usageColor("normal", "light")).toBe("#1a7f37");
        for (const mode of ["dark", "light"] as const) {
            for (const severity of ["normal", "warning", "critical"] as const) {
                // A fill the track washes out leaves the meter length unreadable.
                const ratio = contrast(USAGE_COLORS[mode][severity], USAGE_COLORS[mode].track);
                expect(ratio).toBeGreaterThanOrEqual(3);
            }
        }
        expect([100, 45.01, 45, 10.01, 10, 0, Number.NaN].map(usageSeverity)).toEqual([
            "normal",
            "normal",
            "warning",
            "warning",
            "critical",
            "critical",
            "normal",
        ]);
        const rows = windowRows(
            [
                { label: "5h", usage: { percentLeft: 45 } },
                { label: "Weekly", usage: { percentLeft: 10 } },
            ],
            now,
        );
        expect(rows.filter((row) => row.meter !== undefined).map((row) => row.severity)).toEqual([
            "warning",
            "critical",
        ]);
        const boundaryRows = windowRows(
            [
                { label: "5h", usage: { percentLeft: 45.04 } },
                { label: "Weekly", usage: { percentLeft: 10.04 } },
            ],
            now,
        );
        expect(
            boundaryRows
                .filter((row) => row.meter !== undefined)
                .map((row) => [row.percentText, row.severity]),
        ).toEqual([
            ["45% left", "warning"],
            ["10% left", "critical"],
        ]);
    });

    test("flags active-until under 24 hours and expired access, not the exact boundary", () => {
        expect(activeUntilIsCritical(Date.parse("2026-10-02T12:00:00Z"), now)).toBe(false);
        expect(activeUntilIsCritical(Date.parse("2026-10-02T11:59:59Z"), now)).toBe(true);
        expect(activeUntilIsCritical(Date.parse("2026-10-01T11:59:00Z"), now)).toBe(true);
        expect([undefined, "", "not a date"].map(parseActiveUntil)).toEqual([
            undefined,
            undefined,
            undefined,
        ]);
        expect(parseActiveUntil("2026-10-03T12:00:00Z")).toBe(Date.parse("2026-10-03T12:00:00Z"));
        const activeUntilRows = (activeUntil: string) =>
            layoutRows(stateWith({ codex: { windows: [], activeUntil } }), none, now);
        expect(
            activeUntilRows("2026-10-01T23:00:00Z").find((row) => row.text.startsWith("Until")),
        ).toMatchObject({ muted: true, severity: "critical" });
        // A boundary still well outside the window keeps the muted note color, so severity is not the only path.
        expect(
            activeUntilRows("2026-10-03T12:00:00Z").find((row) => row.text.startsWith("Until")),
        ).toMatchObject({ muted: true, severity: undefined });
        expect(activeUntilRows("not a date").some((row) => row.text.startsWith("Until"))).toBe(
            false,
        );
    });

    test("resolves row colors from severity then theme, shared by the sidebar and the preview", () => {
        const theme: RowTheme = { base: "theme-base", muted: "theme-muted" };
        const rows = layoutRows(
            stateWith({
                codex: {
                    windows: [
                        { label: "5h", usage: { percentLeft: 70 } },
                        {
                            label: "Weekly",
                            usage: { percentLeft: 5, resetsAt: "2026-10-02T12:00:00Z" },
                        },
                    ],
                    activeUntil: "2026-10-03T12:00:00Z",
                    status: "Unavailable",
                },
            }),
            none,
            now,
        );
        const byText = (text: string) =>
            rowColors(
                rows.find((row) => row.text === text)!,
                "dark",
                theme,
            );
        // A normal meter label takes the theme base, never the palette normal color.
        expect(byText("5h 70% left")).toEqual({
            text: "theme-base",
            fill: "#6bd586",
            track: "#484848",
        });
        // Severity drives both the text and the fill so they can never disagree.
        expect(byText("Weekly 5% left")).toEqual({
            text: "#f17471",
            fill: "#f17471",
            track: "#484848",
        });
        // Muted rows borrow the theme muted color and keep the normal palette fill.
        expect(byText("1d to reset").text).toBe("theme-muted");
        // The header is neither muted nor a meter, so it falls back to the base color.
        expect(byText("▼ Codex")).toEqual({
            text: "theme-base",
            fill: "#6bd586",
            track: "#484848",
        });
        // A critical Until row keeps its severity color even though it is muted.
        const criticalUntil = layoutRows(
            stateWith({ codex: { windows: [], activeUntil: "2026-10-01T23:00:00Z" } }),
            none,
            now,
        ).find((row) => row.text.startsWith("Until"))!;
        expect(rowColors(criticalUntil, "dark", theme).text).toBe("#f17471");
        expect(rowColors(rows[0], "light", theme).track).toBe(USAGE_COLORS.light.track);
    });

    test("normalizes plan names into short, safe, uppercase labels", () => {
        expect([undefined, "", "   ", "!!!", "plus"].map(planLabel)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            "PLUS",
        ]);
        expect(planLabel("go-plus")).toBe("GO PLUS");
        expect(planLabel("\u001b[31m pro")).toBe("PRO");
        expect(planLabel("a-very-long-plan-name")).toBe("A VERY LONG...");
    });
});

describe("default TUI usage refresh and optional Until lookup", () => {
    const settings: { visible: boolean; enabled?: Record<string, boolean>; collapsed?: string[] } =
        {
            visible: true,
            enabled: { codex: true, opencode: true },
        };
    const updateSettings = vi.fn(async (mutate: (draft: typeof settings) => void) =>
        mutate(settings),
    );
    const store = vi.fn(() => [settings, updateSettings]);
    const layer = vi.fn();
    const slot = vi.fn((_options: { append: string; render: () => unknown }) => vi.fn());
    const toast = vi.fn();
    const context = () =>
        ({
            storage: { store },
            keymap: { layer },
            ui: { slot, toast: { show: toast }, dialog },
        }) as unknown as Parameters<typeof tui.setup>[0];
    const appSlot = () => {
        const registration = slot.mock.calls.filter(([options]) => options.append === "app").at(-1);
        expect(registration).toBeDefined();
        return registration![0].render as () => unknown;
    };
    const command = () => {
        expect(layer).not.toHaveBeenCalled();
        expect(appSlot()()).toBeNull();
        const config = layer.mock.calls[0][0]();
        expect(config.mode).toBe("global");
        expect(config.commands[0]).toMatchObject({
            id: "quota-usage.toggle",
            title: "Toggle quota usage sidebar",
            slash: { name: "quota-usage" },
        });
        return config.commands[0].run as () => Promise<void>;
    };

    /** The registered keymap commands, so collapse behavior can be exercised. */
    const commands = () => {
        appSlot()();
        return layer.mock.calls.at(-1)![0]().commands;
    };
    beforeEach(() => {
        vi.useFakeTimers();
        codex.usage.mockReset();
        codex.activeUntil.mockReset();
        opencode.usage.mockReset();
        opencode.status.mockReset();
        codex.usage.mockResolvedValue({ fiveHour: { percentLeft: 70 }, week: { percentLeft: 75 } });
        codex.activeUntil.mockResolvedValue(undefined);
        opencode.usage.mockResolvedValue([{ label: "5h", usage: { percentLeft: 60 } }]);
        opencode.status.mockResolvedValue(undefined);
        settings.visible = true;
        settings.enabled = { codex: true, opencode: true };
        settings.collapsed = undefined;
        updateSettings.mockClear();
        updateSettings.mockImplementation(async (mutate) => mutate(settings));
        store.mockClear();
        layer.mockClear();
        slot.mockClear();
        toast.mockClear();
        vault.load.mockResolvedValue(undefined);
        vault.save.mockClear();
        vault.clear.mockClear();
        vault.save.mockImplementation(async (value: unknown) => {
            vault.load.mockResolvedValue(value as never);
        });
        vault.clear.mockImplementation(async () => {
            vault.load.mockResolvedValue(undefined);
        });
        dialog.show.mockClear();
        dialog.clear.mockClear();
        dialog.prompt.mockReset().mockResolvedValue(undefined);
        dialog.select.mockReset().mockResolvedValue(undefined);
        dialog.confirm.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => vi.useRealTimers());

    test("keeps reset rows separate and usable at narrow sidebar widths", () => {
        const now = Date.parse("2026-10-01T12:00:00Z");
        const rows = windowRows(
            [
                { label: "5h", usage: { percentLeft: 70, resetsAt: "2026-10-01T13:30:00Z" } },
                { label: "Weekly", usage: { percentLeft: 5, resetsAt: "2026-10-02T12:00:00Z" } },
            ],
            now,
        );
        const resets = rows.filter((row) => row.reset);
        expect(resets.map((row) => row.text)).toEqual(["1h 30m to reset", "1d to reset"]);
        expect(resets.every((row) => row.muted && row.text.length <= 20)).toBe(true);
        expect(rows.findIndex((row) => row.reset)).toBe(
            rows.findIndex((row) => row.meter !== undefined) + 1,
        );
    });

    test("registers a collapse command for the main header and each usage type", async () => {
        const dispose = await tui.setup(context());
        try {
            const ids = commands().map((entry: { id: string }) => entry.id);
            expect(ids).toEqual([
                "quota-usage.toggle",
                "quota-providers.help",
                "quota-opencode.toggle",
                "quota-codex.toggle",
                "quota-opencode-key.manage",
                "quota-usage.collapse",
                "quota-usage.toggle.opencode",
                "quota-usage.toggle.codex",
            ]);
        } finally {
            if (typeof dispose === "function") {
                dispose();
            }
        }
    });

    test("persists independent section collapse choices across setup recreation", async () => {
        const dispose = await tui.setup(context());
        try {
            const entries = commands();
            await entries
                .find((entry: { id: string }) => entry.id === "quota-usage.toggle.codex")
                .run();
            await entries
                .find((entry: { id: string }) => entry.id === "quota-usage.toggle.opencode")
                .run();
            expect(settings.collapsed).toEqual(["codex", "opencode"]);
        } finally {
            if (typeof dispose === "function") dispose();
        }
        const nextDispose = await tui.setup(context());
        try {
            const entries = commands();
            await entries
                .find((entry: { id: string }) => entry.id === "quota-usage.toggle.codex")
                .run();
            expect(settings.collapsed).toEqual(["opencode"]);
        } finally {
            if (typeof nextDispose === "function") nextDispose();
        }
        const lastDispose = await tui.setup(context());
        try {
            const entries = commands();
            await entries
                .find((entry: { id: string }) => entry.id === "quota-usage.toggle.codex")
                .run();
            expect(settings.collapsed).toEqual(["opencode", "codex"]);
        } finally {
            if (typeof lastDispose === "function") lastDispose();
        }
    });

    test("all collapse preserves provider choices, and save failure leaves UI state alone", async () => {
        const dispose = await tui.setup(context());
        try {
            const entries = commands();
            await entries
                .find((entry: { id: string }) => entry.id === "quota-usage.toggle.codex")
                .run();
            await entries
                .find((entry: { id: string }) => entry.id === "quota-usage.collapse")
                .run();
            expect(settings.collapsed).toEqual(["codex", "all"]);
            updateSettings.mockRejectedValueOnce(new Error("disk"));
            await entries
                .find((entry: { id: string }) => entry.id === "quota-usage.toggle.opencode")
                .run();
            expect(settings.collapsed).toEqual(["codex", "all"]);
            expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error" }));
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("rapid collapse commands serialize and legacy settings start expanded", async () => {
        const dispose = await tui.setup(context());
        try {
            const entries = commands();
            const toggle = entries.find(
                (entry: { id: string }) => entry.id === "quota-usage.toggle.codex",
            ).run;
            const first = toggle();
            const second = toggle();
            await Promise.all([first, second]);
            expect(settings.collapsed).toEqual([]);

            settings.collapsed = undefined;
            const thirdDispose = await tui.setup(context());
            try {
                const recreated = commands();
                await recreated
                    .find((entry: { id: string }) => entry.id === "quota-usage.toggle.codex")
                    .run();
                expect(settings.collapsed).toEqual(["codex"]);
            } finally {
                if (typeof thirdDispose === "function") thirdDispose();
            }
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("expanding all leaves individual provider collapse choices intact", async () => {
        settings.collapsed = ["codex", "all"];
        const dispose = await tui.setup(context());
        try {
            const entries = commands();
            await entries
                .find((entry: { id: string }) => entry.id === "quota-usage.collapse")
                .run();
            expect(settings.collapsed).toEqual(["codex"]);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("refreshes every provider on the shared poll schedule", async () => {
        const dispose = await tui.setup(context());
        try {
            await settle();
            expect(opencode.usage).toHaveBeenCalledTimes(1);
            expect(codex.usage).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(opencode.usage).toHaveBeenCalledTimes(2);
            expect(codex.usage).toHaveBeenCalledTimes(2);
        } finally {
            if (typeof dispose === "function") {
                dispose();
            }
        }
    });

    test("one failing provider does not blank the other section", async () => {
        opencode.usage.mockRejectedValue(new Error("raw secret-marker"));
        const dispose = await tui.setup(context());
        try {
            await settle();
            await Promise.resolve();
            const rows = layoutRows(
                {
                    providers: {
                        opencode: { windows: [], fetchedAt: Date.now(), status: "Unavailable" },
                        codex: { windows: codexWindows, fetchedAt: Date.now(), status: "" },
                    },
                },
                new Set(),
                Date.now(),
            );
            expect(rows.map((row) => row.text)).toContain("▼ OpenCode");
            expect(rows.map((row) => row.text)).toContain("▼ Codex");
        } finally {
            if (typeof dispose === "function") {
                dispose();
            }
        }
    });

    test("automatically requests active_until after usage succeeds, without waiting for it", async () => {
        let completeUsage!: (value: typeof codexWindowsPayload) => void;
        codex.usage.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    completeUsage = resolve;
                }),
        );
        codex.activeUntil.mockImplementation(() => new Promise(() => {}));
        const dispose = await tui.setup(context());
        try {
            await settle();
            expect(codex.usage).toHaveBeenCalledTimes(1);
            expect(codex.activeUntil).not.toHaveBeenCalled();
            completeUsage(codexWindowsPayload);
            // The follow-up is chained after the meters are stored, so it settles
            // a couple of microtasks later rather than in the same turn.
            await Promise.resolve();
            await Promise.resolve();
            expect(codex.activeUntil).toHaveBeenCalledTimes(1);
            expect(slot).toHaveBeenCalledTimes(2);
            // Pending optional lookup does not hold up the next usage refresh.
            codex.usage.mockResolvedValue(codexWindowsPayload);
            await vi.advanceTimersByTimeAsync(120_000);
            await settle();
            expect(codex.usage).toHaveBeenCalledTimes(2);
            expect(codex.activeUntil).toHaveBeenCalledTimes(2);
        } finally {
            if (typeof dispose === "function") {
                dispose();
            }
        }
    });

    test("subscription failure is swallowed and does not block subsequent usage", async () => {
        codex.usage.mockResolvedValue(codexWindowsPayload);
        codex.activeUntil.mockRejectedValue(new Error("raw secret-marker account-marker"));
        const dispose = await tui.setup(context());
        try {
            await settle();
            expect(codex.activeUntil).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(codex.usage).toHaveBeenCalledTimes(2);
            expect(codex.activeUntil).toHaveBeenCalledTimes(2);
        } finally {
            if (typeof dispose === "function") {
                dispose();
            }
        }
    });

    test("cleanup stops both the usage poll and the minute-scale display clock", async () => {
        codex.usage.mockResolvedValue(codexWindowsPayload);
        codex.activeUntil.mockResolvedValue(undefined);
        const dispose = await tui.setup(context());
        await settle();
        expect(vi.getTimerCount()).toBe(2);
        if (typeof dispose === "function") {
            dispose();
        }
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(codex.usage).toHaveBeenCalledTimes(1);
        expect(slot.mock.results[0]?.value).toHaveBeenCalledTimes(1);
        expect(slot.mock.results.at(-1)?.value).toHaveBeenCalledTimes(1);
    });

    test("registers keymap only when the app slot renders, once across rerenders", async () => {
        codex.usage.mockResolvedValue(codexWindowsPayload);
        const dispose = await tui.setup(context());
        try {
            expect(slot.mock.calls.map(([options]) => options.append)).toEqual([
                "app",
                "sidebar.content",
            ]);
            expect(layer).not.toHaveBeenCalled();
            const render = appSlot();
            expect(render()).toBeNull();
            expect(render()).toBeNull();
            expect(layer).toHaveBeenCalledTimes(1);
            expect(layer.mock.calls[0][0]().commands[0].id).toBe("quota-usage.toggle");
        } finally {
            if (typeof dispose === "function") dispose();
        }
        expect(appSlot()()).toBeNull();
        expect(layer).toHaveBeenCalledTimes(1);
        expect(slot.mock.results[0]?.value).toHaveBeenCalledTimes(1);
        expect(slot.mock.results[1]?.value).toHaveBeenCalledTimes(1);
    });

    test("registers a local slash command, hides and resumes polling, and persists visibility", async () => {
        codex.usage.mockResolvedValue(codexWindowsPayload);
        codex.activeUntil.mockResolvedValue(undefined);
        const dispose = await tui.setup(context());
        try {
            await settle();
            expect(store).toHaveBeenCalledWith("settings", {
                initial: {
                    visible: true,
                    enabled: { codex: false, opencode: false },
                    collapsed: [],
                },
            });
            const toggle = command();
            await Promise.resolve();
            expect(vi.getTimerCount()).toBe(2);
            await toggle();
            expect(settings.visible).toBe(false);
            expect(toast).toHaveBeenLastCalledWith({ message: "Quota usage hidden" });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(240_000);
            expect(codex.usage).toHaveBeenCalledTimes(1);
            await toggle();
            expect(settings.visible).toBe(true);
            expect(toast).toHaveBeenLastCalledWith({ message: "Quota usage shown" });
            await settle();
            expect(codex.usage).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(2);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(codex.usage).toHaveBeenCalledTimes(3);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("rolls the toggle back and reports an error when the settings write fails", async () => {
        codex.usage.mockResolvedValue(codexWindowsPayload);
        codex.activeUntil.mockResolvedValue(undefined);
        const dispose = await tui.setup(context());
        updateSettings.mockRejectedValueOnce(new Error("EACCES: permission denied"));
        try {
            const toggle = command();
            await Promise.resolve();
            expect(vi.getTimerCount()).toBe(2);
            await toggle();
            expect(settings.visible).toBe(true);
            expect(vi.getTimerCount()).toBe(2);
            expect(toast).toHaveBeenLastCalledWith({
                title: "Quota usage",
                message: "Failed to save visibility setting to disk",
                variant: "error",
            });
            await toggle();
            expect(settings.visible).toBe(false);
            expect(toast).toHaveBeenLastCalledWith({ message: "Quota usage hidden" });
        } finally {
            updateSettings.mockImplementation(async (mutate) => mutate(settings));
            if (typeof dispose === "function") dispose();
        }
    });

    test("starts hidden from saved settings and refreshes on show", async () => {
        codex.usage.mockResolvedValue(codexWindowsPayload);
        codex.activeUntil.mockResolvedValue(undefined);
        const firstDispose = await tui.setup(context());
        await command()();
        if (typeof firstDispose === "function") firstDispose();
        expect(settings.visible).toBe(false);
        codex.usage.mockClear();
        layer.mockClear();
        const dispose = await tui.setup(context());
        try {
            expect(codex.usage).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            await command()();
            await settle();
            expect(codex.usage).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(2);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("ignores pending usage and subscription results after hide and cleanup", async () => {
        let resolveUsage!: (value: typeof codexWindowsPayload) => void;
        let resolveUntil!: (value: string) => void;
        codex.usage.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveUsage = resolve;
                }),
        );
        codex.activeUntil.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveUntil = resolve;
                }),
        );
        const dispose = await tui.setup(context());
        await settle();
        const toggle = command();
        await toggle();
        resolveUsage(codexWindowsPayload);
        await Promise.resolve();
        expect(codex.activeUntil).not.toHaveBeenCalled();
        codex.usage.mockResolvedValue(codexWindowsPayload);
        await toggle();
        await settle();
        expect(codex.activeUntil).toHaveBeenCalledTimes(1);
        await toggle();
        resolveUntil("2027-01-01T00:00:00Z");
        await Promise.resolve();
        if (typeof dispose === "function") dispose();
        expect(vi.getTimerCount()).toBe(0);
        expect(slot.mock.results.at(-1)?.value).toHaveBeenCalledTimes(1);
    });

    test("providers default to opt-in and disabling one does not fetch it", async () => {
        settings.enabled = undefined;
        const dispose = await tui.setup(context());
        try {
            await Promise.resolve();
            expect(codex.usage).not.toHaveBeenCalled();
            expect(opencode.usage).not.toHaveBeenCalled();
            const providerToggle = commands().find(
                (entry: { id: string }) => entry.id === "quota-codex.toggle",
            ).run;
            await providerToggle();
            await settle();
            expect(codex.usage).toHaveBeenCalledTimes(1);
            expect(opencode.usage).not.toHaveBeenCalled();
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("enabling OpenCode without a key starts visible native credential prompts", async () => {
        settings.enabled = { codex: false, opencode: false };
        const prior = process.env.OPENCODE_QUOTA_GO_API_KEY;
        delete process.env.OPENCODE_QUOTA_GO_API_KEY;
        const dispose = await tui.setup(context());
        try {
            await settle();
            const run = commands().find(
                (entry: { id: string }) => entry.id === "quota-opencode.toggle",
            ).run;
            await run();
            expect(settings.enabled?.opencode).toBe(false);
            expect(dialog.prompt).toHaveBeenCalledOnce();
            expect(dialog.prompt.mock.calls[0][0].description).toContain("visible while typing");
            expect(dialog.prompt.mock.calls[0][0].description).toContain("screen sharing");
        } finally {
            if (prior !== undefined) process.env.OPENCODE_QUOTA_GO_API_KEY = prior;
            if (typeof dispose === "function") dispose();
        }
    });

    test("native key prompt preserves the existing org ID", async () => {
        settings.enabled = { codex: false, opencode: true };
        vault.load.mockResolvedValue({ apiKey: "old-key", orgId: "org-keep" } as never);
        delete process.env.OPENCODE_QUOTA_GO_API_KEY;
        const dispose = await tui.setup(context());
        try {
            dialog.select.mockResolvedValueOnce("key");
            dialog.prompt.mockResolvedValueOnce("saved-key");
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            await settle();
            expect(dialog.select.mock.calls[0][0].options[0].title).toBe(
                "Add/Replace opencode api key",
            );
            expect(vault.save).toHaveBeenCalledWith({ apiKey: "saved-key", orgId: "org-keep" });
            expect(opencode.usage).toHaveBeenCalled();
            expect(opencode.usage.mock.calls.at(-1)?.[0]).toBe("saved-key");
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("canceling either native prompt prevents vault and settings side effects", async () => {
        settings.enabled = { codex: false, opencode: false };
        delete process.env.OPENCODE_QUOTA_GO_API_KEY;
        const dispose = await tui.setup(context());
        try {
            await settle();
            dialog.prompt.mockResolvedValueOnce(undefined);
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
                .run();
            expect(vault.save).not.toHaveBeenCalled();
            expect(settings.enabled?.opencode).toBe(false);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("rejects invalid keys before prompting for org or writing vault", async () => {
        settings.enabled = { codex: false, opencode: false };
        delete process.env.OPENCODE_QUOTA_GO_API_KEY;
        const dispose = await tui.setup(context());
        try {
            dialog.prompt.mockResolvedValueOnce("bad key");
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
                .run();
            expect(dialog.prompt).toHaveBeenCalledOnce();
            expect(vault.save).not.toHaveBeenCalled();
            expect(settings.enabled?.opencode).toBe(false);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("plugin disposal invalidates pending native credential prompts", async () => {
        settings.enabled = { codex: false, opencode: false };
        delete process.env.OPENCODE_QUOTA_GO_API_KEY;
        const dispose = await tui.setup(context());
        dialog.prompt.mockResolvedValueOnce("after-dispose");
        const pending = commands()
            .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
            .run();
        if (typeof dispose === "function") dispose();
        await pending;
        await settle();
        expect(vault.save).not.toHaveBeenCalled();
        expect(settings.enabled?.opencode).toBe(false);
    });

    test("a vault write finishing after dismissal is retained but causes no late UI mutation", async () => {
        settings.enabled = { codex: false, opencode: false };
        delete process.env.OPENCODE_QUOTA_GO_API_KEY;
        let complete!: () => void;
        vault.save.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                }),
        );
        const dispose = await tui.setup(context());
        try {
            await settle();
            dialog.prompt.mockResolvedValueOnce("committed-key");
            const saving = commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
                .run();
            await settle();
            expect(vault.save).toHaveBeenCalledOnce();
            // Disposing while the OS write runs retains the commit but skips settings/UI work.
            if (typeof dispose === "function") dispose();
            complete();
            await saving;
            expect(settings.enabled?.opencode).toBe(false);
            expect(toast).not.toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining("committed-key") }),
            );
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("vault success with settings failure reports partial success and keeps the key", async () => {
        settings.enabled = { codex: false, opencode: false };
        delete process.env.OPENCODE_QUOTA_GO_API_KEY;
        const dispose = await tui.setup(context());
        updateSettings.mockRejectedValueOnce(new Error("disk error"));
        try {
            dialog.prompt.mockResolvedValueOnce("stored-key");
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
                .run();
            await settle();
            expect(vault.save).toHaveBeenCalledWith({ apiKey: "stored-key" });
            expect(settings.enabled?.opencode).toBe(false);
            expect(toast).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining("Credentials remain stored"),
                }),
            );
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
                .run();
            await settle();
            expect(settings.enabled?.opencode).toBe(true);
        } finally {
            updateSettings.mockImplementation(async (mutate) => mutate(settings));
            if (typeof dispose === "function") dispose();
        }
    });

    test("confirmed native removal explains environment fallback and preserves enablement", async () => {
        settings.enabled = { codex: false, opencode: true };
        vault.load.mockResolvedValue({ apiKey: "stored-value", orgId: "org-safe" } as never);
        const dispose = await tui.setup(context());
        try {
            await settle();
            dialog.select.mockResolvedValueOnce("remove");
            dialog.confirm.mockResolvedValueOnce(true);
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            expect(vault.clear).toHaveBeenCalledOnce();
            expect(settings.enabled?.opencode).toBe(true);
            expect(toast).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        "OPENCODE_QUOTA_GO_API_KEY may still be used if set; Go is still enabled",
                    ),
                }),
            );
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("canceling native removal leaves vault untouched", async () => {
        settings.enabled = { codex: false, opencode: true };
        vault.load.mockResolvedValue({ apiKey: "stored-value" } as never);
        const dispose = await tui.setup(context());
        try {
            dialog.select.mockResolvedValueOnce("remove");
            dialog.confirm.mockResolvedValueOnce(false);
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            expect(vault.clear).not.toHaveBeenCalled();
            expect(settings.enabled?.opencode).toBe(true);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("native Replace key selection runs the credential prompts", async () => {
        settings.enabled = { codex: false, opencode: true };
        vault.load.mockResolvedValue({ apiKey: "old-key" } as never);
        const dispose = await tui.setup(context());
        try {
            dialog.select.mockResolvedValueOnce("key");
            dialog.prompt.mockResolvedValueOnce("new-key");
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            expect(vault.save).toHaveBeenCalledWith({ apiKey: "new-key" });
            expect(vault.save).not.toHaveBeenCalledWith(
                expect.objectContaining({ apiKey: "old-key" }),
            );
            expect(
                dialog.select.mock.calls[0][0].options.map(
                    (option: { title: string }) => option.title,
                ),
            ).toEqual([
                "Add/Replace opencode api key",
                "Add/Replace workspace id / org id",
                "Removed saved keys",
            ]);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("org-only action preserves the saved key and blank clears the org", async () => {
        settings.enabled = { codex: false, opencode: true };
        vault.load.mockResolvedValue({ apiKey: "secret-key", orgId: "org-old" } as never);
        const dispose = await tui.setup(context());
        try {
            dialog.select.mockResolvedValueOnce("org");
            dialog.prompt.mockResolvedValueOnce("");
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            expect(dialog.prompt).toHaveBeenCalledOnce();
            expect(dialog.prompt.mock.calls[0][0].title).toContain("org ID");
            expect(vault.save).toHaveBeenCalledWith({ apiKey: "secret-key" });
            expect(settings.enabled?.opencode).toBe(true);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("org-only action never copies an environment key into the vault", async () => {
        settings.enabled = { codex: false, opencode: true };
        const prior = process.env.OPENCODE_QUOTA_GO_API_KEY;
        process.env.OPENCODE_QUOTA_GO_API_KEY = "environment-secret";
        const dispose = await tui.setup(context());
        try {
            dialog.select.mockResolvedValueOnce("org");
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            expect(dialog.prompt).not.toHaveBeenCalled();
            expect(vault.save).not.toHaveBeenCalled();
            expect(JSON.stringify(toast.mock.calls)).not.toContain("environment-secret");
        } finally {
            if (prior === undefined) delete process.env.OPENCODE_QUOTA_GO_API_KEY;
            else process.env.OPENCODE_QUOTA_GO_API_KEY = prior;
            if (typeof dispose === "function") dispose();
        }
    });

    test("provider persistence failure rolls the enablement back", async () => {
        settings.enabled = { codex: false, opencode: false };
        updateSettings.mockRejectedValueOnce(new Error("disk"));
        const dispose = await tui.setup(context());
        try {
            await settle();
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-codex.toggle")
                .run();
            expect(settings.enabled?.codex).toBe(false);
            expect(codex.usage).not.toHaveBeenCalled();
            expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ variant: "error" }));
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("corrupt vault data fails closed but permits repair without environment fallback", async () => {
        settings.enabled = { codex: false, opencode: false };
        const prior = process.env.OPENCODE_QUOTA_GO_API_KEY;
        process.env.OPENCODE_QUOTA_GO_API_KEY = "env-secret-marker";
        vault.load.mockRejectedValue(makeVaultError("corrupt"));
        const dispose = await tui.setup(context());
        try {
            expect(opencode.usage).not.toHaveBeenCalled();
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
                .run();
            expect(opencode.usage).not.toHaveBeenCalled();
            expect(toast).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    variant: "error",
                    message: expect.stringContaining("need repair"),
                }),
            );
            expect(settings.enabled?.opencode).toBe(false);
            dialog.select.mockResolvedValueOnce("remove");
            dialog.confirm.mockResolvedValueOnce(true);
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            expect(vault.clear).toHaveBeenCalledOnce();
        } finally {
            if (prior === undefined) delete process.env.OPENCODE_QUOTA_GO_API_KEY;
            else process.env.OPENCODE_QUOTA_GO_API_KEY = prior;
            if (typeof dispose === "function") dispose();
        }
    });

    test("a vault read failure never blocks disabling OpenCode", async () => {
        settings.enabled = { codex: false, opencode: true };
        vault.load.mockRejectedValue(makeVaultError("unavailable"));
        const dispose = await tui.setup(context());
        try {
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
                .run();
            expect(settings.enabled?.opencode).toBe(false);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("missing native vault allows environment fetching but vault management explains limitation", async () => {
        settings.enabled = { codex: false, opencode: false };
        const prior = process.env.OPENCODE_QUOTA_GO_API_KEY;
        process.env.OPENCODE_QUOTA_GO_API_KEY = "env-secret-marker";
        vault.load.mockRejectedValue(makeVaultError("unavailable"));
        const dispose = await tui.setup(context());
        try {
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode.toggle")
                .run();
            await settle();
            expect(settings.enabled?.opencode).toBe(true);
            expect(opencode.usage).toHaveBeenCalled();
            expect(opencode.usage.mock.calls[0]).toHaveLength(1);
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            expect(dialog.select).not.toHaveBeenCalled();
            expect(toast).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    variant: "error",
                    message: expect.stringContaining("Windows Credential Manager is unavailable"),
                }),
            );
        } finally {
            if (prior === undefined) delete process.env.OPENCODE_QUOTA_GO_API_KEY;
            else process.env.OPENCODE_QUOTA_GO_API_KEY = prior;
            if (typeof dispose === "function") dispose();
        }
    });

    test("corrupt OpenCode credentials do not block independently enabled Codex", async () => {
        settings.enabled = { codex: true, opencode: true };
        vault.load.mockRejectedValue(makeVaultError("corrupt"));
        const dispose = await tui.setup(context());
        try {
            await settle();
            expect(codex.usage).toHaveBeenCalled();
            expect(opencode.usage).not.toHaveBeenCalled();
            expect(opencode.status).not.toHaveBeenCalled();
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("re-reads vault per poll and pairs follow-up with the same account", async () => {
        settings.enabled = { codex: false, opencode: true };
        vault.load.mockResolvedValue({ apiKey: "account-a", orgId: "org-a" } as never);
        let finishOldFollowUp!: (value: undefined) => void;
        opencode.status.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishOldFollowUp = resolve;
                }),
        );
        const dispose = await tui.setup(context());
        try {
            await settle();
            expect(opencode.usage.mock.calls[0][0]).toBe("account-a");
            expect(opencode.status.mock.calls[0].slice(0, 2)).toEqual(["account-a", "org-a"]);
            vault.load.mockResolvedValue({ apiKey: "account-b", orgId: "org-b" } as never);
            await vi.advanceTimersByTimeAsync(120_000);
            await settle();
            expect(opencode.usage.mock.calls[1][0]).toBe("account-b");
            expect(opencode.status.mock.calls[1].slice(0, 2)).toEqual(["account-b", "org-b"]);
            expect(opencode.status.mock.calls[0][2].aborted).toBe(true);
            finishOldFollowUp(undefined);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("disabling during a request prevents stale data and follow-up work", async () => {
        settings.enabled = { codex: true, opencode: false };
        let resolve!: (value: typeof codexWindowsPayload) => void;
        codex.usage.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const dispose = await tui.setup(context());
        try {
            await settle();
            const disable = commands().find(
                (entry: { id: string }) => entry.id === "quota-codex.toggle",
            ).run;
            await disable();
            resolve(codexWindowsPayload);
            await Promise.resolve();
            await Promise.resolve();
            expect(codex.activeUntil).not.toHaveBeenCalled();
            expect(codex.usage).toHaveBeenCalledTimes(1);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("a vault change during a refresh releases the poll lock instead of freezing the sidebar", async () => {
        settings.enabled = { codex: true, opencode: true };
        vault.load.mockResolvedValue({ apiKey: "account-a" } as never);
        // The in-flight fetch only settles once the invalidate aborts it, so the
        // refresh is still awaited when the generation moves underneath it.
        codex.usage.mockImplementationOnce(
            (signal: AbortSignal) =>
                new Promise((_done, reject) => {
                    signal.addEventListener("abort", () => reject(new Error("aborted")));
                }),
        );
        const dispose = await tui.setup(context());
        try {
            await settle();
            expect(codex.usage).toHaveBeenCalledTimes(1);
            vault.load.mockResolvedValue({ apiKey: "account-b" } as never);
            // A cancel still re-reads the vault, and the changed entry invalidates OpenCode.
            await commands()
                .find((entry: { id: string }) => entry.id === "quota-opencode-key.manage")
                .run();
            await settle();
            // Held the lock, every later poll short-circuited and the sidebar froze.
            await vi.advanceTimersByTimeAsync(120_000);
            await settle();
            expect(codex.usage).toHaveBeenCalledTimes(2);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });

    test("layout shows a concise setup hint and filters disabled provider data", () => {
        const now = Date.now();
        const rows = layoutRows(
            {
                providers: {
                    codex: { windows: codexWindows, fetchedAt: now, status: "" },
                    opencode: { windows: [], fetchedAt: now, status: "" },
                },
            },
            new Set(),
            now,
            { codex: false, opencode: false },
        );
        expect(rows.some((row) => row.text.includes("Choose a provider"))).toBe(true);
        expect(rows.some((row) => row.text.includes("Disabled · /quota-codex"))).toBe(true);
        expect(rows.some((row) => row.text.includes("70% left"))).toBe(false);
        const oneEnabled = layoutRows(
            { providers: { codex: { windows: codexWindows, fetchedAt: now, status: "" } } },
            new Set(),
            now,
            { codex: true, opencode: false },
        );
        expect(oneEnabled.some((row) => row.text.includes("Choose a provider"))).toBe(false);
        expect(oneEnabled.some((row) => row.text.includes("70% left"))).toBe(true);
        expect(oneEnabled.some((row) => row.text.includes("Disabled · /quota-opencode"))).toBe(
            true,
        );
    });

    test("enabling another provider while a request is pending refreshes both enabled providers", async () => {
        settings.enabled = { codex: true, opencode: false };
        vault.load.mockResolvedValue({ apiKey: "opaque", orgId: undefined } as never);
        let resolve!: (value: typeof codexWindowsPayload) => void;
        codex.usage.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const dispose = await tui.setup(context());
        try {
            const enableOpenCode = commands().find(
                (entry: { id: string }) => entry.id === "quota-opencode.toggle",
            ).run;
            await enableOpenCode();
            await settle();
            expect(opencode.usage).toHaveBeenCalledTimes(1);
            expect(codex.usage).toHaveBeenCalledTimes(2);
            expect(codex.usage.mock.calls[0][0].aborted).toBe(true);
            resolve(codexWindowsPayload);
            for (let index = 0; index < 5; index++) await Promise.resolve();
            expect(codex.activeUntil).toHaveBeenCalledTimes(1);
        } finally {
            if (typeof dispose === "function") dispose();
        }
    });
});
