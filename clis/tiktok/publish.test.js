import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';
import { publishCommand, __test__ } from './publish.js';

function tempVideo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-tiktok-publish-'));
    const file = path.join(dir, 'video.mp4');
    fs.writeFileSync(file, 'fake video');
    return file;
}

function pageReturning(result) {
    return {
        async evaluate() { return result; },
        async evaluateWithArgs() { return result; },
        async wait() {},
        async screenshot() { return ''; },
    };
}

describe('tiktok publish adapter', () => {
    it('registers a write publish command with structured columns', () => {
        const cmd = [...getRegistry().values()].find((c) => c.site === 'tiktok' && c.name === 'publish');
        expect(cmd).toBeDefined();
        expect(cmd?.access).toBe('write');
        expect(cmd?.strategy).toBe('cookie');
        expect(cmd?.columns).toContain('code');
        expect(cmd?.args.map((a) => a.name)).toEqual(expect.arrayContaining(['video', 'title', 'description', 'tags', 'cover', 'schedule', 'privacy']));
    });

    it('rejects invalid parameters before browser interaction', async () => {
        await expect(publishCommand.func({}, { video: '/no/such.mp4', title: 'x' })).rejects.toBeInstanceOf(ArgumentError);
        await expect(publishCommand.func({}, { video: tempVideo(), title: '' })).rejects.toBeInstanceOf(ArgumentError);
    });

    it('returns structured unsupported capability rows', async () => {
        const video = tempVideo();
        await expect(publishCommand.func({}, { video, title: 'x', cover: '/tmp/cover.png' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'cover' }]);
        await expect(publishCommand.func({}, { video, title: 'x', privacy: 'private' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'privacy' }]);
    });

    it('maps auth and platform failures from publish polling to stable codes', async () => {
        await expect(__test__.waitForTikTokPublishResult(pageReturning({ error: 'auth', message: 'login' }))).rejects.toBeInstanceOf(AuthRequiredError);
        await expect(__test__.waitForTikTokPublishResult(pageReturning({ error: 'platform', message: 'upload failed' }))).rejects.toMatchObject({ code: 'platform_error' });
    });

    it('parses schedule instants (ISO/epoch) and rejects empty/past/malformed input', () => {
        const future = new Date(Date.now() + 3 * 3600_000).toISOString();
        // ISO8601 with Z resolves to the same absolute instant regardless of the host timezone.
        expect(__test__.parseScheduleInstant(future).epochMs).toBe(new Date(future).getTime());
        // Epoch seconds and milliseconds are both accepted via the 1e12 heuristic.
        const secs = Math.floor(Date.now() / 1000) + 3600;
        expect(__test__.parseScheduleInstant(String(secs)).epochMs).toBe(secs * 1000);
        expect(__test__.parseScheduleInstant(secs * 1000).epochMs).toBe(secs * 1000);
        expect(() => __test__.parseScheduleInstant('')).toThrow(ArgumentError);
        expect(() => __test__.parseScheduleInstant('not-a-date')).toThrow(ArgumentError);
        expect(() => __test__.parseScheduleInstant('2000-01-01T00:00:00Z')).toThrow(ArgumentError);
    });

    it('drives the schedule picker and reports the read-back slot', async () => {
        const future = new Date(Date.now() + 3 * 3600_000).toISOString();
        const page = pageReturning({
            ok: true, tz: 'Asia/Shanghai', requested: '2026-06-29 17:36',
            wantDate: '2026-06-29', wantTime: '17:35', selectedDate: '2026-06-29', selectedTime: '17:35', rounded: true,
        });
        await expect(__test__.setTikTokSchedule(page, future)).resolves.toMatchObject({ selectedTime: '17:35', rounded: true });
    });

    it('throws platform_error and screenshots when the schedule picker fails', async () => {
        const shots = [];
        const page = {
            async evaluate() { return { ok: false, reason: 'no-schedule-radio' }; },
            async evaluateWithArgs() { return { ok: false, reason: 'no-schedule-radio' }; },
            async wait() {},
            async screenshot(o) { shots.push(o); return ''; },
        };
        const future = new Date(Date.now() + 3 * 3600_000).toISOString();
        await expect(__test__.setTikTokSchedule(page, future)).rejects.toMatchObject({ code: 'platform_error' });
        expect(shots[0]?.path).toContain('/tmp/');
    });

    it('rejects a past/invalid schedule before touching the browser', async () => {
        let touched = false;
        const page = {
            async evaluateWithArgs() { touched = true; return { ok: true }; },
            async evaluate() { touched = true; return {}; },
            async wait() {},
            async screenshot() { return ''; },
        };
        await expect(__test__.setTikTokSchedule(page, '2000-01-01T00:00:00Z')).rejects.toBeInstanceOf(ArgumentError);
        expect(touched).toBe(false);
    });

    it('detects scheduled publish success via content redirect / toast', async () => {
        const page = pageReturning({ ok: true, url: '', message: 'TikTok scheduled publish completed' });
        await expect(__test__.waitForTikTokPublishResult(page, { scheduled: true })).resolves.toMatchObject({ ok: true, url: '' });
    });

});
