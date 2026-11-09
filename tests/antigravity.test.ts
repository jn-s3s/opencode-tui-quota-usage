import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    antigravityAuthPath,
    antigravityCliDir,
    AntigravityProviderError,
    AntigravityRateLimitedError,
    antigravityStatusOf,
    buildAntigravityHeaders,
    exchangeAntigravityRefreshToken,
    fetchAntigravityStatusWith,
    fetchAntigravityUsage,
    fetchAntigravityUsageWith,
    fromRemainingFraction,
    getAntigravityBackoff,
    opencodeAntigravityAccountsPath,
    parseAntigravityCredentials,
    parseAntigravityStatus,
    parseAntigravityUsage,
    parseOpenCodeAntigravityAccounts,
    readActiveAntigravityAccountKey,
    readAntigravityAuth,
    readAntigravityAuthFile,
    readAntigravityProjectId,
    resetAntigravityBackoff,
    resetAntigravityTokenCache,
    type FetchImpl,
    type KeyringReader,
} from "../src/antigravity";
import { safeAntigravityError } from "../src/providers";

// All tests are synthetic: no live network, no reads of the real OS keyring
// or ~/.gemini/antigravity-cli files.

const REAL_NOW = Date.now();
const TOKEN = "ya29.FAKE_TOKEN";
const PROJECT_ID = "aicode-consumers-fake";
const SIGNAL = new AbortController().signal;

beforeEach(() => {
    resetAntigravityBackoff();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const setSystemTime = (date?: number): void => {
    vi.setSystemTime(date ?? REAL_NOW);
};

const PRO_PAYLOAD = {
    groups: [
        {
            displayName: "Gemini Models",
            description: "Models within this group: Gemini Flash, Gemini Pro",
            buckets: [
                {
                    bucketId: "gemini-weekly",
                    displayName: "Weekly Limit Remaining",
                    window: "weekly",
                    remainingFraction: 0.9113,
                    resetTime: "2026-11-16T06:52:00Z",
                },
                {
                    bucketId: "gemini-5h",
                    displayName: "Five Hour Limit Remaining",
                    window: "5h",
                    remainingFraction: 0.9874,
                    resetTime: "2026-11-09T16:52:00Z",
                },
            ],
        },
        {
            displayName: "Claude and GPT models",
            description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
            buckets: [
                {
                    bucketId: "3p-weekly",
                    displayName: "Weekly Limit Remaining",
                    window: "weekly",
                    remainingFraction: 0.4411,
                    resetTime: "2026-11-16T10:03:00Z",
                },
                {
                    bucketId: "3p-5h",
                    displayName: "Five Hour Limit Remaining",
                    window: "5h",
                    remainingFraction: 0,
                    resetTime: "2026-11-09T15:03:00Z",
                },
            ],
        },
        {
            displayName: "Gemini 4 Argon",
            description:
                "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
            buckets: [
                {
                    bucketId: "gemini-argon-wtu-weekly",
                    displayName: "Gemini 4 Argon Weekly Limit",
                    window: "weekly",
                    remainingFraction: 0.7217,
                    resetTime: "2026-11-16T09:53:00Z",
                },
            ],
        },
    ],
};

interface FixtureResponse {
    status: number;
    ok: boolean;
    headers: { get: (name: string) => string | null };
    body?: ReadableStream<Uint8Array> | null;
    json: () => Promise<unknown>;
}

const respond = (
    status: number,
    body: unknown = null,
    headers: Record<string, string> = {},
): FixtureResponse => {
    const lower: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        lower[name.toLowerCase()] = value;
    }
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: {
            get: (name: string) => lower[name.toLowerCase()] ?? null,
        },
        json: async () => body,
    };
};

const queuedFetch =
    (...responses: FixtureResponse[]): FetchImpl =>
    async () => {
        const next = responses.shift();
        if (next === undefined) {
            throw new Error("unexpected extra fetch call (test bug)");
        }
        return next;
    };

const noWait = async (): Promise<void> => {};

function caughtError(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
    throw new Error("expected the call to throw");
}

async function caughtRejection(promise: Promise<unknown>): Promise<Error> {
    return promise.then(
        () => {
            throw new Error("expected the promise to reject");
        },
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
}

describe("parseAntigravityUsage (synthetic JSON only, no network)", () => {
    test("parses paid Pro groups (Gemini, Claude/GPT, Argon) in 5h-then-Weekly order", () => {
        expect(parseAntigravityUsage(PRO_PAYLOAD)).toEqual([
            {
                label: "Gemini 5h",
                usage: { percentLeft: 98.74, resetsAt: "2026-11-09T16:52:00.000Z" },
            },
            {
                label: "Gemini Weekly",
                usage: { percentLeft: 91.13, resetsAt: "2026-11-16T06:52:00.000Z" },
            },
            {
                label: "Claude/GPT 5h",
                usage: { percentLeft: 0, resetsAt: "2026-11-09T15:03:00.000Z" },
            },
            {
                label: "Claude/GPT Weekly",
                usage: { percentLeft: 44.11, resetsAt: "2026-11-16T10:03:00.000Z" },
            },
            {
                label: "Argon Weekly",
                usage: { percentLeft: 72.17, resetsAt: "2026-11-16T09:53:00.000Z" },
            },
        ]);
    });

    test("handles Free / Plus weekly-only responses and Ultra shared-pool responses", () => {
        const freeTier = {
            groups: [
                {
                    displayName: "Gemini Models",
                    buckets: [
                        {
                            bucketId: "gemini-weekly",
                            window: "weekly",
                            remainingFraction: 1,
                        },
                    ],
                },
                {
                    displayName: "Claude and GPT models",
                    buckets: [
                        {
                            bucketId: "3p-weekly",
                            window: "weekly",
                            remainingFraction: 0.5,
                        },
                    ],
                },
            ],
        };
        expect(parseAntigravityUsage(freeTier)).toEqual([
            { label: "Gemini Weekly", usage: { percentLeft: 100 } },
            { label: "Claude/GPT Weekly", usage: { percentLeft: 50 } },
        ]);

        // Ultra / Pro Trial: disabled Argon bucket is skipped rather than rendered as 0%.
        const ultraOrTrial = {
            response: {
                groups: [
                    PRO_PAYLOAD.groups[0],
                    PRO_PAYLOAD.groups[1],
                    {
                        displayName: "Gemini 4 Argon",
                        buckets: [
                            {
                                bucketId: "gemini-argon-wtu-weekly",
                                window: "weekly",
                                remainingFraction: 0,
                                disabled: true,
                            },
                        ],
                    },
                ],
            },
        };
        expect(parseAntigravityUsage(ultraOrTrial).map((w) => w.label)).toEqual([
            "Gemini 5h",
            "Gemini Weekly",
            "Claude/GPT 5h",
            "Claude/GPT Weekly",
        ]);
    });

    test("classifies by group displayName + window when bucketId is non-canonical, keeping Argon separate from Gemini", () => {
        const nonCanonical = {
            groups: [
                {
                    displayName: "Gemini 4 Argon",
                    buckets: [{ window: "weekly", remainingFraction: 0.25 }],
                },
                {
                    displayName: "Gemini Models",
                    buckets: [
                        { window: "FIVE_HOUR", remainingFraction: "0.8" },
                        { window: "weekly", remainingFraction: 0.9 },
                    ],
                },
                {
                    displayName: "Claude and GPT models",
                    buckets: [{ bucketId: "custom-3p-5h", remainingFraction: 0.4 }],
                },
            ],
        };
        expect(parseAntigravityUsage(nonCanonical)).toEqual([
            { label: "Gemini 5h", usage: { percentLeft: 80 } },
            { label: "Gemini Weekly", usage: { percentLeft: 90 } },
            { label: "Claude/GPT 5h", usage: { percentLeft: 40 } },
            { label: "Argon Weekly", usage: { percentLeft: 25 } },
        ]);
    });

    test("clamps remainingFraction into 0..100 and drops malformed buckets gracefully", () => {
        expect(fromRemainingFraction(1.5)).toEqual({ percentLeft: 100 });
        expect(fromRemainingFraction(-0.2)).toEqual({ percentLeft: 0 });
        expect(
            parseAntigravityUsage({
                groups: [
                    {
                        displayName: "Gemini Models",
                        buckets: [
                            { bucketId: "gemini-5h", remainingFraction: "not-a-number" },
                            {
                                bucketId: "gemini-weekly",
                                remainingFraction: 0.5,
                                resetTime: "invalid-date",
                            },
                        ],
                    },
                ],
            }),
        ).toEqual([{ label: "Gemini Weekly", usage: { percentLeft: 50 } }]);

        for (const bad of [null, undefined, "nope", 42, [], {}, { groups: "x" }]) {
            expect(parseAntigravityUsage(bad)).toEqual([]);
        }
    });
});

describe("parseAntigravityStatus (loadCodeAssist tier and project)", () => {
    test("prefers paidTier over consumer currentTier (free-tier) and extracts companion project", () => {
        expect(
            parseAntigravityStatus({
                cloudaicompanionProject: "aicode-consumers",
                currentTier: { id: "free-tier", name: "Antigravity" },
                paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
            }),
        ).toEqual({ plan: "Pro", projectId: "aicode-consumers" });

        expect(
            parseAntigravityStatus({
                response: {
                    cloudaicompanionProject: { id: "proj-ultra-1" },
                    currentTier: { id: "free-tier", name: "Antigravity" },
                    paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
                },
            }),
        ).toEqual({ plan: "Ultra", projectId: "proj-ultra-1" });

        expect(
            parseAntigravityStatus({
                paidTier: { id: "g1-ultra-lite-tier", name: "Google AI Ultra Lite" },
            }),
        ).toEqual({ plan: "Ultra Lite" });

        expect(
            parseAntigravityStatus({
                paidTier: { id: "g1-plus-tier", name: "Google AI Plus" },
            }),
        ).toEqual({ plan: "Plus" });
    });

    test("resolves Free from currentTier.id without treating generic 'Antigravity' name as a plan", () => {
        expect(
            parseAntigravityStatus({
                currentTier: { id: "free-tier", name: "Antigravity" },
            }),
        ).toEqual({ plan: "Free" });

        expect(
            parseAntigravityStatus({
                currentTier: { name: "Antigravity" },
            }),
        ).toBeUndefined();
    });

    test("rejects unsafe project IDs", () => {
        for (const bad of ["", "  ", "bad project", "bad\nproj", "../etc", "a".repeat(129)]) {
            expect(readAntigravityProjectId(bad)).toBeUndefined();
        }
        expect(readAntigravityProjectId("valid-project_1.0:us")).toBe("valid-project_1.0:us");
    });
});

describe("Antigravity CLI credential parsing and reading (synthetic only)", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "agy-auth-test-"));
    });
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("parses bare JSON, nested token object, NUL-padded Windows blobs and go-keyring-base64 envelopes", () => {
        const bare = JSON.stringify({
            access_token: "ya29.bare",
            refresh_token: "1//ignored",
            project_id: "proj-1",
        });
        expect(parseAntigravityCredentials(bare)).toEqual({
            accessToken: "ya29.bare",
            projectId: "proj-1",
        });

        const nested = JSON.stringify({
            auth_method: "oauth",
            token: { access_token: "ya29.nested", refresh_token: "1//ignored" },
        });
        const wrapped = `  go-keyring-base64:${Buffer.from(nested, "utf8").toString("base64")}\n`;
        expect(parseAntigravityCredentials(wrapped)).toEqual({
            accessToken: "ya29.nested",
        });

        const nulPadded = `\u0000${JSON.stringify({ token: { accessToken: "ya29.win" } })}\u0000`;
        expect(parseAntigravityCredentials(nulPadded)).toEqual({
            accessToken: "ya29.win",
        });
    });

    test("rejects invalid base64, invalid JSON and missing/unsafe access_token without leaking secrets", () => {
        const secret = "SECRET_MARKER_XYZ";
        for (const raw of [
            "",
            "   ",
            `go-keyring-base64:!!not-base64-${secret}!!`,
            `{not json ${secret}`,
            JSON.stringify({ refresh_token: secret }),
            JSON.stringify({ access_token: `${secret} with spaces` }),
            JSON.stringify({ access_token: `${secret}\r\nX-Injected: 1` }),
        ]) {
            const error = caughtError(() => parseAntigravityCredentials(raw));
            expect(antigravityStatusOf(error)).toBe("missing-login");
            expect(error.message).not.toContain(secret);
        }
    });

    test("validates ANTIGRAVITY_CLI_HOME and reads token file + settings.json project", () => {
        expect(antigravityAuthPath(dir, undefined)).toBe(
            join(dir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
        );
        expect(() => antigravityCliDir(dir, "relative/path")).toThrow("must be absolute");
        expect(() => antigravityCliDir(dir, "bad\u0000path")).toThrow("invalid");

        const cliDir = join(dir, "cli-profile");
        mkdirSync(cliDir, { recursive: true });
        const tokenPath = join(cliDir, "antigravity-oauth-token");
        writeFileSync(
            tokenPath,
            JSON.stringify({ token: { access_token: "ya29.file_token" } }),
            "utf8",
        );
        writeFileSync(
            join(cliDir, "settings.json"),
            JSON.stringify({ gcp: { project: "settings-project-id" } }),
            "utf8",
        );

        expect(readAntigravityAuthFile(tokenPath, cliDir)).toEqual({
            accessToken: "ya29.file_token",
            projectId: "settings-project-id",
        });
    });

    test("prefers OS keyring (including Windows gemini:antigravity target) and falls back to CLI file", async () => {
        const cliDir = join(dir, ".gemini", "antigravity-cli");
        mkdirSync(cliDir, { recursive: true });
        writeFileSync(
            join(cliDir, "antigravity-oauth-token"),
            JSON.stringify({ token: { access_token: "ya29.fallback_file" } }),
            "utf8",
        );

        const winKeyring: KeyringReader = {
            getPassword: vi.fn(async () => null),
            findPassword: vi.fn(async (target: string) =>
                target === "gemini:antigravity"
                    ? JSON.stringify({ token: { access_token: "ya29.win_target" } })
                    : null,
            ),
        };
        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "win32" });
        try {
            const creds = await readAntigravityAuth(dir, undefined, async () => winKeyring);
            expect(creds.accessToken).toBe("ya29.win_target");
            expect(winKeyring.getPassword).toHaveBeenCalledWith("gemini", "antigravity");
            expect(winKeyring.findPassword).toHaveBeenCalledWith("gemini:antigravity");
        } finally {
            Object.defineProperty(process, "platform", { value: originalPlatform });
        }

        // Empty keyring falls back to ~/.gemini/antigravity-cli/antigravity-oauth-token
        const emptyKeyring: KeyringReader = {
            getPassword: async () => null,
            findPassword: async () => null,
        };
        const fallback = await readAntigravityAuth(dir, undefined, async () => emptyKeyring);
        expect(fallback.accessToken).toBe("ya29.fallback_file");

        // Corrupt non-empty keyring entry fails closed instead of silently falling back to disk
        const corruptKeyring: KeyringReader = {
            getPassword: async () => "{corrupt-json",
            findPassword: async () => null,
        };
        const corruptErr = await caughtRejection(
            readAntigravityAuth(dir, undefined, async () => corruptKeyring),
        );
        expect(antigravityStatusOf(corruptErr)).toBe("missing-login");
    });
});

describe("OpenCode antigravity-accounts.json parsing, token exchange, caching and fallback", () => {
    const jsonHeaders = { "content-type": "application/json" };
    let baseDir: string;

    beforeAll(() => {
        baseDir = mkdtempSync(join(tmpdir(), "opencode-agy-accounts-"));
    });
    afterAll(() => {
        rmSync(baseDir, { recursive: true, force: true });
    });

    test("resolves opencodeAntigravityAccountsPath with env overrides and Windows legacy fallback", () => {
        const home = join(baseDir, "path-home");
        mkdirSync(home, { recursive: true });
        const customOpenCode = join(baseDir, "custom-opencode");
        const customXdg = join(baseDir, "custom-xdg");
        const customAppData = join(baseDir, "custom-appdata");

        expect(opencodeAntigravityAccountsPath(home, customOpenCode, customXdg)).toBe(
            join(customOpenCode, "antigravity-accounts.json"),
        );
        expect(opencodeAntigravityAccountsPath(home, undefined, customXdg)).toBe(
            join(customXdg, "opencode", "antigravity-accounts.json"),
        );
        expect(opencodeAntigravityAccountsPath(home, undefined, undefined)).toBe(
            join(home, ".config", "opencode", "antigravity-accounts.json"),
        );

        expect(() => opencodeAntigravityAccountsPath(home, "relative/dir")).toThrow(
            "must be absolute",
        );
        expect(() => opencodeAntigravityAccountsPath(home, undefined, "bad\u0000xdg")).toThrow(
            "invalid",
        );

        // Windows legacy %APPDATA%/opencode/antigravity-accounts.json when ~/.config/opencode is absent
        const legacyDir = join(customAppData, "opencode");
        mkdirSync(legacyDir, { recursive: true });
        const legacyFile = join(legacyDir, "antigravity-accounts.json");
        writeFileSync(
            legacyFile,
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                accounts: [{ refreshToken: "1//legacy_refresh" }],
            }),
            "utf8",
        );

        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "win32" });
        try {
            expect(opencodeAntigravityAccountsPath(home, undefined, undefined, customAppData)).toBe(
                legacyFile,
            );

            // Once ~/.config/opencode/antigravity-accounts.json exists, it takes precedence over legacy AppData
            const primaryDir = join(home, ".config", "opencode");
            mkdirSync(primaryDir, { recursive: true });
            const primaryFile = join(primaryDir, "antigravity-accounts.json");
            writeFileSync(
                primaryFile,
                JSON.stringify({
                    version: 4,
                    activeIndex: 0,
                    accounts: [{ refreshToken: "1//primary_refresh" }],
                }),
                "utf8",
            );
            expect(opencodeAntigravityAccountsPath(home, undefined, undefined, customAppData)).toBe(
                primaryFile,
            );
        } finally {
            Object.defineProperty(process, "platform", { value: originalPlatform });
        }
    });

    test("parses v1-v4 schemas, activeIndex, activeIndexByFamily, disabled accounts and packed refreshToken", () => {
        for (const version of [1, 2, 3, 4] as const) {
            const parsed = parseOpenCodeAntigravityAccounts(
                JSON.stringify({
                    version,
                    activeIndex: 0,
                    accounts: [{ refreshToken: `1//refresh_v${version}`, projectId: "proj-v" }],
                }),
            );
            expect(parsed.refreshToken).toBe(`1//refresh_v${version}`);
            expect(parsed.projectId).toBe("proj-v");
            expect(parsed.accountKey).toMatch(/^[0-9a-f]{16}$/);
        }

        // Disabled activeIndex falls back to activeIndexByFamily.gemini, then .claude, then first enabled
        const familyFallback = parseOpenCodeAntigravityAccounts(
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                activeIndexByFamily: { gemini: 2, claude: 1 },
                accounts: [
                    { refreshToken: "1//disabled_0", enabled: false },
                    { refreshToken: "1//claude_1", enabled: true },
                    { refreshToken: "1//gemini_2", enabled: true, projectId: "proj-gem" },
                ],
            }),
        );
        expect(familyFallback.refreshToken).toBe("1//gemini_2");
        expect(familyFallback.projectId).toBe("proj-gem");

        const claudeFallback = parseOpenCodeAntigravityAccounts(
            JSON.stringify({
                version: 3,
                activeIndex: 99,
                activeIndexByFamily: { gemini: 0, claude: 1 },
                accounts: [
                    { refreshToken: "1//disabled_0", enabled: false },
                    { refreshToken: "1//claude_1", enabled: true },
                ],
            }),
        );
        expect(claudeFallback.refreshToken).toBe("1//claude_1");

        const firstEnabledFallback = parseOpenCodeAntigravityAccounts(
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                accounts: [
                    { refreshToken: "1//disabled_0", enabled: false },
                    { refreshToken: "1//enabled_1" },
                ],
            }),
        );
        expect(firstEnabledFallback.refreshToken).toBe("1//enabled_1");

        // Packed refreshToken|projectId|managedProjectId with managedProjectId precedence
        const packedWithEmbedded = parseOpenCodeAntigravityAccounts(
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                accounts: [{ refreshToken: "1//packed_tok|emb-proj|emb-managed" }],
            }),
        );
        expect(packedWithEmbedded.refreshToken).toBe("1//packed_tok");
        expect(packedWithEmbedded.projectId).toBe("emb-managed");

        const packedEmbeddedProjectOnly = parseOpenCodeAntigravityAccounts(
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                accounts: [{ refreshToken: "1//packed_tok|emb-proj" }],
            }),
        );
        expect(packedEmbeddedProjectOnly.projectId).toBe("emb-proj");

        const explicitFieldPrecedence = parseOpenCodeAntigravityAccounts(
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                accounts: [
                    {
                        refreshToken: "1//packed_tok|emb-proj|emb-managed",
                        projectId: "field-proj",
                        managedProjectId: "field-managed",
                    },
                ],
            }),
        );
        expect(explicitFieldPrecedence.projectId).toBe("field-managed");

        // Matches active /connect Google credential hint (by email, accountId, or refreshToken) even when activeIndex lags
        const multiPool = JSON.stringify({
            version: 4,
            activeIndex: 0,
            accounts: [
                {
                    id: "id-alpha",
                    email: "alpha@example.com",
                    refreshToken: "1//refresh_alpha",
                    projectId: "proj-alpha",
                },
                {
                    id: "id-beta",
                    email: "beta@example.com",
                    refreshToken: "1//refresh_beta",
                    projectId: "proj-beta",
                },
            ],
        });
        expect(
            parseOpenCodeAntigravityAccounts(multiPool, { email: "BETA@example.com" }),
        ).toMatchObject({
            refreshToken: "1//refresh_beta",
            projectId: "proj-beta",
        });
        expect(parseOpenCodeAntigravityAccounts(multiPool, { accountId: "id-beta" })).toMatchObject(
            {
                refreshToken: "1//refresh_beta",
                projectId: "proj-beta",
            },
        );
        expect(
            parseOpenCodeAntigravityAccounts(multiPool, { refreshToken: "1//refresh_beta" }),
        ).toMatchObject({
            refreshToken: "1//refresh_beta",
            projectId: "proj-beta",
        });

        // Rejects unsupported version, empty accounts, all disabled, or unsafe refreshToken without leaking secrets
        const secret = "1//SUPER_SECRET_REFRESH_TOKEN";
        for (const bad of [
            "",
            "{bad",
            JSON.stringify({ version: 5, activeIndex: 0, accounts: [{ refreshToken: secret }] }),
            JSON.stringify({ version: 4, activeIndex: 0, accounts: [] }),
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                accounts: [{ refreshToken: secret, enabled: false }],
            }),
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                accounts: [{ refreshToken: `${secret} with spaces` }],
            }),
        ]) {
            const err = caughtError(() => parseOpenCodeAntigravityAccounts(bad));
            expect(antigravityStatusOf(err)).toBe("missing-login");
            expect(err.message).not.toContain(secret);
        }
    });

    test("caches exchanged access_token per accountKey and immediately switches when activeIndex changes", async () => {
        const home = join(baseDir, "switch-home");
        const configDir = join(home, ".config", "opencode");
        mkdirSync(configDir, { recursive: true });
        const accountsFile = join(configDir, "antigravity-accounts.json");

        const writeAccounts = (activeIndex: number) => {
            writeFileSync(
                accountsFile,
                JSON.stringify({
                    version: 4,
                    activeIndex,
                    accounts: [
                        { refreshToken: "1//refresh_acct_0", projectId: "proj-acct-0" },
                        { refreshToken: "1//refresh_acct_1", managedProjectId: "proj-acct-1" },
                    ],
                }),
                "utf8",
            );
        };

        writeAccounts(0);
        const key0 = readActiveAntigravityAccountKey(home, undefined, undefined);
        expect(key0).toMatch(/^[0-9a-f]{16}$/);

        const tokenCalls: string[] = [];
        const quotaCalls: Array<{ auth: string; body: string }> = [];
        const fakeFetch: FetchImpl = async (url, init) => {
            if (url === "https://oauth2.googleapis.com/token") {
                tokenCalls.push(init.body);
                const params = new URLSearchParams(init.body);
                const rt = params.get("refresh_token");
                return respond(
                    200,
                    {
                        access_token:
                            rt === "1//refresh_acct_0" ? "ya29.acct0_tok" : "ya29.acct1_tok",
                        expires_in: 3600,
                    },
                    jsonHeaders,
                );
            }
            quotaCalls.push({ auth: init.headers.Authorization, body: init.body });
            return respond(200, PRO_PAYLOAD, jsonHeaders);
        };

        setSystemTime(REAL_NOW);
        // Poll 1 (Account 0): exchanges refreshToken once and queries quota with proj-acct-0
        await fetchAntigravityUsage(SIGNAL, { homeDir: home, fetchImpl: fakeFetch, wait: noWait });
        expect(tokenCalls).toHaveLength(1);
        expect(quotaCalls).toHaveLength(1);
        expect(quotaCalls[0]).toEqual({
            auth: "Bearer ya29.acct0_tok",
            body: JSON.stringify({ project: "proj-acct-0" }),
        });

        // Poll 2 (same Account 0, 2 minutes later): reuses cached accessToken without calling token endpoint
        setSystemTime(REAL_NOW + 2 * 60_000);
        await fetchAntigravityUsage(SIGNAL, { homeDir: home, fetchImpl: fakeFetch, wait: noWait });
        expect(tokenCalls).toHaveLength(1);
        expect(quotaCalls).toHaveLength(2);
        expect(quotaCalls[1].auth).toBe("Bearer ya29.acct0_tok");

        // Switch activeIndex from 0 -> 1 in antigravity-accounts.json
        writeAccounts(1);
        const key1 = readActiveAntigravityAccountKey(home, undefined, undefined);
        expect(key1).toMatch(/^[0-9a-f]{16}$/);
        expect(key1).not.toBe(key0);

        // Poll 3 (Account 1): immediately bypasses Account 0 cache, exchanges Account 1 refreshToken and uses proj-acct-1
        await fetchAntigravityUsage(SIGNAL, { homeDir: home, fetchImpl: fakeFetch, wait: noWait });
        expect(tokenCalls).toHaveLength(2);
        expect(quotaCalls).toHaveLength(3);
        expect(quotaCalls[2]).toEqual({
            auth: "Bearer ya29.acct1_tok",
            body: JSON.stringify({ project: "proj-acct-1" }),
        });
    });

    test("refreshes expired cached token or reactive 401 once, and surfaces auth on 400 invalid_grant without secret leakage", async () => {
        const home = join(baseDir, "refresh-home");
        const configDir = join(home, ".config", "opencode");
        mkdirSync(configDir, { recursive: true });
        const secretRefresh = "1//SECRET_REFRESH_MARKER";
        writeFileSync(
            join(configDir, "antigravity-accounts.json"),
            JSON.stringify({
                version: 4,
                activeIndex: 0,
                accounts: [{ refreshToken: secretRefresh, projectId: "proj-r" }],
            }),
            "utf8",
        );

        let tokenMintCount = 0;
        let failFirstCachedQuotaWith401 = false;
        const fakeFetch: FetchImpl = async (url, init) => {
            if (url === "https://oauth2.googleapis.com/token") {
                tokenMintCount++;
                return respond(
                    200,
                    { access_token: `ya29.minted_${tokenMintCount}`, expires_in: 3600 },
                    jsonHeaders,
                );
            }
            if (
                failFirstCachedQuotaWith401 &&
                init.headers.Authorization === "Bearer ya29.minted_1"
            ) {
                failFirstCachedQuotaWith401 = false;
                return respond(401, { error: "token revoked early" }, jsonHeaders);
            }
            return respond(200, PRO_PAYLOAD, jsonHeaders);
        };

        setSystemTime(REAL_NOW);
        await fetchAntigravityUsage(SIGNAL, { homeDir: home, fetchImpl: fakeFetch, wait: noWait });
        expect(tokenMintCount).toBe(1);

        // Reactive 401 on a cached token triggers exactly one refresh + retry
        failFirstCachedQuotaWith401 = true;
        const retried = await fetchAntigravityUsage(SIGNAL, {
            homeDir: home,
            fetchImpl: fakeFetch,
            wait: noWait,
        });
        expect(tokenMintCount).toBe(2);
        expect(retried.windows.length).toBeGreaterThan(0);

        // Advancing time into the 5-minute pre-expiry buffer triggers a fresh token exchange
        setSystemTime(REAL_NOW + 56 * 60_000);
        await fetchAntigravityUsage(SIGNAL, { homeDir: home, fetchImpl: fakeFetch, wait: noWait });
        expect(tokenMintCount).toBe(3);

        // 400 invalid_grant from token endpoint surfaces auth ("Antigravity sign-in expired") with no secret leakage
        resetAntigravityTokenCache();
        const invalidGrantErr = await caughtRejection(
            exchangeAntigravityRefreshToken(
                secretRefresh,
                SIGNAL,
                queuedFetch(
                    respond(
                        400,
                        { error: "invalid_grant", error_description: `bad token ${secretRefresh}` },
                        jsonHeaders,
                    ),
                ),
            ),
        );
        expect(antigravityStatusOf(invalidGrantErr)).toBe("auth");
        expect(safeAntigravityError(invalidGrantErr)).toBe("Antigravity sign-in expired");
        expect(invalidGrantErr.message).not.toContain(secretRefresh);

        // 429 or 500 from token endpoint surfaces unavailable
        for (const status of [429, 500, 503]) {
            const unavailErr = await caughtRejection(
                exchangeAntigravityRefreshToken(
                    secretRefresh,
                    SIGNAL,
                    queuedFetch(respond(status, { error: "overload" }, jsonHeaders)),
                ),
            );
            expect(antigravityStatusOf(unavailErr)).toBe("unavailable");
            expect(unavailErr.message).not.toContain(secretRefresh);
        }
    });

    test("falls back to agy CLI when antigravity-accounts.json is absent, but fails closed when corrupt", async () => {
        const home = join(baseDir, "boundary-home");
        const cliDir = join(home, ".gemini", "antigravity-cli");
        mkdirSync(cliDir, { recursive: true });
        writeFileSync(
            join(cliDir, "antigravity-oauth-token"),
            JSON.stringify({
                token: {
                    access_token: "ya29.expired_agy",
                    refresh_token: "1//agy_refresh",
                    expiry: new Date(REAL_NOW - 60_000).toISOString(),
                },
            }),
            "utf8",
        );

        const emptyKeyring: KeyringReader = {
            getPassword: async () => null,
            findPassword: async () => null,
        };

        setSystemTime(REAL_NOW);
        // 1. Missing antigravity-accounts.json falls back to agy CLI and refreshes expired agy token in memory
        const fallbackCreds = await readAntigravityAuth(
            home,
            undefined,
            async () => emptyKeyring,
            queuedFetch(
                respond(200, { access_token: "ya29.refreshed_agy", expires_in: 3600 }, jsonHeaders),
            ),
            SIGNAL,
        );
        expect(fallbackCreds.accessToken).toBe("ya29.refreshed_agy");

        // 2. Corrupt antigravity-accounts.json fails closed with missing-login and NEVER falls back to agy CLI
        const configDir = join(home, ".config", "opencode");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "antigravity-accounts.json"),
            "{corrupt-accounts-json",
            "utf8",
        );
        expect(readActiveAntigravityAccountKey(home, undefined, undefined)).toBeUndefined();

        const corruptErr = await caughtRejection(
            readAntigravityAuth(home, undefined, async () => emptyKeyring),
        );
        expect(antigravityStatusOf(corruptErr)).toBe("missing-login");
        expect(safeAntigravityError(corruptErr)).toBe("Sign in with Antigravity CLI");
    });
});

describe("fetchAntigravityUsageWith and fetchAntigravityStatusWith (fake fetch only)", () => {
    const jsonHeaders = { "content-type": "application/json" };

    test("sends CLI User-Agent, parses quota windows and discovers companion project on 403 when needed", async () => {
        const calls: Array<{ url: string; body: string; ua: string }> = [];
        const fake: FetchImpl = async (url, init) => {
            calls.push({ url, body: init.body, ua: init.headers["User-Agent"] });
            if (url.endsWith(":retrieveUserQuotaSummary") && init.body === "{}") {
                return respond(403, { error: { message: "missing project" } }, jsonHeaders);
            }
            if (url.endsWith(":loadCodeAssist")) {
                return respond(
                    200,
                    {
                        cloudaicompanionProject: PROJECT_ID,
                        paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
                    },
                    jsonHeaders,
                );
            }
            return respond(200, PRO_PAYLOAD, jsonHeaders);
        };

        const result = await fetchAntigravityUsageWith(TOKEN, SIGNAL, fake, noWait);
        expect(result.plan).toBe("Pro");
        expect(result.projectId).toBe(PROJECT_ID);
        expect(result.windows.map((w) => w.label)).toEqual([
            "Gemini 5h",
            "Gemini Weekly",
            "Claude/GPT 5h",
            "Claude/GPT Weekly",
            "Argon Weekly",
        ]);
        expect(calls).toHaveLength(3);
        expect(calls[0].ua).toBe("antigravity/cli/1.4.7");
        expect(JSON.parse(calls[2].body)).toEqual({ project: PROJECT_ID });
    });

    test("distinguishes 401 (auth), 403 SUBSCRIPTION_REQUIRED (no-subscription) and 429 (rate-limited)", async () => {
        const authErr = await caughtRejection(
            fetchAntigravityUsageWith(
                TOKEN,
                SIGNAL,
                queuedFetch(respond(401, { error: "expired" }, jsonHeaders)),
                noWait,
                PROJECT_ID,
            ),
        );
        expect(antigravityStatusOf(authErr)).toBe("auth");
        expect(safeAntigravityError(authErr)).toBe("Antigravity sign-in expired");

        const noSubErr = await caughtRejection(
            fetchAntigravityUsageWith(
                TOKEN,
                SIGNAL,
                queuedFetch(
                    respond(
                        403,
                        {
                            error: {
                                code: 403,
                                details: [{ reason: "SUBSCRIPTION_REQUIRED" }],
                            },
                        },
                        jsonHeaders,
                    ),
                ),
                noWait,
                PROJECT_ID,
            ),
        );
        expect(antigravityStatusOf(noSubErr)).toBe("no-subscription");
        expect(safeAntigravityError(noSubErr)).toBe("No Antigravity quota entitlement");

        setSystemTime(REAL_NOW);
        const rateErr = await caughtRejection(
            fetchAntigravityUsageWith(
                TOKEN,
                SIGNAL,
                queuedFetch(respond(429, null, { "Retry-After": "300" })),
                noWait,
                PROJECT_ID,
            ),
        );
        expect(rateErr).toBeInstanceOf(AntigravityRateLimitedError);
        expect(antigravityStatusOf(rateErr)).toBe("rate-limited");
        expect(safeAntigravityError(rateErr)).toBe("Rate limited · retry later");
        expect(getAntigravityBackoff().remainingMs).toBe(300_000);

        resetAntigravityBackoff();
        setSystemTime(REAL_NOW);
        const discoveryRateErr = await caughtRejection(
            fetchAntigravityUsageWith(
                TOKEN,
                SIGNAL,
                queuedFetch(
                    respond(403, { error: { message: "missing project" } }, jsonHeaders),
                    respond(
                        200,
                        {
                            cloudaicompanionProject: PROJECT_ID,
                            paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
                        },
                        jsonHeaders,
                    ),
                    respond(429, null, { "Retry-After": "180" }),
                ),
                noWait,
            ),
        );
        expect(discoveryRateErr).toBeInstanceOf(AntigravityRateLimitedError);
        expect(antigravityStatusOf(discoveryRateErr)).toBe("rate-limited");
        expect(getAntigravityBackoff().remainingMs).toBe(180_000);
    });

    test("buildAntigravityHeaders rejects empty, padded or control-char tokens", () => {
        for (const bad of ["", "  ", ` ${TOKEN}`, `${TOKEN}\n`, "ya29 bad", "ya29.é"]) {
            expect(() => buildAntigravityHeaders(bad)).toThrow(AntigravityProviderError);
        }
    });

    test("fetchAntigravityStatusWith returns undefined on non-200 or malformed JSON without throwing", async () => {
        for (const response of [
            respond(401, {}, jsonHeaders),
            respond(500, {}, jsonHeaders),
            respond(200, "not-json", { "content-type": "text/html" }),
        ]) {
            expect(
                await fetchAntigravityStatusWith(TOKEN, SIGNAL, queuedFetch(response)),
            ).toBeUndefined();
        }
    });
});
