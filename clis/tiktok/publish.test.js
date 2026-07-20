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

    it('rejects offset-less ISO schedule strings (absolute-instant contract)', () => {
        // The documented contract is absolute instants only: an ISO string without an
        // explicit Z/offset would silently resolve in the Node process timezone, which
        // is exactly the ambiguity the browser-side picker computation must never see.
        expect(() => __test__.parseScheduleInstant('2099-06-29T17:35:00')).toThrow(ArgumentError);
        expect(() => __test__.parseScheduleInstant('2099-06-29T17:35')).toThrow(ArgumentError);
        expect(() => __test__.parseScheduleInstant('2099-06-29T17:35:00.000')).toThrow(ArgumentError);
        expect(() => __test__.parseScheduleInstant('2099-06-29')).toThrow(ArgumentError);
        // Explicit numeric offsets and Z stay accepted and resolve to the same absolute
        // instant on every host, exactly as Date.parse resolves them.
        expect(__test__.parseScheduleInstant('2099-06-29T17:35:00+08:00').epochMs).toBe(Date.parse('2099-06-29T17:35:00+08:00'));
        expect(__test__.parseScheduleInstant('2099-06-29T17:35:00-07:00').epochMs).toBe(Date.parse('2099-06-29T17:35:00-07:00'));
        expect(__test__.parseScheduleInstant('2099-06-29T17:35:00Z').epochMs).toBe(Date.parse('2099-06-29T17:35:00Z'));
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

describe('tiktok publish — API path with DOM fallback', () => {
    // A page mock for the API path: the vid hook is read via evaluate('window.__ttUploadVid').
    // `vid` is the captured video info (or null to simulate a failed upload capture).
    function apiPage({ vid, postResponse }) {
        const calls = { setFileInput: 0, evaluate: 0, domCaptionOrPicker: 0 };
        const page = {
            async goto() {},
            async setFileInput() { calls.setFileInput += 1; },
            async setInputFiles() { calls.setFileInput += 1; },
            async wait() {},
            async screenshot() { return ''; },
            async evaluate(js) {
                calls.evaluate += 1;
                const s = String(js);
                // publish/check fetches run through evaluate → success envelope
                if (s.includes('project/post/v1')) return { __http: 200, __json: postResponse };
                if (s.includes('content/check/create')) return { __http: 200, __json: { check_ids: {}, status_code: 0 } };
                // vid hook read
                if (s.includes('__ttUploadVid')) return vid || null;
                // vid hook install
                if (s.includes('__ttVidHookInstalled')) return { installed: true };
                // login check → logged in
                if (s.includes('loginLike') || (s.includes('location.href') && s.includes('input[type="file"]'))) return { ok: true, url: 'https://www.tiktok.com/tiktokstudio/upload' };
                // draft-restore guard → nothing to dismiss
                if (s.includes('draftRestoreGuard')) return { present: false, settled: true };
                // any DOM caption/timepicker/calendar work counts as a DOM-path touch
                if (s.includes('DraftEditor') || s.includes('tiktok-timepicker') || s.includes('calendar-wrapper') || s.includes('postSchedule')) { calls.domCaptionOrPicker += 1; return { ok: true }; }
                return { ok: true };
            },
            async evaluateWithArgs() { return { ok: true }; },
        };
        return { page, calls };
    }

    const tempVideoLocal = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-tt-api-'));
        const f = path.join(dir, 'v.mp4');
        fs.writeFileSync(f, 'x');
        return f;
    };

    it('publishes via API (no DOM picker) when the vid hook yields a vid', async () => {
        const { page, calls } = apiPage({
            vid: { video_id: 'v12025gd0000dTEST0000000000000000', width: 1080, height: 1920 },
            postResponse: { status_code: 0, project_id: 'p1', single_post_resp_list: [{ item_id: '7658000000000000001', status_code: 0 }] },
        });
        const rows = await publishCommand.func(page, { video: tempVideoLocal(), title: 'hi #tag', mode: 'auto' });
        expect(rows[0]).toMatchObject({ ok: true, platform: 'tiktok' });
        expect(rows[0].message).toContain('7658000000000000001');
        expect(rows[0].url).toContain('7658000000000000001');
        // API path must NOT have touched the DOM caption/picker
        expect(calls.domCaptionOrPicker).toBe(0);
    });

    it('includes schedule_time in the API message when scheduled', async () => {
        const future = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
        const { page } = apiPage({
            vid: { video_id: 'v12025gd0000dTEST0000000000000000' },
            postResponse: { status_code: 0, single_post_resp_list: [{ item_id: '7658000000000000002', status_code: 0 }] },
        });
        const rows = await publishCommand.func(page, { video: tempVideoLocal(), title: 'hi', schedule: future, mode: 'auto' });
        expect(rows[0].message).toContain('scheduled via API');
    });

    it('mode=api surfaces a platform_error if the API path fails (no silent DOM fallback)', async () => {
        // vid is captured, but the publish request returns a business error → fails fast.
        const { page } = apiPage({
            vid: { video_id: 'v12025gd0000dTEST0000000000000000' },
            postResponse: { status_code: 10001, status_msg: 'rejected', single_post_resp_list: [] },
        });
        await expect(publishCommand.func(page, { video: tempVideoLocal(), title: 'x', mode: 'api' }))
            .rejects.toMatchObject({ code: 'platform_error' });
    });
});

describe('clickTikTokPublish — exit-dialog self-heal guard', () => {
    // Dispatch fake responses by a stable marker in each injected script:
    // the click loop embeds clickByLabels, the guard embeds /* exitDialogGuard */,
    // anything else is the copyright-confirm loop (answered with done).
    function guardPage({ clickResults, guardResults }) {
        const calls = { click: 0, guard: 0 };
        const page = {
            async evaluateWithArgs(script) {
                if (script.includes('clickByLabels')) {
                    const r = clickResults[Math.min(calls.click, clickResults.length - 1)];
                    calls.click += 1;
                    return r;
                }
                return { ok: true };
            },
            async evaluate(script) {
                if (script.includes('exitDialogGuard')) {
                    const r = guardResults[Math.min(calls.guard, guardResults.length - 1)];
                    calls.guard += 1;
                    return r;
                }
                return { done: true };
            },
            async wait() {},
            async screenshot() { return ''; },
        };
        return { page, calls };
    }

    it('dismisses the exit dialog after a wrong click and re-polls until the real button lands', async () => {
        const { page, calls } = guardPage({
            clickResults: [{ ok: true, text: 'posts' }, { ok: true, text: 'post' }],
            guardResults: [{ exitDialog: true, dismissed: true }, { exitDialog: false }],
        });
        await expect(__test__.clickTikTokPublish(page)).resolves.toBeUndefined();
        expect(calls.click).toBe(2);
        expect(calls.guard).toBe(2);
    });

    it('accepts a clean click on the first pass (guard sees no exit dialog)', async () => {
        const { page, calls } = guardPage({
            clickResults: [{ ok: true, text: 'post' }],
            guardResults: [{ exitDialog: false }],
        });
        await expect(__test__.clickTikTokPublish(page)).resolves.toBeUndefined();
        expect(calls.click).toBe(1);
    });

    it('fails loudly when the click navigated somewhere that is neither upload nor content', async () => {
        const { page } = guardPage({
            clickResults: [{ ok: true, text: 'post' }],
            guardResults: [{ navigatedAway: true, href: 'https://www.tiktok.com/tiktokstudio/analytics' }],
        });
        await expect(__test__.clickTikTokPublish(page)).rejects.toMatchObject({ code: 'platform_error' });
    });
});

describe('dismissTikTokDraftRestoreDialog', () => {
    function draftPage(results) {
        let call = 0;
        return {
            calls: () => call,
            async evaluate() {
                const r = results[Math.min(call, results.length - 1)];
                call += 1;
                return r;
            },
            async wait() {},
        };
    }

    it('clicks Discard when the stale-draft dialog is up, then returns', async () => {
        const page = draftPage([{ present: true, dismissed: true }]);
        await expect(__test__.dismissTikTokDraftRestoreDialog(page)).resolves.toBeUndefined();
        expect(page.calls()).toBe(1);
    });

    it('returns immediately when the file input is already available and no dialog shows', async () => {
        const page = draftPage([{ present: false, settled: true }]);
        await expect(__test__.dismissTikTokDraftRestoreDialog(page)).resolves.toBeUndefined();
        expect(page.calls()).toBe(1);
    });

    it('keeps polling while the dialog is visible but the Discard button has not matched yet', async () => {
        const page = draftPage([
            { present: true, dismissed: false },
            { present: true, dismissed: true },
        ]);
        await expect(__test__.dismissTikTokDraftRestoreDialog(page)).resolves.toBeUndefined();
        expect(page.calls()).toBe(2);
    });
});
