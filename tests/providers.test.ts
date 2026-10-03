import { afterEach, describe, expect, test, vi } from "vitest";
import { createGoProvider, PROVIDERS } from "../src/providers";

const KEY = "sk_SAVED_FAKE";
const ORG = "org_SAVED_FAKE";
const SIGNAL = new AbortController().signal;
const json = { "content-type": "application/json" };
const usage = { usage: { rolling: { percent: 25 } } };
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: json });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("createGoProvider (synthetic fetch only)", () => {
    test("saved key and optional org are paired for usage and follow-up, not mixed with env", async () => {
        vi.stubEnv("OPENCODE_QUOTA_GO_API_KEY", "sk_ENV_FAKE");
        vi.stubEnv("OPENCODE_QUOTA_GO_ORG_ID", "org_ENV_FAKE");
        const calls: Array<{ url: string; headers: Record<string, string> }> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
                calls.push({ url, headers: init.headers });
                return reply(url.endsWith("/usage") ? usage : { product: "go" });
            }),
        );
        const credentials = { apiKey: KEY, orgId: ORG };
        const provider = createGoProvider(() => credentials);
        expect((await provider.load(SIGNAL)).windows[0].usage?.percentLeft).toBe(75);
        credentials.apiKey = "sk_CHANGED_FAKE";
        credentials.orgId = "org_CHANGED_FAKE";
        expect(await provider.followUp?.(SIGNAL)).toEqual({ plan: "Go" });
        expect(calls.map(({ headers }) => headers.Authorization)).toEqual([
            `Bearer ${KEY}`,
            `Bearer ${KEY}`,
        ]);
        expect(calls[1].headers["x-org-id"]).toBe(ORG);
    });

    test("saved key without org skips status even if environment has one", async () => {
        vi.stubEnv("OPENCODE_QUOTA_GO_ORG_ID", "org_ENV_FAKE");
        const fetcher = vi.fn(async () => reply(usage));
        vi.stubGlobal("fetch", fetcher);
        const provider = createGoProvider(() => ({ apiKey: KEY }));
        await provider.load(SIGNAL);
        expect(await provider.followUp?.(SIGNAL)).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("undefined saved creds use existing environment-only usage and status", async () => {
        vi.stubEnv("OPENCODE_QUOTA_GO_API_KEY", "sk_ENV_FAKE");
        vi.stubEnv("OPENCODE_QUOTA_GO_ORG_ID", "org_ENV_FAKE");
        const fetcher = vi.fn(async (url: string, _init: { headers: Record<string, string> }) =>
            reply(url.endsWith("/usage") ? usage : { product: "go-plus" }),
        );
        vi.stubGlobal("fetch", fetcher);
        const provider = createGoProvider(() => undefined);
        await provider.load(SIGNAL);
        expect(await provider.followUp?.(SIGNAL)).toEqual({ plan: "Go Plus" });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer sk_ENV_FAKE");
        expect(fetcher.mock.calls[1][1].headers["x-org-id"]).toBe("org_ENV_FAKE");
        expect(PROVIDERS[0].id).toBe("opencode");
    });

    test("vault failure never silently falls back to environment credentials", async () => {
        vi.stubEnv("OPENCODE_QUOTA_GO_API_KEY", "sk_ENV_FAKE");
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        const provider = createGoProvider(() => {
            throw new Error("Windows credential storage unavailable");
        });
        await expect(provider.load(SIGNAL)).rejects.toThrow(
            "Windows credential storage unavailable",
        );
        expect(fetcher).not.toHaveBeenCalled();
        expect(await provider.followUp?.(SIGNAL)).toBeUndefined();
    });
});
