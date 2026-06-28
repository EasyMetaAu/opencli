import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { __test__ } from './auth.js';

const { verifyTiktokIdentity, buildIdentityScript } = __test__;

// verifyTiktokIdentity drives the page object: getCookies (quick pre-check),
// goto + wait (same-origin so the page-context fetch carries cookies), then a
// single evaluate() that runs the shared resolveOwnerIdentity() resolver. We
// mock evaluate's resolved/rejected value to exercise each branch.
function makePage({ cookies = [], evaluate } = {}) {
    return {
        getCookies: vi.fn().mockResolvedValue(cookies),
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: evaluate ?? vi.fn().mockResolvedValue(null),
    };
}

const sessionCookies = [{ name: 'sessionid', value: 'x' }];

describe('tiktok/auth verifyTiktokIdentity', () => {
    it('throws AuthRequiredError before navigating when session cookies are missing', async () => {
        const page = makePage({ cookies: [] });
        await expect(verifyTiktokIdentity(page)).rejects.toBeInstanceOf(AuthRequiredError);
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('returns identity when the probe resolves an owner user', async () => {
        const page = makePage({
            cookies: sessionCookies,
            evaluate: vi.fn().mockResolvedValue({ sec_uid: 'MS4abc', username: 'dictogo', nickname: 'DictoGo' }),
        });
        await expect(verifyTiktokIdentity(page)).resolves.toEqual({
            sec_uid: 'MS4abc',
            username: 'dictogo',
            nickname: 'DictoGo',
        });
        expect(page.goto).toHaveBeenCalledWith('https://www.tiktok.com/foryou');
    });

    it('throws AuthRequiredError when neither rehydration nor API resolves an owner', async () => {
        const page = makePage({ cookies: sessionCookies, evaluate: vi.fn().mockResolvedValue(null) });
        await expect(verifyTiktokIdentity(page)).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('maps auth-shaped probe failures to AuthRequiredError (so login polling keeps waiting)', async () => {
        const page = makePage({
            cookies: sessionCookies,
            evaluate: vi.fn().mockRejectedValue(new Error('AUTH_REQUIRED: user-info API failed: login required')),
        });
        await expect(verifyTiktokIdentity(page)).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('maps non-auth probe failures to CommandExecutionError', async () => {
        const page = makePage({
            cookies: sessionCookies,
            evaluate: vi.fn().mockRejectedValue(new Error('user-info API failed: HTTP 500')),
        });
        await expect(verifyTiktokIdentity(page)).rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('builds a page script that uses the shared resolver and user-info endpoint', () => {
        const script = buildIdentityScript();
        expect(script).toContain('resolveOwnerIdentity');
        expect(script).toContain('/passport/web/account/info/');
    });
});
