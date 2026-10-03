import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildCodexHeaders,
    codexAuthPath,
    CodexProviderError,
    CodexRateLimitedError,
    codexStatusOf,
    fetchCodexActiveUntilWith,
    fetchCodexUsageWith,
    getCodexBackoff,
    parseCodexUsage,
    rateLimitPlan,
    readCodexAuthFile,
    resetCodexBackoff,
    retryAfterDelay,
    type CodexStatus,
    type FetchImpl,
    type RateLimitPlan,
} from "../src/codex";

// All tests are synthetic: no live network, no reads of the real
// ~/.codex/auth.json. fetchCodexUsage (the runtime entry point) is never
// called here because it reads the real credential file; the injectable
// fetchCodexUsageWith covers the HTTP paths with fake responses.

const REAL_NOW = Date.now();

// Module-level 429 backoff and system-time mocks are reset around every
// test so none of them can leak into the next.
beforeEach(() => {
    resetCodexBackoff();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

const setSystemTime = (date?: number): void => {
    vi.setSystemTime(date ?? REAL_NOW);
};

type WindowFixture = Record<string, unknown>;

const WINDOW_18000 = (extra: WindowFixture = {}): WindowFixture => ({
    limit: 100,
    used: 30,
    used_percent: 30,
    rate_limit_seconds: 18000,
    limit_window_seconds: 18000,
    reset_at: 1_700_000_000,
    ...extra,
});
const WINDOW_604800 = (extra: WindowFixture = {}): WindowFixture => ({
    limit: 500,
    used: 125,
    used_percent: 25,
    rate_limit_seconds: 604800,
    limit_window_seconds: 604800,
    reset_at: 1_700_604_800,
    ...extra,
});

const PAYLOAD = {
    rate_limit: {
        primary_window: WINDOW_18000(),
        secondary_window: WINDOW_604800(),
    },
};

// Fixtures shared by the fetch-backed suites.
const TOKEN = "tk_FAKE_TOKEN";
const ACCOUNT_ID = "user_FAKE_ACCOUNT";
const SIGNAL = new AbortController().signal;

interface FixtureResponse {
    status: number;
    ok: boolean;
    headers: { get: (name: string) => string | null };
    json: () => Promise<unknown>;
}

const respond = (
    status: number,
    body: unknown = null,
    headers: Record<string, string> = {},
): FixtureResponse => {
    // Real Headers are case-insensitive; mirror that here.
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
    (...responses: ReturnType<typeof respond>[]): FetchImpl =>
    async () => {
        const next = responses.shift();
        if (next === undefined) {
            throw new Error("unexpected extra fetch call (test bug)");
        }
        return next;
    };

const noWait = async (): Promise<void> => {};

/** Always answers 429 with the given Retry-After header, for backoff gate tests. */
const rateLimitedFetch =
    (retryAfter: string): FetchImpl =>
    async () =>
        respond(429, null, { "Retry-After": retryAfter });

/** Always answers 200 with the standard usage payload, for cooldown-clear tests. */
const usageOkFetch: FetchImpl = async () =>
    respond(200, PAYLOAD, { "content-type": "application/json" });

/** Always answers an impossible HTTP status, for the unmapped-status rejection path. */
const unusableStatusFetch: FetchImpl = async () => ({
    ...respond(200, null),
    status: 9999,
    ok: false,
});

/** Runs fn and returns the thrown error; fails when fn completes without throwing. */
function caughtError(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
    throw new Error("expected the call to throw");
}

/** Resolves to the rejection error of promise; fails when promise resolves instead. */
async function caughtRejection(promise: Promise<unknown>): Promise<Error> {
    return promise.then(
        () => {
            throw new Error("expected the promise to reject");
        },
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
}

describe("parseCodexUsage (synthetic JSON only, no network)", () => {
    test("parses primary (18000s) and secondary (604800s) windows as percent LEFT", () => {
        const windows = parseCodexUsage(PAYLOAD);
        // percent LEFT = 100 - used_percent
        expect(windows.fiveHour?.percentLeft).toBe(70);
        expect(windows.fiveHour?.resetsAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
        expect(windows.week?.percentLeft).toBe(75);
        expect(windows.week?.resetsAt).toBe(new Date(1_700_604_800 * 1000).toISOString());
    });

    test("normalizes a safe top-level plan type with or without windows", () => {
        expect(parseCodexUsage({ ...PAYLOAD, plan_type: "plus-2" })).toEqual({
            fiveHour: { percentLeft: 70, resetsAt: new Date(1_700_000_000 * 1000).toISOString() },
            week: { percentLeft: 75, resetsAt: new Date(1_700_604_800 * 1000).toISOString() },
            planType: "plus-2",
        });
        expect(parseCodexUsage({ rate_limit: {}, plan_type: "Pro" })).toEqual({ planType: "pro" });
        expect(parseCodexUsage({ plan_type: "Pro" })).toEqual({});
    });

    test("drops unsafe or malformed plan types without dropping valid windows", () => {
        for (const bad of [
            "",
            " ",
            " plus",
            "plus ",
            "plus tier",
            "plus\nsecret",
            "<script>",
            "é",
            "𝒫ro",
            "plus/premium",
            "a".repeat(33),
            null,
            123,
            ["plus"],
        ]) {
            const windows = parseCodexUsage({ ...PAYLOAD, plan_type: bad });
            expect(windows.planType).toBeUndefined();
            expect(windows.fiveHour?.percentLeft).toBe(70);
        }
        expect(parseCodexUsage({ ...PAYLOAD, plan_type: "A".repeat(32) }).planType).toBe(
            "a".repeat(32),
        );
    });

    test("identifies windows by limit_window_seconds, not by position (reversed)", () => {
        const reversed = {
            rate_limit: {
                // secondary listed first, and window roles swapped entirely
                secondary_window: WINDOW_18000({ used_percent: 12 }),
                primary_window: WINDOW_604800({ used_percent: 60 }),
            },
        };
        const windows = parseCodexUsage(reversed);
        expect(windows.fiveHour?.percentLeft).toBe(88);
        expect(windows.week?.percentLeft).toBe(40);
    });

    test("parses the per-model model_limits shape", () => {
        const payload = {
            rate_limit: {
                model_limits: [
                    {
                        model: "gpt-5",
                        primary_window: WINDOW_18000(),
                        secondary_window: WINDOW_604800(),
                    },
                    {
                        model: "gpt-5-mini",
                        primary_window: WINDOW_18000({ used_percent: 99 }),
                    },
                ],
            },
        };
        const windows = parseCodexUsage(payload);
        // first valid window per key wins, wherever it appears
        expect(windows.fiveHour?.percentLeft).toBe(70);
        expect(windows.week?.percentLeft).toBe(75);
    });

    test("clamps used_percent into 0..100 percent LEFT", () => {
        const windows = parseCodexUsage({
            rate_limit: {
                primary_window: WINDOW_18000({ used_percent: 150 }),
                secondary_window: WINDOW_604800({ used_percent: -20 }),
            },
        });
        expect(windows.fiveHour?.percentLeft).toBe(0);
        expect(windows.week?.percentLeft).toBe(100);
    });

    test("accepts numeric strings and fractional used_percent", () => {
        const windows = parseCodexUsage({
            rate_limit: {
                primary_window: WINDOW_18000({
                    used_percent: "12.5",
                    reset_at: "1700000000",
                }),
            },
        });
        expect(windows.fiveHour?.percentLeft).toBeCloseTo(87.5, 6);
        expect(windows.fiveHour?.resetsAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
    });

    test("absent window stays unavailable; extra fields are ignored", () => {
        const windows = parseCodexUsage({ rate_limit: {} });
        expect(windows).toEqual({});
        const windows2 = parseCodexUsage({
            rate_limit: { primary_window: WINDOW_18000(), terciary_window: WINDOW_604800() },
        });
        expect(windows2.fiveHour?.percentLeft).toBe(70);
        expect(windows2.week).toBeUndefined();
    });

    test("absent reset_at leaves reset unavailable", () => {
        const windows = parseCodexUsage({
            rate_limit: {
                primary_window: { ...WINDOW_18000(), reset_at: undefined },
            },
        });
        expect(windows.fiveHour?.percentLeft).toBe(70);
        expect(windows.fiveHour?.resetsAt).toBeUndefined();
    });

    test("present-but-invalid reset_at rejects the window", () => {
        for (const bad of ["not-a-date", -5, null, 8.64e12 * 1000, "12x"]) {
            const windows = parseCodexUsage({
                rate_limit: { primary_window: WINDOW_18000({ reset_at: bad }) },
            });
            expect(windows.fiveHour).toBeUndefined();
        }
        // ...and doesn't poison the other window
        const windows = parseCodexUsage({
            rate_limit: {
                primary_window: WINDOW_18000({ reset_at: "nope" }),
                secondary_window: WINDOW_604800(),
            },
        });
        expect(windows.fiveHour).toBeUndefined();
        expect(windows.week?.percentLeft).toBe(75);
    });

    test("unsupported window lengths are skipped gracefully", () => {
        const windows = parseCodexUsage({
            rate_limit: {
                primary_window: { ...WINDOW_18000(), limit_window_seconds: 3600 },
                secondary_window: WINDOW_604800(),
            },
        });
        expect(windows.fiveHour).toBeUndefined();
        expect(windows.week?.percentLeft).toBe(75);
    });

    test("missing/malformed used_percent or limit_window_seconds drops the window", () => {
        const base = { rate_limit: { primary_window: WINDOW_18000() } };
        for (const used of [undefined, null, "abc", NaN, Infinity, -Infinity]) {
            const windows = parseCodexUsage({
                rate_limit: {
                    primary_window: { ...WINDOW_18000(), used_percent: used },
                },
            });
            expect(windows.fiveHour).toBeUndefined();
        }
        for (const seconds of [undefined, null, "abc", 18001, 18000.5]) {
            const windows = parseCodexUsage({
                rate_limit: {
                    primary_window: { ...WINDOW_18000(), limit_window_seconds: seconds },
                },
            });
            expect(windows.fiveHour).toBeUndefined();
        }
        expect(parseCodexUsage(base).fiveHour?.percentLeft).toBe(70);
    });

    test("rejects non-object payloads and unknown roots gracefully", () => {
        for (const payload of [null, "nope", [1, 2], 42, {}, { rate_limit: "x" }]) {
            expect(parseCodexUsage(payload)).toEqual({});
        }
        expect(parseCodexUsage({ unused: true })).toEqual({});
    });

    test("never throws on adversarial input", () => {
        for (const payload of [
            { rate_limit: { primary_window: "junk" } },
            { rate_limit: { model_limits: "junk" } },
            { rate_limit: { model_limits: [null, 5, { primary_window: null }] } },
            { rate_limit: { primary_window: { used_percent: true } } },
        ]) {
            expect(() => parseCodexUsage(payload)).not.toThrow();
        }
    });
});

describe("buildCodexHeaders (pure, safe header input)", () => {
    test("builds bearer, account id and accept headers", () => {
        expect(buildCodexHeaders("tk_abc123", "user_abc123")).toEqual({
            Authorization: "Bearer tk_abc123",
            "ChatGPT-Account-Id": "user_abc123",
            accept: "application/json",
        });
    });

    test("rejects control characters that could inject headers", () => {
        const badTokens = [
            "tk\nX-Injected: 1",
            "tk\r\nX-Injected: 1",
            "tk\x00",
            "tk\tinside",
            "tk\x7f",
        ];
        for (const token of badTokens) {
            expect(() => buildCodexHeaders(token as string, "user_abc")).toThrow(
                "Codex access token invalid",
            );
        }
        for (const id of ["a\nb", "a\r\nX: 1", "a\x00b", "a\x1f"]) {
            expect(() => buildCodexHeaders("tk_abc", id)).toThrow("Codex account id invalid");
        }
    });

    test("rejects empty or whitespace-only credentials", () => {
        expect(() => buildCodexHeaders("", "user_abc")).toThrow("Codex access token missing");
        expect(() => buildCodexHeaders("tk_abc", "  ")).toThrow("Codex account id missing");
    });

    test("rejects surrounding whitespace and non-ASCII bytes in headers", () => {
        expect(() => buildCodexHeaders(" tk_abc", "user_abc")).toThrow(
            "Codex access token invalid",
        );
        expect(() => buildCodexHeaders("tk_abc ", "user_abc")).toThrow(
            "Codex access token invalid",
        );
        expect(() => buildCodexHeaders("tk_abc", " user_abc")).toThrow("Codex account id invalid");
        expect(() => buildCodexHeaders("tk_abc", "user_abc\t")).toThrow("Codex account id invalid");
        // non-ASCII bytes (accented chars, C1 controls 0x80-0xFF)
        expect(() => buildCodexHeaders("tk_\u00e9", "user_abc")).toThrow(
            "Codex access token invalid",
        );
        expect(() => buildCodexHeaders("tk_abc", "user_\u00e9")).toThrow(
            "Codex account id invalid",
        );
        expect(() => buildCodexHeaders("tk_\u0080", "user_abc")).toThrow(
            "Codex access token invalid",
        );
        // and trims are never silently applied to a direct header build
        expect(() => buildCodexHeaders(" tk_abc ", "user_abc")).toThrow(
            "Codex access token invalid",
        );
    });

    test("errors never leak the credential values", () => {
        const secret = "SECRET_TOKEN_XYZ";
        const error = caughtError(() => buildCodexHeaders(`${secret}\r\nX: 1`, "user_abc"));
        expect(error).toBeInstanceOf(CodexProviderError);
        expect(error.message).not.toContain(secret);
    });
});

describe("Retry-After parsing (429 helper)", () => {
    test("parses decimal seconds and cap-bounded plan", () => {
        expect(retryAfterDelay("30")).toBe(30);
        expect(retryAfterDelay("0")).toBe(0);
        expect(retryAfterDelay(null)).toBeUndefined();
        expect(retryAfterDelay("  ")).toBeUndefined();
        expect(retryAfterDelay("abc")).toBeUndefined();
        expect(retryAfterDelay("30s")).toBeUndefined();

        expect(rateLimitPlan("30")).toEqual({ retry: true, retryAfterMs: 30_000 });
        expect(rateLimitPlan("0")).toEqual({ retry: false, retryAfterMs: undefined });
        expect(rateLimitPlan("abc")).toEqual({ retry: false, retryAfterMs: undefined });
        expect(rateLimitPlan(null)).toEqual({ retry: false, retryAfterMs: undefined });
        // integer delay-seconds only (1*DIGIT): fractional is malformed
        expect(retryAfterDelay("12.5")).toBeUndefined();
        expect(rateLimitPlan("12.5")).toEqual({
            retry: false,
            retryAfterMs: undefined,
        });
        // nor do ISO dates or date-like garbage fall through to lenient parsing
        expect(retryAfterDelay("2026-09-27")).toBeUndefined();
        expect(retryAfterDelay("Sep 27 2026")).toBeUndefined();
        // beyond the auto-retry cap: give up but keep the delay for the caller
        expect(rateLimitPlan("500")).toEqual({
            retry: false,
            retryAfterMs: 500_000,
        });
        const plan: RateLimitPlan = rateLimitPlan("500", 60);
        expect(plan.retry).toBe(false);
    });

    test("parses RFC 7231 HTTP-date retry-after", () => {
        const now = Date.parse("2026-09-27T04:30:00.000Z");
        expect(retryAfterDelay("Sun, 27 Sep 2026 04:35:00 GMT", now)).toBe(300);
        expect(retryAfterDelay("Sun, 27 Sep 2026 04:20:00 GMT", now)).toBe(-600);
        expect(rateLimitPlan("Sun, 27 Sep 2026 04:35:00 GMT", 600, now)).toEqual({
            retry: true,
            retryAfterMs: 300_000,
        });
        expect(rateLimitPlan("Sun, 27 Sep 2026 04:20:00 GMT", 120, now).retry).toBe(false);
    });
});

describe("module-level 429 backoff persists across calls", () => {
    // The sidebar polls every 2 minutes; this suite verifies a Retry-After
    // seen by one call gates later calls until it elapses.
    const NOW = Date.parse("2026-09-27T04:30:00.000Z");

    test("a server Retry-After blocks later calls until it elapses, then recovers", async () => {
        setSystemTime(NOW);
        let calls = 0;
        const fake429: FetchImpl = async () => {
            calls += 1;
            return respond(429, null, { "Retry-After": "600" });
        };
        const first = fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake429, noWait);
        await expect(first).rejects.toBeInstanceOf(CodexRateLimitedError);
        await expect(first).rejects.toMatchObject({ retryAfterMs: 600_000 });
        expect(calls).toBe(1);
        expect(getCodexBackoff()).toEqual({
            nextAllowedAt: NOW + 600_000,
            remainingMs: 600_000,
        });

        // next poll still inside cooldown: no request is sent at all
        const blocked = fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake429, noWait);
        await expect(blocked).rejects.toBeInstanceOf(CodexRateLimitedError);
        await expect(blocked).rejects.toMatchObject({ retryAfterMs: 600_000 });
        expect(calls).toBe(1);

        // after the delay elapses the endpoint is hit again; success clears the gate
        setSystemTime(NOW + 600_001);
        const windows = await fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, usageOkFetch, noWait);
        expect(windows.fiveHour?.percentLeft).toBe(70);
        expect(getCodexBackoff().remainingMs).toBe(0);
    });

    test("absent Retry-After applies a default cooldown", async () => {
        setSystemTime(NOW);
        let calls = 0;
        const fake: FetchImpl = async () => {
            calls += 1;
            return respond(429);
        };
        const rejected = fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake, noWait);
        await expect(rejected).rejects.toBeInstanceOf(CodexRateLimitedError);
        await expect(rejected).rejects.toMatchObject({ retryAfterMs: undefined });
        expect(calls).toBe(1);
        expect(getCodexBackoff()).toEqual({
            nextAllowedAt: NOW + 60_000,
            remainingMs: 60_000,
        });
        // still cooling down: blocked without a second request
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake, noWait),
        ).rejects.toBeInstanceOf(CodexRateLimitedError);
        expect(calls).toBe(1);
    });

    test("a retried 429 records its own Retry-After and never retries twice", async () => {
        setSystemTime(NOW);
        let calls = 0;
        const fake: FetchImpl = async () => {
            calls += 1;
            return calls === 1
                ? respond(429, null, { "Retry-After": "30" })
                : respond(429, null, { "Retry-After": "120" });
        };
        const retried = fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake, noWait);
        await expect(retried).rejects.toBeInstanceOf(CodexRateLimitedError);
        // the SECOND Retry-After wins: no second retry is attempted
        await expect(retried).rejects.toMatchObject({
            status: "rate-limited",
            retryAfterMs: 120_000,
        });
        // exactly one in-call retry, then give up
        expect(calls).toBe(2);
        // the second Retry-After is what persists in the module gate
        expect(getCodexBackoff()).toEqual({
            nextAllowedAt: NOW + 120_000,
            remainingMs: 120_000,
        });
    });

    test("a successful response clears the persisted backoff", async () => {
        setSystemTime(NOW);
        let calls = 0;
        const fake: FetchImpl = async () => {
            calls += 1;
            return calls === 1
                ? respond(429, null, { "Retry-After": "30" })
                : respond(200, PAYLOAD, { "content-type": "application/json" });
        };
        const windows = await fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake, noWait);
        expect(windows.week?.percentLeft).toBe(75);
        expect(calls).toBe(2);
        expect(getCodexBackoff().remainingMs).toBe(0);
    });

    test("stored backoff is capped at one hour", async () => {
        setSystemTime(NOW);
        const capped = fetchCodexUsageWith(
            TOKEN,
            ACCOUNT_ID,
            SIGNAL,
            rateLimitedFetch("999999"),
            noWait,
        );
        // the error reports the server's full delay...
        await expect(capped).rejects.toMatchObject({ retryAfterMs: 999_999_000 });
        // ...but the persisted gate is capped so it can't pin the panel
        expect(getCodexBackoff()).toEqual({
            nextAllowedAt: NOW + 3_600_000,
            remainingMs: 3_600_000,
        });
    });
});

describe("status categories (safe display: missing login vs rate limit)", () => {
    test("codexStatusOf classifies credential, auth, rate-limit and generic failures", async () => {
        // missing-login: empty token rejected at header build
        expect(codexStatusOf(caughtError(() => buildCodexHeaders("", "user_abc")))).toBe(
            "missing-login",
        );

        // auth: HTTP 401 from the endpoint
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, queuedFetch(respond(401, {})), noWait),
        ).rejects.toMatchObject({ status: "auth" });

        // rate-limited: a received 429, and a later call blocked by the
        // persisted backoff (the single queued response also proves the
        // blocked call sent no request)
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, queuedFetch(respond(429, {})), noWait),
        ).rejects.toMatchObject({ status: "rate-limited" });
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, queuedFetch(respond(429, {})), noWait),
        ).rejects.toMatchObject({ status: "rate-limited" });

        // unavailable: generic 5xx and anything else (unknown throws,
        // primitives) never bubble up as a specific category
        resetCodexBackoff(); // clear the backoff recorded by the 429 steps above
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, queuedFetch(respond(500)), noWait),
        ).rejects.toMatchObject({ status: "unavailable" });
        expect(codexStatusOf(new Error("x"))).toBe("unavailable");
        expect(codexStatusOf(undefined)).toBe("unavailable");
        expect(codexStatusOf("boom")).toBe("unavailable");
    });

    test("provider errors carry their status; rate-limit errors are subclasses", () => {
        const rate = new CodexRateLimitedError(60_000);
        expect(rate).toBeInstanceOf(CodexProviderError);
        expect(rate.status).toBe("rate-limited");
        expect(codexStatusOf(rate)).toBe("rate-limited");

        const auth = new CodexProviderError("auth", "safe message");
        expect(auth.status).toBe("auth");
        expect(codexStatusOf(auth)).toBe("auth");

        const status: CodexStatus = auth.status;
        expect(status).toBe("auth");
    });
});

describe("fetchCodexUsageWith (fake fetch only, no network)", () => {
    test("parses a successful response", async () => {
        const windows = await fetchCodexUsageWith(
            TOKEN,
            ACCOUNT_ID,
            SIGNAL,
            queuedFetch(respond(200, PAYLOAD, { "content-type": "application/json" })),
            noWait,
        );
        expect(windows.fiveHour?.percentLeft).toBe(70);
        expect(windows.week?.percentLeft).toBe(75);
    });

    test("returns plan type from the same usage request", async () => {
        let calls = 0;
        const fake: FetchImpl = async () => {
            calls++;
            return respond(
                200,
                { ...PAYLOAD, plan_type: "PLUS" },
                { "content-type": "application/json" },
            );
        };
        const windows = await fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake, noWait);
        expect(windows.planType).toBe("plus");
        expect(windows.fiveHour?.percentLeft).toBe(70);
        expect(calls).toBe(1);
    });

    test("401 surfaces a safe error (no token, no body)", async () => {
        const error = await caughtRejection(
            fetchCodexUsageWith(
                TOKEN,
                ACCOUNT_ID,
                SIGNAL,
                queuedFetch(respond(401, { error: "invalid_token" })),
                noWait,
            ),
        );
        expect(error.message).toContain("401");
        expect(error.message).not.toContain(TOKEN);
        expect(error.message).not.toContain(ACCOUNT_ID);
        expect(error.message).not.toContain("invalid_token");
    });

    test("authentication redirect (3xx) is a manual-redirect error", async () => {
        await expect(
            fetchCodexUsageWith(
                TOKEN,
                ACCOUNT_ID,
                SIGNAL,
                queuedFetch(respond(302, "login page")),
                noWait,
            ),
        ).rejects.toThrow("redirect");
    });

    test("non-OK statuses are safe HTTP errors", async () => {
        await expect(
            fetchCodexUsageWith(
                TOKEN,
                ACCOUNT_ID,
                SIGNAL,
                queuedFetch(respond(500, "<html>oops</html>")),
                noWait,
            ),
        ).rejects.toThrow("500");
    });

    test("non-JSON content type and invalid JSON are safe errors", async () => {
        for (const [headers, body] of [
            [{ "content-type": "text/html" }, "<html>login</html>"],
            [{ "content-type": "application/json" }, "{not json"],
        ] as Array<[Record<string, string>, unknown]>) {
            const error = await caughtRejection(
                fetchCodexUsageWith(
                    TOKEN,
                    ACCOUNT_ID,
                    SIGNAL,
                    queuedFetch(respond(200, body, headers)),
                    noWait,
                ),
            );
            expect(error.message).not.toContain(TOKEN);
            expect(error.message).not.toContain("login");
        }
    });

    test("200 with no usable windows reports missing usage", async () => {
        await expect(
            fetchCodexUsageWith(
                TOKEN,
                ACCOUNT_ID,
                SIGNAL,
                queuedFetch(
                    respond(
                        200,
                        { rate_limit: {}, plan_type: "PLUS" },
                        { "content-type": "application/json" },
                    ),
                ),
                noWait,
            ),
        ).rejects.toThrow("Codex usage data missing");
    });

    test("429 without a retryable Retry-After throws CodexRateLimitedError once", async () => {
        const error = await caughtRejection(
            fetchCodexUsageWith(
                TOKEN,
                ACCOUNT_ID,
                SIGNAL,
                queuedFetch(respond(429, { detail: "leaky_body_marker" })),
                noWait,
            ),
        );
        expect(error).toBeInstanceOf(CodexRateLimitedError);
        expect((error as CodexRateLimitedError).retryAfterMs).toBeUndefined();
        expect(error.message).toContain("429");
        expect(error.message).not.toContain("leaky_body_marker");
    });

    test("429 with an out-of-cap Retry-After reports the delay without retrying", async () => {
        const rejected = fetchCodexUsageWith(
            TOKEN,
            ACCOUNT_ID,
            SIGNAL,
            queuedFetch(respond(429, null, { "Retry-After": "500" })),
            noWait,
        );
        await expect(rejected).rejects.toBeInstanceOf(CodexRateLimitedError);
        await expect(rejected).rejects.toMatchObject({ retryAfterMs: 500_000 });
    });

    test("429 with a bounded Retry-After backs off once, then succeeds", async () => {
        let calls = 0;
        const fake: FetchImpl = async () => {
            calls += 1;
            return calls === 1
                ? respond(429, null, { "Retry-After": "30" })
                : respond(200, PAYLOAD, { "content-type": "application/json" });
        };
        const waited: number[] = [];
        const wait = async (ms: number) => {
            waited.push(ms);
        };
        const windows = await fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake, wait);
        expect(calls).toBe(2);
        expect(waited).toEqual([30_000]);
        expect(windows.fiveHour?.percentLeft).toBe(70);
    });

    test("an aborted signal during 429 backoff fails fast", async () => {
        const controller = new AbortController();
        const fake: FetchImpl = rateLimitedFetch("30");
        const wait = async (_ms: number, _sig: AbortSignal) => {
            controller.abort();
            // the real sleep throws AbortError when the signal fires
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            throw error;
        };
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, controller.signal, fake, wait),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    test("rejects header-injecting credentials before any fetch", async () => {
        let called = false;
        const fake: FetchImpl = async () => {
            called = true;
            return respond(200, PAYLOAD, { "content-type": "application/json" });
        };
        await expect(
            fetchCodexUsageWith(`${TOKEN}\r\nX-Injected: 1`, ACCOUNT_ID, SIGNAL, fake, noWait),
        ).rejects.toThrow("invalid");
        expect(called).toBe(false);
    });
});

describe("fetchCodexActiveUntilWith (fake fetch only, no network)", () => {
    const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

    test("uses encoded account id, existing headers, manual redirect and bounded signal", async () => {
        const accountId = "user+fake&other=1";
        const fake: FetchImpl = async (url, init) => {
            expect(url).toBe(
                "https://chatgpt.com/backend-api/subscriptions?account_id=user%2Bfake%26other%3D1",
            );
            expect(init.method).toBe("GET");
            expect(init.headers).toEqual(buildCodexHeaders(TOKEN, accountId));
            expect(init.redirect).toBe("manual");
            expect(init.signal).toBeInstanceOf(AbortSignal);
            expect(init.signal).not.toBe(SIGNAL);
            return respond(200, { active_until: "2026-10-30T12:34:56.000Z" }, jsonHeaders);
        };
        expect(await fetchCodexActiveUntilWith(TOKEN, accountId, SIGNAL, fake)).toBe(
            "2026-10-30T12:34:56.000Z",
        );
    });

    test("absent or invalid expiry and non-object payloads fall back", async () => {
        for (const payload of [
            {},
            null,
            [],
            "2026-10-30T12:34:56Z",
            { active_until: null },
            { active_until: 123 },
            { active_until: "yesterday" },
            { active_until: "2026-02-30T12:34:56Z" },
            { active_until: "2026-10-30" },
            { active_until: "2026-10-30T25:34:56Z" },
        ]) {
            expect(
                await fetchCodexActiveUntilWith(
                    TOKEN,
                    ACCOUNT_ID,
                    SIGNAL,
                    queuedFetch(respond(200, payload, jsonHeaders)),
                ),
            ).toBeUndefined();
        }
        expect(
            await fetchCodexActiveUntilWith(
                TOKEN,
                ACCOUNT_ID,
                SIGNAL,
                queuedFetch(
                    respond(200, { active_until: "2026-10-30T12:34:56+02:00" }, jsonHeaders),
                ),
            ),
        ).toBe("2026-10-30T12:34:56+02:00");
    });

    test("non-OK, redirects, non-JSON, bad JSON and network errors fall back safely", async () => {
        for (const response of [
            respond(401, { secret: TOKEN }, jsonHeaders),
            respond(429, null, jsonHeaders),
            respond(500, null, jsonHeaders),
            respond(302, "login", { location: "https://example.com" }),
            respond(200, "login", { "content-type": "text/html" }),
            respond(200, {}, {}),
        ]) {
            expect(
                await fetchCodexActiveUntilWith(TOKEN, ACCOUNT_ID, SIGNAL, queuedFetch(response)),
            ).toBeUndefined();
        }
        const badJson: FetchImpl = async () => ({
            ...respond(200, null, jsonHeaders),
            json: async () => {
                throw new Error(`raw body ${TOKEN} ${ACCOUNT_ID}`);
            },
        });
        expect(await fetchCodexActiveUntilWith(TOKEN, ACCOUNT_ID, SIGNAL, badJson)).toBeUndefined();
        const networkError: FetchImpl = async () => {
            throw new Error(TOKEN);
        };
        expect(
            await fetchCodexActiveUntilWith(TOKEN, ACCOUNT_ID, SIGNAL, networkError),
        ).toBeUndefined();
    });

    test("caller abort propagates without exposing credentials", async () => {
        const controller = new AbortController();
        const fake: FetchImpl = async () => {
            controller.abort();
            throw new Error(TOKEN);
        };
        const error = await caughtRejection(
            fetchCodexActiveUntilWith(TOKEN, ACCOUNT_ID, controller.signal, fake),
        );
        expect(error.name).toBe("AbortError");
        expect(error.message).not.toContain(TOKEN);
    });
});

describe("auth.json credential handling (synthetic temp files only)", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
    });
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("resolves $CODEX_HOME/auth.json and the ~/.codex default", () => {
        expect(codexAuthPath(dir, undefined)).toBe(join(dir, ".codex", "auth.json"));
        expect(codexAuthPath(dir, join(dir, "custom"))).toBe(join(dir, "custom", "auth.json"));
        // whitespace-only CODEX_HOME falls back to the default
        expect(codexAuthPath(dir, "   ")).toBe(join(dir, ".codex", "auth.json"));
    });

    test("rejects control characters in CODEX_HOME", () => {
        expect(() => codexAuthPath("C:\\Users\\me", "bad\u0000home")).toThrow(
            "Codex config invalid",
        );
        expect(() => codexAuthPath("C:\\Users\\me", "bad\r\nhome")).toThrow("Codex config invalid");
    });

    test("rejects relative CODEX_HOME", () => {
        expect(() => codexAuthPath(dir, "relative/path")).toThrow("must be absolute");
    });

    const writeAuth = (content: string): string => {
        const path = join(dir, `auth-${Math.random().toString(36).slice(2)}.json`);
        writeFileSync(path, content, "utf8");
        return path;
    };

    test("reads and validates a synthetic auth.json", () => {
        const path = writeAuth(
            JSON.stringify({
                tokens: {
                    access_token: "tk_synthetic",
                    account_id: "user_synthetic",
                    refresh_token: "ignored-on-purpose",
                },
            }),
        );
        const credentials = readCodexAuthFile(path);
        expect(credentials).toEqual({
            accessToken: "tk_synthetic",
            accountId: "user_synthetic",
        });
    });

    test("trims surrounding whitespace from token and account id", () => {
        const path = writeAuth(
            JSON.stringify({
                tokens: {
                    access_token: "  tk_padded  \n",
                    account_id: "\tuser_padded\n",
                    refresh_token: "ignored-on-purpose",
                },
            }),
        );
        const credentials = readCodexAuthFile(path);
        expect(credentials).toEqual({
            accessToken: "tk_padded",
            accountId: "user_padded",
        });
        // the trimmed values build headers without any padding
        expect(buildCodexHeaders(credentials.accessToken, credentials.accountId)).toEqual({
            Authorization: "Bearer tk_padded",
            "ChatGPT-Account-Id": "user_padded",
            accept: "application/json",
        });
    });

    test("missing file, invalid JSON and missing tokens are safe errors", () => {
        expect(() => readCodexAuthFile(join(dir, "does-not-exist.json"))).toThrow(
            "Codex auth file missing or unreadable",
        );
        expect(() => readCodexAuthFile(writeAuth("{not json"))).toThrow(
            "Codex auth file invalid JSON",
        );
        expect(() => readCodexAuthFile(writeAuth(JSON.stringify({ tokens: {} })))).toThrow(
            "missing access_token",
        );
        expect(() =>
            readCodexAuthFile(writeAuth(JSON.stringify({ tokens: { access_token: "tk" } }))),
        ).toThrow("missing account_id");
        expect(() => readCodexAuthFile(writeAuth(JSON.stringify({})))).toThrow(
            "Codex auth file missing tokens",
        );
    });

    test("caps auth file reads without exposing its contents", () => {
        const secret = "secret-marker";
        const path = writeAuth(secret + "x".repeat(1024 * 1024));
        const error = caughtError(() => readCodexAuthFile(path));
        expect(codexStatusOf(error)).toBe("missing-login");
        expect(error.message).not.toContain(secret);
    });
});

describe("security boundaries", () => {
    test("cross-origin redirect is never followed and never leaks its Location", async () => {
        let calls = 0;
        const fake: FetchImpl = async (url, init) => {
            calls++;
            expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
            expect(init.redirect).toBe("manual");
            return respond(302, null, { location: `https://evil.invalid/${TOKEN}` });
        };
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake, noWait),
        ).rejects.toMatchObject({
            status: "auth",
            message: "Codex usage endpoint authentication redirect",
        });
        expect(calls).toBe(1);
    });

    test("network failures and malformed server statuses never expose raw errors", async () => {
        const bad: FetchImpl = async () => {
            throw new Error(`secret ${TOKEN}`);
        };
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, bad, noWait),
        ).rejects.toMatchObject({
            status: "unavailable",
            message: "Codex usage endpoint unavailable",
        });
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, unusableStatusFetch, noWait),
        ).rejects.toMatchObject({ status: "unavailable", message: "Codex usage endpoint HTTP 0" });
    });

    test("caps streamed HTTP JSON bodies and rejects advertised oversized responses", async () => {
        const headers = { "content-type": "application/json" };
        const oversized = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024 + 1));
                controller.close();
            },
        });
        const fake: FetchImpl = async () => ({ ...respond(200, null, headers), body: oversized });
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, fake, noWait),
        ).rejects.toMatchObject({
            status: "unavailable",
            message: "Codex usage endpoint returned invalid JSON",
        });
        const advertised: FetchImpl = async () =>
            respond(200, PAYLOAD, {
                ...headers,
                "content-length": String(1024 * 1024 + 1),
            });
        await expect(
            fetchCodexUsageWith(TOKEN, ACCOUNT_ID, SIGNAL, advertised, noWait),
        ).rejects.toMatchObject({ status: "unavailable" });
    });
});
