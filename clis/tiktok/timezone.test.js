// RED contract for `opencli tiktok timezone`.
//
// The command is a read-only probe of the already-connected target page
// (e.g. an AdsPower fingerprint browser with TikTok open): it must not
// navigate, must read `Intl.DateTimeFormat().resolvedOptions().timeZone`
// inside the page, and must fail closed unless the page reports a canonical
// non-empty IANA time zone.

import { describe, expect, it, vi } from 'vitest';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { timezoneCommand } from './timezone.js';

function makePage(evaluateResult) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(evaluateResult),
    };
}

function makeFailingPage(error) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockRejectedValue(error),
    };
}

describe('tiktok/timezone', () => {
    it('is a read-only browser command bound to the connected TikTok session', () => {
        expect(timezoneCommand.site).toBe('tiktok');
        expect(timezoneCommand.name).toBe('timezone');
        expect(timezoneCommand.access).toBe('read');
        expect(timezoneCommand.browser).toBe(true);
        expect(timezoneCommand.strategy).toBe('cookie');
        expect(timezoneCommand.pipeline).toBeUndefined();
        expect(typeof timezoneCommand.func).toBe('function');
        expect(timezoneCommand.columns).toContain('timeZone');
    });

    it('reads the timezone from the already-connected page without navigating', async () => {
        const page = makePage('America/New_York');

        const rows = await timezoneCommand.func(page, {});

        expect(page.goto).not.toHaveBeenCalled();
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.evaluate.mock.calls[0][0]).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ timeZone: 'America/New_York' });
    });

    it('returns structured JSON rows for any canonical IANA zone', async () => {
        for (const timeZone of ['Asia/Shanghai', 'Europe/Berlin']) {
            const page = makePage(timeZone);

            const rows = await timezoneCommand.func(page, {});

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ timeZone });
            // Rows must survive JSON output untouched (no functions, cycles, etc.).
            expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
        }
    });

    it('fails closed when the page reports no timezone', async () => {
        for (const missing of ['', '   ', null, undefined]) {
            const page = makePage(missing);

            await expect(timezoneCommand.func(page, {})).rejects.toBeInstanceOf(CommandExecutionError);
        }

        await expect(timezoneCommand.func(makePage(''), {})).rejects.toThrow(/time.?zone/i);
    });

    it('fails closed when the page reports an invalid or non-IANA value', async () => {
        for (const invalid of ['Invalid/Zone', 'Not A Zone', 'GMT+8:00', 123, { timeZone: 'Asia/Shanghai' }]) {
            const page = makePage(invalid);

            await expect(timezoneCommand.func(page, {})).rejects.toBeInstanceOf(CommandExecutionError);
        }
    });

    it('surfaces page evaluation failures as typed errors instead of returning rows', async () => {
        const page = makeFailingPage(new Error('Execution context was destroyed'));

        await expect(timezoneCommand.func(page, {})).rejects.toBeInstanceOf(CommandExecutionError);
    });
});
