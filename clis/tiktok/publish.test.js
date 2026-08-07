import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
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

function runUploadReadyProbe(html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
        url: 'https://www.tiktok.com/tiktokstudio/upload',
        runScripts: 'outside-only',
    });
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
        x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40,
        toJSON() { return this; },
    });
    return dom.window.eval(__test__.buildTikTokUploadReadyProbeScript());
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

    it('does not mistake the TikTok Studio Posts navigation control for an upload-ready editor', () => {
        const result = runUploadReadyProbe('<aside><button>Posts</button></aside>');
        expect(result).toMatchObject({ ok: false, uploading: false, captionSelector: '', hasSubmit: false });
    });

    it('recognizes the plaintext-only caption editor used by newer TikTok Studio builds', () => {
        const result = runUploadReadyProbe(`
            <div data-e2e="caption-input"><div role="textbox" contenteditable="plaintext-only"></div></div>
            <button data-e2e="post_video_button">Post</button>
        `);
        expect(result).toMatchObject({ ok: true, uploading: false, hasSubmit: true });
        expect(result.captionSelector).toContain('contenteditable');
    });

    it('keeps waiting while upload progress is still visible even when the caption has mounted', () => {
        const result = runUploadReadyProbe(`
            <p>42.02MB / 42.45MB · 3 seconds left · 99%</p>
            <div data-e2e="caption-input"><div role="textbox" contenteditable="true"></div></div>
            <button data-e2e="post_video_button">Post</button>
        `);
        expect(result).toMatchObject({ ok: false, uploading: true, hasSubmit: true });
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

    it('fails before writing when schedule setup crosses the shared pre-write deadline', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const page = {
            async evaluateWithArgs() {
                now += 1_000;
                return { ok: true, selectedDate: '2026-08-08', selectedTime: '12:00', tz: 'Asia/Shanghai' };
            },
            async screenshot() {},
        };
        const future = new Date('2026-08-08T12:00:00+08:00').toISOString();
        try {
            await expect(__test__.setTikTokSchedule(page, future, 1_500)).rejects.toMatchObject({ code: 'platform_error' });
        } finally {
            vi.restoreAllMocks();
        }
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
        let activeAttemptId = '';
        const page = {
            async goto() {},
            async setFileInput() { calls.setFileInput += 1; },
            async setInputFiles() { calls.setFileInput += 1; },
            async wait() {},
            async screenshot() { return ''; },
            async evaluate(js) {
                calls.evaluate += 1;
                const s = String(js);
                if (s.includes('window.__ttUploadAttempt =')) {
                    const match = s.match(/window\.__ttUploadAttempt\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
                    activeAttemptId = match ? JSON.parse(match[1].replaceAll("'", '"')) : 'mock-attempt';
                    return { attemptId: activeAttemptId };
                }
                // publish/check fetches run through evaluate → success envelope
                if (s.includes('project/post/v1')) return { __http: 200, __json: postResponse };
                if (s.includes('content/check/create')) return { __http: 200, __json: { check_ids: {}, status_code: 0 } };
                // vid hook read
                if (s.includes('__ttUploadVid')) return vid ? { video: vid, attemptId: activeAttemptId } : { video: null, attemptId: activeAttemptId };
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

    it('never falls back to DOM after the API write starts and its response is lost', async () => {
        const { page, calls } = apiPage({
            vid: { video_id: 'v12025gd0000dTEST0000000000000000' },
            postResponse: { status_code: 0 },
        });
        let activeAttemptId = '';
        page.evaluate = vi.fn(async (js) => {
            const s = String(js);
            if (s.includes('window.__ttUploadAttempt =')) {
                const match = s.match(/window\.__ttUploadAttempt\s*=\s*("(?:[^"\\]|\\.)*")/);
                activeAttemptId = match ? JSON.parse(match[1]) : 'mock-attempt';
                return { attemptId: activeAttemptId };
            }
            if (s.includes('project/post/v1')) throw new Error('connection reset after dispatch');
            if (s.includes('__ttUploadVid')) return { video: { video_id: 'v12025gd0000dTEST0000000000000000' }, attemptId: activeAttemptId };
            if (s.includes('__ttVidHookInstalled')) return { installed: true };
            if (s.includes('loginLike') || (s.includes('location.href') && s.includes('input[type="file"]'))) return { ok: true };
            if (s.includes('draftRestoreGuard')) return { present: false, settled: true };
            calls.domCaptionOrPicker += 1;
            throw new Error('DOM fallback must not run');
        });

        const rows = await publishCommand.func(page, { video: tempVideoLocal(), title: 'hi', mode: 'auto', timeout: 180 });

        expect(rows[0]).toMatchObject({ ok: false, status: 'unknown', code: 'publish_outcome_unknown' });
        expect(calls.domCaptionOrPicker).toBe(0);
        expect(page.evaluate.mock.calls.filter(([script]) => String(script).includes('project/post/v1'))).toHaveLength(1);
    });

    it('uses one shared upload wait beyond 180s while XHR progress keeps advancing', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const snapshots = [
            { progress: { loaded: 10, total: 100 } },
            { progress: { loaded: 40, total: 100 } },
            { progress: { loaded: 70, total: 100 } },
            { video: { video_id: 'vid-after-240s' }, progress: { loaded: 100, total: 100 } },
        ];
        let read = 0;
        const page = {
            async evaluate(script) {
                if (String(script).includes('__ttUploadProgress')) {
                    return snapshots[Math.min(read++, snapshots.length - 1)];
                }
                return { ok: false, uploading: true };
            },
            async wait({ time }) { now += time * 1000; },
        };

        try {
            const route = await __test__.waitForPublishRoute(page, {
                mode: 'auto',
                deadlineAt: now + 300_000,
                pollMs: 80_000,
                stallMs: 90_000,
            });
            expect(route).toMatchObject({ kind: 'api', video: { video_id: 'vid-after-240s' } });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('resets upload capture before every file injection', async () => {
        let reset = false;
        let activeAttemptId = '';
        const page = {
            async goto() {},
            async setFileInput() { expect(reset).toBe(true); },
            async wait() {},
            async evaluate(script) {
                const s = String(script);
                if (s.includes('window.__ttUploadAttempt =')) {
                    reset = true;
                    const match = s.match(/window\.__ttUploadAttempt\s*=\s*("(?:[^"\\]|\\.)*")/);
                    activeAttemptId = match ? JSON.parse(match[1]) : 'new';
                    return { attemptId: activeAttemptId };
                }
                if (s.includes('project/post/v1')) return { __http: 200, __json: { status_code: 0, single_post_resp_list: [{ item_id: '1', status_code: 0 }] } };
                if (s.includes('__ttUploadProgress')) return { video: { video_id: 'vid' }, progress: null, attemptId: activeAttemptId };
                if (s.includes('loginLike')) return { ok: true };
                if (s.includes('draftRestoreGuard')) return { present: false, settled: true };
                return { installed: true };
            },
        };

        await expect(publishCommand.func(page, { video: tempVideoLocal(), title: 'hi', mode: 'api', timeout: 180 }))
            .resolves.toMatchObject([{ ok: true }]);
    });

    it('fails before writing when XHR upload progress stalls for 90s', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const page = {
            async evaluate(script) {
                if (String(script).includes('__ttUploadProgress')) {
                    return { progress: { loaded: 10, total: 100 } };
                }
                return { ok: false, uploading: true };
            },
            async wait({ time }) { now += time * 1000; },
        };

        try {
            await expect(__test__.waitForPublishRoute(page, {
                mode: 'auto',
                deadlineAt: now + 300_000,
                pollMs: 30_000,
                stallMs: 90_000,
            })).rejects.toMatchObject({ code: 'upload_failed' });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('does not extend the legacy 180s wait when no XHR progress signal is available', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const page = {
            async evaluate(script) {
                if (String(script).includes('__ttUploadProgress')) return { video: null, progress: null };
                return { ok: false, uploading: true };
            },
            async wait({ time }) { now += time * 1000; },
        };

        try {
            await expect(__test__.waitForPublishRoute(page, {
                mode: 'auto',
                deadlineAt: now + 300_000,
                pollMs: 60_000,
                stallMs: 90_000,
            })).rejects.toMatchObject({ code: 'upload_failed' });
            expect(now).toBeLessThanOrEqual(181_000);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('does not treat a backwards loaded value as upload progress', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const loaded = [50, 40, 40, 40];
        let read = 0;
        const page = {
            async evaluate(script) {
                if (String(script).includes('__ttUploadProgress')) {
                    return { progress: { loaded: loaded[Math.min(read++, loaded.length - 1)], total: 100 } };
                }
                return { ok: false, uploading: true };
            },
            async wait({ time }) { now += time * 1000; },
        };

        try {
            await expect(__test__.waitForPublishRoute(page, {
                mode: 'auto', deadlineAt: now + 300_000, pollMs: 30_000, stallMs: 90_000,
            })).rejects.toMatchObject({ code: 'upload_failed' });
            expect(now).toBe(91_000);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('uses newer progress events even when a chunk loaded counter restarts', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const snapshots = [
            { progress: { loaded: 100, total: 100, updatedAt: 1_000 } },
            { progress: { loaded: 10, total: 100, updatedAt: 31_000 } },
            { progress: { loaded: 20, total: 100, updatedAt: 61_000 } },
        ];
        let read = 0;
        const page = {
            async evaluate(script) {
                if (String(script).includes('__ttUploadProgress')) {
                    return snapshots[Math.min(read++, snapshots.length - 1)];
                }
                return { ok: false, uploading: true };
            },
            async wait({ time }) { now += time * 1000; },
        };

        try {
            await expect(__test__.waitForPublishRoute(page, {
                mode: 'api',
                deadlineAt: now + 300_000,
                pollMs: 30_000,
                stallMs: 90_000,
            })).rejects.toMatchObject({ code: 'upload_failed' });
            expect(now).toBeGreaterThanOrEqual(151_000);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('rejects a captured video id when the current upload attempt identity is missing', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const page = {
            async evaluate(script) {
                if (String(script).includes('__ttUploadProgress')) {
                    return { video: { video_id: 'stale-video-id' }, progress: null, attemptId: '' };
                }
                return { ok: false, uploading: true };
            },
            async wait({ time }) { now += time * 1000; },
        };

        try {
            await expect(__test__.waitForPublishRoute(page, {
                mode: 'api',
                attemptId: 'current-attempt',
                deadlineAt: now + 2_000,
                pollMs: 1_000,
            })).rejects.toMatchObject({ code: 'upload_failed' });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('keeps about 40% of an explicit long timeout for DOM preparation and receipt', () => {
        expect(__test__.publishDeadlines(840_000, 1_000)).toMatchObject({
            deadlineAt: 841_000,
            uploadDeadlineAt: 505_000,
        });
        expect(__test__.publishDeadlines(180_000, 1_000)).toMatchObject({
            deadlineAt: 181_000,
            uploadDeadlineAt: 181_000,
        });
    });

    it('does not unlock the long upload budget from progress with a non-positive total', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        let loaded = 0;
        const page = {
            async evaluate(script) {
                if (String(script).includes('__ttUploadProgress')) {
                    loaded += 10;
                    return { progress: { loaded, total: 0 } };
                }
                return { ok: false, uploading: true };
            },
            async wait({ time }) { now += time * 1000; },
        };
        try {
            await expect(__test__.waitForPublishRoute(page, {
                mode: 'auto', deadlineAt: now + 300_000, pollMs: 60_000, stallMs: 90_000,
            })).rejects.toMatchObject({ code: 'upload_failed' });
            expect(now).toBeLessThanOrEqual(181_000);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('keeps the file-selector wait capped at 45s even with a long command budget', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const page = {
            async goto() {},
            async evaluate(script) {
                const text = String(script);
                if (text.includes('loginLike')) return { ok: true };
                if (text.includes('draftRestoreGuard')) return { present: false, settled: true };
                if (text.includes('__ttVidHookInstalled')) return { installed: true };
                return { ok: true };
            },
            async evaluateWithArgs() { return ''; },
            async setFileInput() {},
            async wait({ time }) { now += time * 1000; },
        };

        try {
            await expect(publishCommand.func(page, {
                video: tempVideoLocal(),
                title: 'slow selector',
                mode: 'auto',
                timeout: 840,
            })).rejects.toMatchObject({ code: 'upload_failed' });
            expect(now).toBeLessThanOrEqual(46_000);
        } finally {
            vi.restoreAllMocks();
        }
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
