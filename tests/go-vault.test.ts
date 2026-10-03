import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
    clearWindowsGoCredentials,
    GoVaultError,
    loadWindowsGoCredentials,
    saveWindowsGoCredentials,
} from "../src/go-vault/windows";

const vault = vi.hoisted(() => ({
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
}));
vi.mock("@github/keytar", () => vault);

const KEY = "sk_FAKE_SECRET";
const ORG = "org_FAKE_PRIVATE";

beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vault.getPassword.mockReset().mockResolvedValue(null);
    vault.setPassword.mockReset().mockResolvedValue(undefined);
    vault.deletePassword.mockReset().mockResolvedValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe("Windows Go vault (fake keytar, synthetic credentials)", () => {
    test("round-trips one versioned entry using fixed service/account names", async () => {
        await saveWindowsGoCredentials({ apiKey: KEY, orgId: ORG });
        expect(vault.setPassword).toHaveBeenCalledWith(
            "opencode-tui-quota-usage",
            "opencode-go",
            JSON.stringify({ version: 1, apiKey: KEY, orgId: ORG }),
        );
        vault.getPassword.mockResolvedValue(vault.setPassword.mock.calls[0][2]);
        expect(await loadWindowsGoCredentials()).toEqual({ apiKey: KEY, orgId: ORG });
        expect(vault.getPassword).toHaveBeenCalledWith("opencode-tui-quota-usage", "opencode-go");
        await clearWindowsGoCredentials();
        expect(vault.deletePassword).toHaveBeenCalledWith(
            "opencode-tui-quota-usage",
            "opencode-go",
        );
    });

    test("accepts optional blank org and distinguishes a missing entry", async () => {
        expect(await loadWindowsGoCredentials()).toBeUndefined();
        await saveWindowsGoCredentials({ apiKey: KEY, orgId: "" });
        expect(JSON.parse(vault.setPassword.mock.calls[0][2])).toEqual({ version: 1, apiKey: KEY });
    });

    test("rejects invalid inputs before vault write without leaking credentials", async () => {
        for (const credentials of [
            { apiKey: `${KEY}\n` },
            { apiKey: KEY, orgId: `${ORG}\n` },
            { apiKey: "a".repeat(513) },
        ]) {
            const failure = await saveWindowsGoCredentials(credentials).catch(
                (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(GoVaultError);
            expect((failure as GoVaultError).code).toBe("invalid");
            expect((failure as Error).message).toBe("Invalid OpenCode Go credentials");
            expect((failure as Error).message).not.toContain(KEY);
            expect((failure as Error).message).not.toContain(ORG);
        }
        expect(vault.setPassword).not.toHaveBeenCalled();
    });

    test("rejects malformed, unsupported and invalid saved entries without a fallback", async () => {
        for (const entry of [
            "not-json",
            "null",
            JSON.stringify({ version: 2, apiKey: KEY }),
            JSON.stringify({ version: 1, apiKey: `${KEY}\n` }),
            JSON.stringify({ version: 1, apiKey: KEY, orgId: `${ORG}\n` }),
            JSON.stringify({ version: 1, apiKey: KEY, orgId: null }),
            JSON.stringify({ version: 1, apiKey: KEY, extra: ORG }),
        ]) {
            vault.getPassword.mockResolvedValueOnce(entry);
            const failure = await loadWindowsGoCredentials().catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(GoVaultError);
            expect((failure as GoVaultError).code).toBe("corrupt");
            expect((failure as Error).message).toBe("Invalid saved OpenCode Go credentials");
            expect((failure as Error).message).not.toContain(KEY);
            expect((failure as Error).message).not.toContain(ORG);
        }
    });

    test("does not report successful clear when keytar returns false", async () => {
        vault.deletePassword.mockResolvedValueOnce(false);
        vault.getPassword.mockResolvedValueOnce(JSON.stringify({ version: 1, apiKey: KEY }));
        const failure = await clearWindowsGoCredentials().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GoVaultError);
        expect((failure as GoVaultError).code).toBe("unavailable");
        expect((failure as Error).message).toBe("Windows credential storage unavailable");
        expect((failure as Error).message).not.toContain(KEY);
        expect(vault.getPassword).not.toHaveBeenCalled();
    });

    test("masks errors from every vault operation", async () => {
        vault.getPassword.mockRejectedValueOnce(new Error(KEY));
        const failure = await loadWindowsGoCredentials().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GoVaultError);
        expect((failure as GoVaultError).code).toBe("unavailable");
        expect((failure as Error).message).toBe("Windows credential storage unavailable");
        expect((failure as Error).message).not.toContain(KEY);
        vault.setPassword.mockRejectedValueOnce(new Error(KEY));
        await expect(saveWindowsGoCredentials({ apiKey: KEY })).rejects.toThrow(
            "Windows credential storage unavailable",
        );
        vault.deletePassword.mockRejectedValueOnce(new Error(ORG));
        await expect(clearWindowsGoCredentials()).rejects.toThrow(
            "Windows credential storage unavailable",
        );
    });

    test("is Windows-only; non-Windows load is empty and never calls keytar", async () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        expect(await loadWindowsGoCredentials()).toBeUndefined();
        await expect(saveWindowsGoCredentials({ apiKey: KEY })).rejects.toThrow(
            "Go credential storage requires Windows",
        );
        await expect(clearWindowsGoCredentials()).rejects.toThrow(
            "Go credential storage requires Windows",
        );
        expect(vault.getPassword).not.toHaveBeenCalled();
        expect(vault.setPassword).not.toHaveBeenCalled();
        expect(vault.deletePassword).not.toHaveBeenCalled();
    });
});
