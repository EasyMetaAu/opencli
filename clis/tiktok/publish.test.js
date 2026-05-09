import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
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
        async wait() {},
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
        await expect(publishCommand.func({}, { video, title: 'x', schedule: '2026-01-01T00:00:00Z' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'schedule' }]);
        await expect(publishCommand.func({}, { video, title: 'x', cover: '/tmp/cover.png' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'cover' }]);
        await expect(publishCommand.func({}, { video, title: 'x', privacy: 'private' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'privacy' }]);
    });

    it('maps auth and platform failures from publish polling', async () => {
        await expect(__test__.waitForTikTokPublishResult(pageReturning({ error: 'auth', message: 'login' }))).rejects.toBeInstanceOf(AuthRequiredError);
        await expect(__test__.waitForTikTokPublishResult(pageReturning({ error: 'platform', message: 'upload failed' }))).rejects.toBeInstanceOf(CommandExecutionError);
    });

});
