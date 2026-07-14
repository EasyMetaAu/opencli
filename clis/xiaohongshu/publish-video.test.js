import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CliError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { __test__ } from './publish-video.js';

// A page mock whose evaluate() branches on the JS source string, mirroring
// publish.test.js's createConditionalPageMock. Each branch returns the value the
// real page would produce for that evaluate call.
function createConditionalPageMock(evaluateImpl, overrides = {}) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockImplementation(async (js) => evaluateImpl(String(js))),
        wait: vi.fn().mockResolvedValue(undefined),
        screenshot: vi.fn().mockResolvedValue(''),
        setFileInput: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined),
        pressKey: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

// Write a tiny throwaway mp4 so validateVideoPublishInput's fs.statSync passes.
function makeVideo(ext = '.mp4') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-xhs-video-'));
    const file = path.join(dir, `clip${ext}`);
    fs.writeFileSync(file, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    return file;
}

// The happy-path evaluate router: navigates the video surface → upload-ready →
// editor form → fill title/body → publish → success marker. `state` lets a test
// override the upload/editor progression.
function happyPathRouter({ titleActual = '视频标题', bodyActual = '视频正文', successText = '发布成功' } = {}) {
    return (code) => {
        if (code.includes('location.href'))
            return 'https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=video';
        if (code.includes("const targets = ['上传视频', '视频']"))
            return { ok: true, target: '上传视频', text: '上传视频' };
        // Surface probe: report the video surface until the editor is ready. We
        // return editor_ready so waitForVideoSurface accepts it immediately.
        if (code.includes('hasTitleInput') && code.includes('hasVideoSurface'))
            return { state: 'video_surface', hasTitleInput: false, hasImageInput: false, hasVideoSurface: true };
        // shared setFileInput → waitForAnySelector probe.
        if (code.includes('.find((selector) =>'))
            return 'input[type="file"][accept*="video"]';
        // Upload/transcode state probe: done immediately with the title present.
        if (code.includes('__opencli_xhs_video_upload_state'))
            return { uploading: false, hasTitle: true, hasPreviewVideo: true };
        // waitForEditForm probe.
        if (code.includes('const sels =') && code.includes('for (const sel of sels)'))
            return true;
        if (code.includes('__opencli_xhs_fill_phase') && code.includes('"locate"')) {
            return code.includes('[contenteditable="true"][placeholder*="标题"]')
                ? { ok: true, sel: '[contenteditable="true"][placeholder*="标题"]', kind: 'contenteditable' }
                : { ok: true, sel: '[contenteditable="true"][class*="content"]', kind: 'contenteditable' };
        }
        if (code.includes('__opencli_xhs_fill_phase') && code.includes('"prepare"'))
            return { ok: true };
        if (code.includes('__opencli_xhs_fill_phase') && code.includes('"verify"')) {
            return code.includes('[contenteditable="true"][placeholder*="标题"]')
                ? { ok: true, actual: titleActual }
                : { ok: true, actual: bodyActual };
        }
        if (code.includes('(function(selectors, text)')) {
            return code.includes('[contenteditable="true"][placeholder*="标题"]')
                ? { ok: true, sel: '[contenteditable="true"][placeholder*="标题"]', kind: 'contenteditable', actual: titleActual }
                : { ok: true, sel: '[contenteditable="true"][class*="content"]', kind: 'contenteditable', actual: bodyActual };
        }
        // Body-editor focus helper (addTopics).
        if (code.includes('node.isContentEditable') && code.includes('selectNodeContents'))
            return true;
        if (code.includes('__opencli_xhs_topic_marker_count')) {
            // odd call → before (0), even call → after (1): one new marker/topic.
            happyPathRouter.markerCalls = (happyPathRouter.markerCalls || 0) + 1;
            return happyPathRouter.markerCalls % 2 === 1 ? 0 : 1;
        }
        // <xhs-publish-btn> invoke.
        if (code.includes('xhs-publish-btn'))
            return { ok: true, via: 'method', name: '_onPublish' };
        // Success-marker scan.
        if (code.includes('for (const el of document.querySelectorAll'))
            return successText;
        throw new Error(`Unhandled evaluate call: ${code.slice(0, 140)}`);
    };
}

describe('xiaohongshu publish-video', () => {
    it('registers with the video positional first and the shared publish columns', () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        expect(cmd?.args.map((arg) => arg.name)).toEqual([
            'video',
            'title',
            'description',
            'tags',
            'topics',
            'cover',
            'schedule',
            'account',
            'draft',
            'timeout',
        ]);
        expect(cmd?.columns).toEqual(['ok', 'platform', 'status', 'code', 'capability', 'message', 'url', 'draft']);
        expect(cmd?.domain).toBe('creator.xiaohongshu.com');
        expect(cmd?.access).toBe('write');
        expect(cmd?.browser).toBe(true);
    });

    it('requires a terminal publish signal instead of upload/progress copy', () => {
        const url = 'https://creator.xiaohongshu.com/publish/publish?target=video';
        expect(__test__.classifyVideoPublishState({ url, text: '上传成功', isDraft: false }))
            .toMatchObject({ pending: true });
        expect(__test__.classifyVideoPublishState({ url, text: '发布中，请稍候', isDraft: false }))
            .toMatchObject({ pending: true });
        expect(__test__.classifyVideoPublishState({ url, text: '上传成功\n发布成功', isDraft: false }))
            .toMatchObject({ ok: true });
    });

    it('accepts only known result routes after submit', () => {
        expect(__test__.classifyVideoPublishState({
            url: 'https://creator.xiaohongshu.com/new/note-manager',
            text: '',
            isDraft: false,
        })).toMatchObject({ ok: true });
        expect(__test__.classifyVideoPublishState({
            url: 'https://creator.xiaohongshu.com/dashboard',
            text: '',
            isDraft: false,
        })).toMatchObject({ error: 'platform' });
        expect(__test__.classifyVideoPublishState({
            url: 'https://www.xiaohongshu.com/login',
            text: '',
            isDraft: false,
        })).toMatchObject({ error: 'auth' });
    });

    it('does not treat normal video-duration copy as an upload failure', () => {
        expect(__test__.hasVideoUploadFailure('视频时长：5 分钟')).toBe(false);
        expect(__test__.hasVideoUploadFailure('视频时长不得超过 15 分钟')).toBe(false);
        expect(__test__.hasVideoUploadFailure('视频时长超过限制')).toBe(true);
        expect(__test__.hasVideoUploadFailure('视频过短，请重新上传')).toBe(true);
    });

    it('rejects a missing video file path before navigating', async () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const page = createConditionalPageMock(() => {
            throw new Error('should not evaluate when input validation fails');
        });
        await expect(cmd.func(page, { title: 't', video: '' })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('rejects a video path that does not exist', async () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const page = createConditionalPageMock(() => '');
        await expect(cmd.func(page, { title: 't', video: '/no/such/clip.mp4' }))
            .rejects.toThrow('video file does not exist');
    });

    it('rejects an unsupported video extension', async () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const badFile = makeVideo('.avi');
        const page = createConditionalPageMock(() => '');
        await expect(cmd.func(page, { title: 't', video: badFile }))
            .rejects.toThrow('unsupported video format');
    });

    it('rejects a title longer than 20 characters', async () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const page = createConditionalPageMock(() => '');
        await expect(cmd.func(page, { title: '一二三四五六七八九十一二三四五六七八九十一', video }))
            .rejects.toThrow('exceeds 20 characters');
    });

    it('returns unsupported_capability for --cover', async () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const cover = makeVideo('.jpg');
        const page = createConditionalPageMock(() => '');
        const result = await cmd.func(page, { title: 't', video, cover });
        expect(result[0]).toMatchObject({ ok: false, status: 'unsupported', capability: 'cover' });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('returns unsupported_capability for --schedule', async () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const page = createConditionalPageMock(() => '');
        const result = await cmd.func(page, { title: 't', video, schedule: '2099-01-01T00:00:00Z' });
        expect(result[0]).toMatchObject({ ok: false, status: 'unsupported', capability: 'schedule' });
    });

    it('returns unsupported_capability for --account', async () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const page = createConditionalPageMock(() => '');
        const result = await cmd.func(page, { title: 't', video, account: 'alt' });
        expect(result[0]).toMatchObject({ ok: false, status: 'unsupported', capability: 'account' });
    });

    it('fails with a re-capture hint when redirected away from creator center', async () => {
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const page = createConditionalPageMock((code) => {
            if (code.includes('location.href')) return 'https://www.xiaohongshu.com/login';
            throw new Error(`Unexpected evaluate: ${code.slice(0, 80)}`);
        });
        await expect(cmd.func(page, { title: 't', video }))
            .rejects.toThrow('Re-capture browser login');
    });

    it('uploads via CDP setFileInput and publishes successfully', async () => {
        happyPathRouter.markerCalls = 0;
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const setFileInput = vi.fn().mockResolvedValue(undefined);
        const page = createConditionalPageMock(happyPathRouter({ titleActual: '我的视频', bodyActual: '正文内容' }), { setFileInput });
        const result = await cmd.func(page, {
            title: '我的视频',
            description: '正文内容',
            video,
            timeout: 300,
        });
        expect(setFileInput).toHaveBeenCalledWith(
            [video],
            expect.stringContaining('input[type="file"][accept*="video"]'),
        );
        expect(result[0]).toMatchObject({ ok: true, platform: 'xiaohongshu', status: 'success', draft: false });
        expect(result[0].message).toContain('我的视频');
    });

    it('clears a restored draft body when description is empty', async () => {
        happyPathRouter.markerCalls = 0;
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const insertText = vi.fn().mockResolvedValue(undefined);
        const page = createConditionalPageMock(
            happyPathRouter({ titleActual: '视频标题', bodyActual: '' }),
            { insertText },
        );
        const result = await cmd.func(page, {
            title: '视频标题',
            description: '',
            video,
        });
        expect(insertText).toHaveBeenCalledWith('');
        expect(result[0]).toMatchObject({ ok: true, status: 'success' });
    });

    it('attaches topics via the inline # flow and reports them', async () => {
        happyPathRouter.markerCalls = 0;
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const insertText = vi.fn().mockResolvedValue(undefined);
        const pressKey = vi.fn().mockResolvedValue(undefined);
        const page = createConditionalPageMock(happyPathRouter(), { insertText, pressKey });
        const result = await cmd.func(page, {
            title: '视频标题',
            description: '视频正文',
            topics: 'AI,效率',
            video,
        });
        expect(insertText).toHaveBeenCalledWith('#AI');
        expect(insertText).toHaveBeenCalledWith('#效率');
        expect(result[0].message).toContain('话题: AI 效率');
    });

    it('routes to the DRAFT method names when --draft is set', async () => {
        happyPathRouter.markerCalls = 0;
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        let draftInvoke = null;
        const router = happyPathRouter({ successText: '草稿已保存' });
        const page = createConditionalPageMock((code) => {
            if (code.includes('xhs-publish-btn')) {
                // The invoke script embeds the label config; assert draft labels flow through.
                draftInvoke = code;
                return { ok: true, via: 'method', name: '_onSaveDraft' };
            }
            return router(code);
        });
        const result = await cmd.func(page, {
            title: '草稿视频',
            description: '正文',
            video,
            draft: true,
        });
        expect(draftInvoke).toContain('暂存离开');
        expect(result[0]).toMatchObject({ ok: true, draft: true });
        expect(result[0].message).toContain('暂存成功');
    });

    it('throws a typed upload_failed when the page reports a transcode failure', async () => {
        happyPathRouter.markerCalls = 0;
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const page = createConditionalPageMock((code) => {
            if (code.includes('location.href'))
                return 'https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=video';
            if (code.includes("const targets = ['上传视频', '视频']"))
                return { ok: true, target: '上传视频', text: '上传视频' };
            if (code.includes('hasTitleInput') && code.includes('hasVideoSurface'))
                return { state: 'video_surface', hasTitleInput: false, hasImageInput: false, hasVideoSurface: true };
            if (code.includes('.find((selector) =>'))
                return 'input[type="file"][accept*="video"]';
            if (code.includes('__opencli_xhs_video_upload_state'))
                return { error: 'upload', message: '转码失败，请重试' };
            throw new Error(`Unexpected evaluate: ${code.slice(0, 80)}`);
        });
        await expect(cmd.func(page, { title: 't', video }))
            .rejects.toBeInstanceOf(CliError);
    });

    it('fails when it cannot leave the 图文 surface', async () => {
        happyPathRouter.markerCalls = 0;
        const cmd = getRegistry().get('xiaohongshu/publish-video');
        const video = makeVideo();
        const page = createConditionalPageMock((code) => {
            if (code.includes('location.href'))
                return 'https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=video';
            if (code.includes("const targets = ['上传视频', '视频']"))
                return { ok: false, visibleTexts: ['上传图文', '图片'] };
            if (code.includes('hasTitleInput') && code.includes('hasVideoSurface'))
                return { state: 'image_surface', hasTitleInput: false, hasImageInput: true, hasVideoSurface: false };
            throw new Error(`Unexpected evaluate: ${code.slice(0, 80)}`);
        });
        await expect(cmd.func(page, { title: 't', video }))
            .rejects.toThrow('still on 图文');
    });
});
