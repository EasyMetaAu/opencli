import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import {
    buildDescriptionWithTags,
    classifyPlatformFailure,
    parseTags,
    requireBrowserUploadSupport,
    setFileInput,
    unsupportedResult,
    validateVideoPublishInput,
} from './video-publish.js';

function tempVideo(name = 'video.mp4') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-video-publish-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'fake video');
    return file;
}

describe('video publish shared helpers', () => {
    it('validates local video input and normalizes tags', () => {
        const video = tempVideo();
        const input = validateVideoPublishInput({
            video,
            title: 'Launch',
            description: 'Desc',
            tags: '#AI, ai, video',
        }, 'tiktok');

        expect(input.videoPath).toBe(video);
        expect(input.title).toBe('Launch');
        expect(input.tags).toEqual(['AI', 'video']);
        expect(buildDescriptionWithTags(input.description, input.tags)).toBe('Desc\n\n#AI #video');
    });

    it('rejects missing files, unsupported video extensions, empty title, and excessive tags', () => {
        expect(() => validateVideoPublishInput({ video: '/no/such/video.mp4', title: 'x' }, 'youtube')).toThrow(ArgumentError);
        expect(() => validateVideoPublishInput({ video: tempVideo('video.txt'), title: 'x' }, 'youtube')).toThrow(ArgumentError);
        expect(() => validateVideoPublishInput({ video: tempVideo(), title: '' }, 'youtube')).toThrow(ArgumentError);
        expect(() => parseTags(Array.from({ length: 31 }, (_, i) => `tag${i}`).join(','))).toThrow(ArgumentError);
    });

    it('returns a structured unsupported capability result', () => {
        expect(unsupportedResult('youtube', 'schedule', 'not yet')).toEqual([{
            ok: false,
            platform: 'youtube',
            status: 'unsupported',
            code: 'unsupported_capability',
            capability: 'schedule',
            message: 'not yet',
            url: '',
            draft: false,
        }]);
    });

    it('classifies browser capability and upload failures with stable codes', async () => {
        await expect(requireBrowserUploadSupport({}, 'tiktok')).rejects.toMatchObject({ code: 'browser_unsupported' });
        await expect(setFileInput({
            async evaluate() { return 'input[type=\"file\"]'; },
            async wait() {},
        }, ['video.mp4'], ['input[type=\"file\"]'], 'youtube')).rejects.toMatchObject({ code: 'upload_failed' });
        expect(() => classifyPlatformFailure('youtube', 'studio.youtube.com', { error: 'upload', message: 'upload failed' })).toThrowError(/upload failed/);
        try {
            classifyPlatformFailure('youtube', 'studio.youtube.com', { error: 'upload', message: 'upload failed' });
        } catch (error) {
            expect(error).toMatchObject({ code: 'upload_failed' });
        }
        try {
            classifyPlatformFailure('youtube', 'studio.youtube.com', { error: 'platform', message: 'studio rejected' });
        } catch (error) {
            expect(error).toMatchObject({ code: 'platform_error' });
        }
    });
});
