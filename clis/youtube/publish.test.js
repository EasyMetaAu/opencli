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

    it('treats --timeout as one full-flow deadline instead of resetting per wait', async () => {
        vi.spyOn(Date, 'now')
            .mockReturnValueOnce(1000)
            .mockReturnValueOnce(2500)
            .mockReturnValueOnce(3500);

        const deadline = __test__.createFlowDeadline(2);

        expect(deadline).toBe(3000);
        expect(__test__.remainingTimeoutMs(deadline)).toBe(500);
        expect(__test__.remainingTimeoutMs(deadline)).toBe(0);
    });

    it('fails fast with upload diagnostics when setFileInput leaves the picker empty', async () => {
        const page = {
            evaluate: vi.fn().mockResolvedValue({
                url: 'https://studio.youtube.com/channel/demo',
                modalTitle: '上传视频',
                text: '上传视频 将要上传的视频文件拖放到此处 选择文件',
                filePickerVisible: true,
                detailsReady: false,
                fileInputs: [{ count: 0, names: [], accept: '' }],
            }),
        };

        await expect(__test__.verifyYouTubeFileSelected(page, '/tmp/video.mp4')).rejects.toMatchObject({
            code: 'upload_failed',
            message: expect.stringContaining('file input has no selected file'),
        });
        await expect(__test__.verifyYouTubeFileSelected(page, '/tmp/video.mp4')).rejects.toMatchObject({
            message: expect.stringContaining('filePickerVisible=true'),
        });
    });

    it('adds upload diagnostics to details-dialog timeout errors', async () => {
        const page = {
            evaluate: vi.fn(async (script) => {
                const code = String(script);
                if (code.includes('fileInputs')) {
                    return {
                        url: 'https://studio.youtube.com/channel/demo',
                        modalTitle: '上传视频',
                        text: '选择文件',
                        filePickerVisible: true,
                        detailsReady: false,
                        fileInputs: [{ count: 0, names: [] }],
                    };
                }
                return null;
            }),
            wait: vi.fn().mockResolvedValue(undefined),
        };

        await expect(__test__.waitForDetailsDialog(page, Date.now() - 1)).rejects.toMatchObject({
            code: 'upload_failed',
            message: expect.stringContaining('fileInputs=[#0:count=0'),
        });
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
