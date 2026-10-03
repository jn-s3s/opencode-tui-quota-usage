import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildOpenCodeHeaders,
    fetchOpenCodeUsage,
    fetchOpenCodeUsageFromEnv,
    fetchOpenCodeUsageWith,
    fetchOpenCodeGoStatusWith,
    parseOpenCodeGoStatus,
    readOpenCodeGoOrgId,
    OpenCodeProviderError,
    openCodeStatusOf,
    parseOpenCodeUsage,
    readOpenCodeGoKey,
    type FetchImpl,
    type OpenCodeStatus,
} from "../src/opencode";
import { PROVIDERS, safeOpenCodeError } from "../src/providers";

// All tests use synthetic environment values and fake fetches; no live network
// or credential file reads. The runtime entry point uses the same validated path.

const KEY = "sk_FAKE_KEY";
const ORG = "org_FAKE_123";
const SIGNAL = new AbortController().signal;

const window = (percent: unknown, extra: Record<string, unknown> = {}) => ({
    status: "ok",
    percent,
    resetsAt: "2026-08-16T20:00:00Z",
    ...extra,
});

const USAGE = {
    usage: {
        rolling: window(12.3),
        weekly: window(45.6),
        monthly: window(78.9),
    },
};

const respond = (
    status: number,
    body: unknown = null,
    headers: Record<string, string> = {},
): Response => {
    return new Response(JSON.stringify(body), { status, headers });
};

const usageOkFetch: FetchImpl = async () =>
    respond(200, USAGE, { "content-type": "application/json" });

/** Runs fn and returns the thrown error; fails when fn completes without throwing. */
function caughtError(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
    throw new Error("expected the call to throw");
}

describe("parseOpenCodeUsage (synthetic JSON only, no network)", () => {
    test("parses rolling, weekly and monthly as percent LEFT in display order", () => {
        expect(parseOpenCodeUsage(USAGE)).toEqual([
            { label: "5h", usage: { percentLeft: 87.7, resetsAt: "2026-08-16T20:00:00.000Z" } },
            {
                label: "Weekly",
                usage: { percentLeft: 54.4, resetsAt: "2026-08-16T20:00:00.000Z" },
            },
            {
                label: "Monthly",
                usage: { percentLeft: 21.1, resetsAt: "2026-08-16T20:00:00.000Z" },
            },
        ]);
    });

    test("keeps valid windows when others are malformed or unknown", () => {
        expect(
            parseOpenCodeUsage({
                usage: {
                    rolling: window(0),
                    weekly: window("not a number"),
                    monthly: window(100),
                    yearly: window(50),
                },
            }).map((entry) => entry.label),
        ).toEqual(["5h", "Monthly"]);
    });

    test("treats an absent or invalid reset as 'reset unavailable', not a dropped window", () => {
        expect(
            parseOpenCodeUsage({
                usage: {
                    rolling: { status: "ok", percent: 40 },
                    weekly: window(10, { resetsAt: "tomorrow" }),
                },
            }),
        ).toEqual([
            { label: "5h", usage: { percentLeft: 60 } },
            { label: "Weekly", usage: { percentLeft: 90 } },
        ]);
    });

    test("returns nothing for malformed envelopes and error responses", () => {
        for (const payload of [
            undefined,
            null,
            "text",
            [],
            {},
            { usage: null },
            { usage: {} },
            { error: { type: "AuthError" } },
            { usage: { rolling: null } },
        ]) {
            expect(parseOpenCodeUsage(payload)).toEqual([]);
        }
    });
});
describe("readOpenCodeGoKey (pure, environment value only)", () => {
    test("accepts a bounded visible-ASCII key", () => {
        expect(readOpenCodeGoKey(KEY)).toBe(KEY);
        expect(readOpenCodeGoKey("a".repeat(512))).toHaveLength(512);
    });

    test("rejects unset, padded, oversized and unsafe keys without echoing them", () => {
        for (const bad of [
            undefined,
            "",
            "  ",
            ` ${KEY}`,
            `${KEY}\n`,
            `${KEY}\u0000`,
            "kéy",
            "a".repeat(513),
        ]) {
            const error = caughtError(() => readOpenCodeGoKey(bad));
            expect(openCodeStatusOf(error)).toBe("missing-login");
            expect(error.message).not.toContain(KEY);
        }
    });
});

describe("fetchOpenCodeUsageFromEnv (synthetic values, no credential file reads)", () => {
    test("missing and invalid environment keys make no request and have actionable status", async () => {
        let calls = 0;
        const fake: FetchImpl = async () => {
            calls++;
            return respond(200, USAGE, { "content-type": "application/json" });
        };
        for (const value of [undefined, "", `${KEY}\n`, "a".repeat(513)]) {
            const error = await fetchOpenCodeUsageFromEnv(value, SIGNAL, fake).catch(
                (thrown: unknown) => thrown,
            );
            expect(openCodeStatusOf(error)).toBe("missing-login");
            expect(safeOpenCodeError(error)).toBe("Set OPENCODE_QUOTA_GO_API_KEY");
        }
        expect(calls).toBe(0);
    });

    test("valid environment key sends bearer auth only to the fixed HTTPS endpoint", async () => {
        const windows = await fetchOpenCodeUsageFromEnv(KEY, SIGNAL, async (url, init) => {
            expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
            expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
            expect(init.redirect).toBe("manual");
            expect(init.method).toBe("GET");
            return respond(200, USAGE, { "content-type": "application/json" });
        });
        expect(windows).toHaveLength(3);
    });

    test("runtime does not fall back to a populated legacy auth.json", async () => {
        const dataHome = mkdtempSync(join(tmpdir(), "go-quota-env-test-"));
        const authDir = join(dataHome, "opencode");
        mkdirSync(authDir);
        writeFileSync(join(authDir, "auth.json"), JSON.stringify({ "opencode-go": { key: KEY } }));
        const fake = vi.fn(async () => respond(200, USAGE, { "content-type": "application/json" }));
        vi.stubEnv("XDG_DATA_HOME", dataHome);
        vi.stubEnv("OPENCODE_QUOTA_GO_API_KEY", "");
        vi.stubGlobal("fetch", fake);
        try {
            const error = await fetchOpenCodeUsage(SIGNAL).catch((thrown: unknown) => thrown);
            expect(openCodeStatusOf(error)).toBe("missing-login");
            expect(fake).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
            rmSync(dataHome, { recursive: true, force: true });
        }
    });
});

describe("buildOpenCodeHeaders", () => {
    test("sends the key as Bearer auth and accepts application/json", () => {
        expect(buildOpenCodeHeaders(KEY)).toEqual({
            Authorization: `Bearer ${KEY}`,
            accept: "application/json",
        });
    });

    test("rejects empty, padded, oversized and non-ASCII keys", () => {
        for (const bad of ["", "  ", ` ${KEY}`, `${KEY}\n`, "kéy", "a".repeat(513)]) {
            expect(() => buildOpenCodeHeaders(bad)).toThrow(OpenCodeProviderError);
        }
    });
});
describe("fetchOpenCodeUsageWith (fake fetch, no network)", () => {
    test("sends bearer auth to the usage endpoint and inverts percent to percent LEFT", async () => {
        let seenUrl = "";
        let seenHeaders: Record<string, string> = {};
        const windows = await fetchOpenCodeUsageWith(KEY, SIGNAL, async (url, init) => {
            seenUrl = url;
            seenHeaders = init.headers;
            return respond(200, USAGE, { "content-type": "application/json; charset=utf-8" });
        });
        expect(seenUrl).toBe("https://opencode.ai/zen/go/v1/usage");
        expect(seenHeaders.Authorization).toBe(`Bearer ${KEY}`);
        expect(windows.map((entry) => entry.usage?.percentLeft)).toEqual([87.7, 54.4, 21.1]);
    });

    test("separates a rejected key (401) from a missing subscription (403)", async () => {
        const rejected = await fetchOpenCodeUsageWith(KEY, SIGNAL, async () => respond(401)).catch(
            (error: unknown) => error,
        );
        expect(openCodeStatusOf(rejected)).toBe("auth");
        expect(safeOpenCodeError(rejected)).toBe("OpenCode Go / Go Plus API key rejected");
        const noPlan = await fetchOpenCodeUsageWith(KEY, SIGNAL, async () => respond(403)).catch(
            (error: unknown) => error,
        );
        expect(openCodeStatusOf(noPlan)).toBe("no-subscription");
    });

    test("rejects redirects, server errors, non-JSON and unsupported payloads", async () => {
        const json = { "content-type": "application/json" };
        const cases: [FetchImpl, OpenCodeStatus][] = [
            [async () => respond(302), "auth"],
            [async () => respond(500), "unavailable"],
            [async () => respond(200, USAGE, { "content-type": "text/html" }), "unavailable"],
            [async () => respond(200, "not json", json), "unavailable"],
            [async () => respond(200, { usage: {} }, json), "unavailable"],
        ];
        for (const [fetchImpl, status] of cases) {
            const error = await fetchOpenCodeUsageWith(KEY, SIGNAL, fetchImpl).catch(
                (thrown: unknown) => thrown,
            );
            expect(error).toBeInstanceOf(OpenCodeProviderError);
            expect(openCodeStatusOf(error)).toBe(status);
        }
    });

    test("never leaks the key or body data into an error message", async () => {
        const error = await fetchOpenCodeUsageWith("sk_SECRET_VALUE", SIGNAL, async () =>
            respond(500, { secret: "body-secret" }),
        ).catch((thrown: unknown) => thrown);
        const rendered = (error as Error).message;
        expect(rendered).toContain("500");
        expect(rendered).not.toContain("sk_SECRET_VALUE");
        expect(rendered).not.toContain("body-secret");
    });

    test("never echoes transport or response errors containing the key", async () => {
        const secret = "sk_SECRET_VALUE";
        for (const fake of [
            async () => {
                throw new Error(`fetch failed for ${secret}`);
            },
            async () => {
                const response = respond(200, USAGE, { "content-type": "application/json" });
                return {
                    ...response,
                    headers: response.headers,
                    body: new ReadableStream<Uint8Array>({
                        pull() {
                            throw new Error(`stream failed for ${secret}`);
                        },
                    }),
                };
            },
        ]) {
            const error = await fetchOpenCodeUsageWith(secret, SIGNAL, fake).catch(
                (thrown: unknown) => thrown,
            );
            expect(openCodeStatusOf(error)).toBe("unavailable");
            expect((error as Error).message).not.toContain(secret);
            expect(safeOpenCodeError(error)).toBe("Unavailable");
        }
    });

    test("rejects an oversized streamed response without revealing body data", async () => {
        const error = await fetchOpenCodeUsageWith(KEY, SIGNAL, async () =>
            respond(
                200,
                { usage: { rolling: { percent: 1 }, extra: "x".repeat(1024 * 1024) } },
                {
                    "content-type": "application/json",
                },
            ),
        ).catch((thrown: unknown) => thrown);
        expect(openCodeStatusOf(error)).toBe("unavailable");
        expect((error as Error).message).not.toContain(KEY);
    });

    test("maps a transport failure and an already-aborted signal distinctly", async () => {
        const offline = await fetchOpenCodeUsageWith(KEY, SIGNAL, async () => {
            throw new Error("network down");
        }).catch((error: unknown) => error);
        expect(openCodeStatusOf(offline)).toBe("unavailable");

        const aborted = new AbortController();
        aborted.abort();
        const error = await fetchOpenCodeUsageWith(KEY, aborted.signal, usageOkFetch).catch(
            (thrown: unknown) => thrown,
        );
        expect((error as Error).name).toBe("AbortError");
    });
});

describe("openCodeStatusOf", () => {
    test("keeps its own category and falls back to unavailable for foreign errors", () => {
        expect(openCodeStatusOf(new OpenCodeProviderError("auth", "x"))).toBe("auth");
        expect(openCodeStatusOf(new Error("plain"))).toBe("unavailable");
        expect(openCodeStatusOf("string")).toBe("unavailable");
    });
});

describe("optional hosted Go access status (synthetic only)", () => {
    const json = { "content-type": "application/json" };
    const status = { product: "go", access: { endsAt: "2026-08-16T20:00:00+02:00" } };

    test("uses only both session credentials, fixed HTTPS URL and safe headers", async () => {
        const result = await fetchOpenCodeGoStatusWith(KEY, ORG, SIGNAL, async (url, init) => {
            expect(url).toBe("https://opencode.ai/console/api/go/status");
            expect(init).toMatchObject({
                method: "GET",
                redirect: "manual",
                headers: {
                    Authorization: `Bearer ${KEY}`,
                    "x-org-id": ORG,
                    accept: "application/json",
                },
            });
            expect(new Set(Object.keys(init.headers))).toEqual(
                new Set(["Authorization", "accept", "x-org-id"]),
            );
            return respond(200, status, json);
        });
        expect(result).toEqual({ plan: "Go", accessEndsAt: "2026-08-16T18:00:00.000Z" });
        expect(PROVIDERS[0].load).toBeDefined();
        expect(PROVIDERS[0].followUp).toBeDefined();
    });

    test("invalid or absent org/key never sends a status request", async () => {
        const fake = vi.fn(async () => respond(200, status, json));
        for (const org of [
            undefined,
            "",
            " org",
            "org\nInjected: yes",
            "ü",
            "a".repeat(257),
            "a/b",
        ]) {
            expect(readOpenCodeGoOrgId(org)).toBeUndefined();
            expect(await fetchOpenCodeGoStatusWith(KEY, org, SIGNAL, fake)).toBeUndefined();
        }
        expect(await fetchOpenCodeGoStatusWith(undefined, ORG, SIGNAL, fake)).toBeUndefined();
        expect(await fetchOpenCodeGoStatusWith(`${KEY}\n`, ORG, SIGNAL, fake)).toBeUndefined();
        expect(fake).not.toHaveBeenCalled();
    });

    test("only explicit product tokens and strict access expiry are accepted", () => {
        expect(parseOpenCodeGoStatus({ product: "go-plus" })).toEqual({ plan: "Go Plus" });
        expect(parseOpenCodeGoStatus({ product: "go_plus" })).toEqual({ plan: "Go Plus" });
        for (const product of ["Go", "go plus", "go-plus-premium", "plus", 123, null, undefined]) {
            expect(parseOpenCodeGoStatus({ product })).toBeUndefined();
        }
        for (const endsAt of [
            "2026-08-16",
            "2026-08-16T20:00:00",
            "tomorrow",
            "2026-02-30T00:00:00Z",
            "2026-08-16T25:00:00Z",
            "2026-08-16T20:00:00+99:00",
            123,
            null,
        ]) {
            expect(parseOpenCodeGoStatus({ access: { endsAt } })).toBeUndefined();
            expect(parseOpenCodeGoStatus({ product: "go", access: { endsAt } })).toEqual({
                plan: "Go",
            });
        }
        expect(parseOpenCodeGoStatus({ access: { endsAt: "2026-08-16T20:00:00Z" } })).toEqual({
            accessEndsAt: "2026-08-16T20:00:00.000Z",
        });
    });

    test("401, redirects, invalid JSON, oversized body and transport errors return no patch or secrets", async () => {
        const secret = "sk_SECRET_VALUE";
        const privateOrg = "org_SECRET_VALUE";
        const fakes: FetchImpl[] = [
            async () => respond(401, { secret }, json),
            async () => respond(302, null, { location: `https://elsewhere.test/${privateOrg}` }),
            async () => respond(200, "not json", json),
            async () => new Response(`{${secret}`, { status: 200, headers: json }),
            async () => respond(200, { product: "go", filler: "x".repeat(1024 * 1024) }, json),
            async () => {
                throw new Error(`${secret} ${privateOrg}`);
            },
        ];
        for (const fake of fakes) {
            const result = await fetchOpenCodeGoStatusWith(secret, privateOrg, SIGNAL, fake);
            expect(result).toBeUndefined();
        }
    });
});
