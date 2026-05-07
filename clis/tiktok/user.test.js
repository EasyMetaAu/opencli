import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { userCommand, __test__ } from './user.js';

function makePage(rows = []) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(rows),
    };
}

describe('tiktok/user', () => {
    it('uses page-context APIs instead of network interception', () => {
        expect(userCommand.access).toBe('read');
        expect(userCommand.browser).toBe(true);
        expect(userCommand.strategy).toBe('cookie');
        expect(userCommand.pipeline).toBeUndefined();
        expect(userCommand.columns).toEqual([
            'index',
            'id',
            'url',
            'cover',
            'title',
            'desc',
            'plays',
            'likes',
            'comments',
            'shares',
            'createTime',
        ]);
    });

    it('validates username and limit before navigation', async () => {
        const page = makePage();

        await expect(userCommand.func(page, { username: '', limit: 1 })).rejects.toBeInstanceOf(ArgumentError);
        await expect(userCommand.func(page, { username: '@bad/user', limit: 1 })).rejects.toBeInstanceOf(ArgumentError);
        await expect(userCommand.func(page, { username: 'dictogo', limit: 0 })).rejects.toBeInstanceOf(ArgumentError);
        await expect(userCommand.func(page, { username: 'dictogo', limit: 121 })).rejects.toBeInstanceOf(ArgumentError);

        expect(page.goto).not.toHaveBeenCalled();
    });

    it('navigates to the profile and merges exact-author fallback rows when the profile API is partial', async () => {
        const profileRow = {
            index: 1,
            id: '7350000000000000000',
            url: 'https://www.tiktok.com/@dictogo/video/7350000000000000000',
            cover: 'https://example.invalid/cover.jpg',
            title: 'hello world',
            desc: 'hello world',
            plays: 123,
            likes: 12,
            comments: 3,
            shares: 4,
            createTime: 1710000000,
        };
        const fallbackRow = { ...profileRow, index: 2, id: '7350000000000000001', createTime: 1700000000 };
        const page = makePage();
        page.evaluate.mockResolvedValueOnce([profileRow]).mockResolvedValueOnce([fallbackRow]);

        await expect(userCommand.func(page, { username: '@dictogo', limit: 2 })).resolves.toEqual([profileRow, fallbackRow]);
        expect(page.goto).toHaveBeenCalledWith('https://www.tiktok.com/@dictogo', { waitUntil: 'load', settleMs: 6000 });
        expect(page.goto).toHaveBeenCalledWith('https://www.tiktok.com/explore', { waitUntil: 'load', settleMs: 5000 });
        expect(page.evaluate.mock.calls[0][0]).toContain('/api/post/item_list/');
        expect(page.evaluate.mock.calls[0][0]).toContain('/api/user/detail/');
        expect(page.evaluate.mock.calls[1][0]).toContain('/api/search/general/full/');
    });

    it('maps page context failures to command execution errors', async () => {
        const page = makePage();
        page.evaluate
            .mockRejectedValueOnce(new Error('No videos found for @dictogo'))
            .mockRejectedValueOnce(new Error('search failed'));

        await expect(userCommand.func(page, { username: 'dictogo', limit: 1 })).rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('keeps helper output free from intercept capture logic', () => {
        const script = __test__.buildUserVideosScript('dictogo', 20);

        expect(script).not.toContain('No network capture');
        expect(script).not.toContain('querySelectorAll(\'a[href*="/video/"]\')');
        expect(__test__.normalizeUsername('@dictogo')).toBe('dictogo');
        expect(__test__.requireLimit(undefined)).toBe(20);
    });
});
