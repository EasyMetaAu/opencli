import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';
import { publishCommand, __test__ } from './publish.js';

function tempVideo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-youtube-publish-'));
    const file = path.join(dir, 'video.mp4');
    fs.writeFileSync(file, 'fake video');
    return file;
}
function assertBrowserScriptParses(script) {
    expect(() => new Function(script)).not.toThrow();
}


function pageReturning(result) {
    return {
        async evaluate() { return result; },
        async evaluateWithArgs() { return result; },
        async wait() {},
    };
}

describe('youtube publish adapter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('registers a write publish command with structured columns', () => {
        const cmd = [...getRegistry().values()].find((c) => c.site === 'youtube' && c.name === 'publish');
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
        await expect(publishCommand.func({}, { video, title: 'x', schedule: '2026-01-01T00:00:00Z' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'schedule' }]);
        await expect(publishCommand.func({}, { video, title: 'x', cover: '/tmp/cover.png' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'cover' }]);
        await expect(publishCommand.func({}, { video, title: 'x', account: 'brand' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'account' }]);
    });

    it('passes --timeout into the upload details inner wait', async () => {
        const video = tempVideo();
        let now = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => {
            const current = now;
            now += 1000;
            return current;
        });
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (script) => {
                const code = String(script);
                if (code.includes('daily upload limit')) return null;
                if (code.includes('YouTube Studio requires login')) return { ok: true };
                if (code.includes("document.querySelector('input[type=\"file\"]')")) return true;
                return null;
            }),
            evaluateWithArgs: vi.fn().mockResolvedValue('input[type="file"]'),
            wait: vi.fn().mockResolvedValue(undefined),
            setFileInput: vi.fn().mockResolvedValue(undefined),
        };

        await expect(publishCommand.func(page, {
            video,
            title: 'Timeout propagation',
            privacy: 'unlisted',
            timeout: 2,
        })).rejects.toMatchObject({ code: 'upload_failed' });

        expect(page.wait).toHaveBeenCalledTimes(1);
    });

    it('does not fail Shorts-style upload flow when made-for-kids radio is omitted', async () => {
        const evaluateResults = [
            { ok: false, message: 'made-for-kids radio was not found' },
            { ok: false },
            { ok: false, message: 'made-for-kids radio was not found' },
        ];
        const calls = [];
        const page = {
            async evaluate(script) {
                assertBrowserScriptParses(script);
                calls.push(script);
                return evaluateResults.shift();
            },
            async evaluateWithArgs() {
                throw new Error('YouTube publish flow should keep arguments scoped locally instead of using BasePage.evaluateWithArgs');
            },
            async wait() {},
        };

        await expect(__test__.chooseNotMadeForKids(page, false)).resolves.toMatchObject({ skipped: true });
        expect(calls.some((script) => script.includes('Show more'))).toBe(true);
        expect(calls.every((script) => !script.trim().startsWith('const '))).toBe(true);
    });

    it('still requires privacy radio selection after optional audience skip', async () => {
        await expect(__test__.clickAndVerifyYouTubeRadio(pageReturning({ ok: false, message: 'privacy radio was not found' }), ['Public'], 'privacy')).rejects.toMatchObject({ code: 'platform_error' });
    });

    it('maps auth and platform failures from publish polling to stable codes', async () => {
        await expect(__test__.waitForYouTubePublishResult(pageReturning({ text: 'session expired', anchors: [] }), 'public')).rejects.toBeInstanceOf(AuthRequiredError);
        await expect(__test__.waitForYouTubePublishResult(pageReturning({ text: 'publish failed', anchors: [] }), 'public')).rejects.toMatchObject({ code: 'platform_error' });
    });

    it('does not treat upload-complete text as publish success and detects privacy mismatch', () => {
        expect(__test__.classifyYouTubePublishState({ text: 'Upload complete. Processing will begin shortly.', privacy: 'public' })).toMatchObject({ pending: true });
        expect(__test__.classifyYouTubePublishState({ text: 'Video published Private', privacy: 'public' })).toMatchObject({ error: 'platform' });
        expect(__test__.classifyYouTubePublishState({ text: 'Video published Public', privacy: 'public', anchors: ['https://youtu.be/x'] })).toMatchObject({ ok: true, url: 'https://youtu.be/x' });
    });
});
