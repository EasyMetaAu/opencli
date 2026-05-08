import { describe, expect, it, vi } from 'vitest';
import {
    ArgumentError,
    AuthRequiredError,
    CommandExecutionError,
    EmptyResultError,
} from '@jackwener/opencli/errors';
import { userCommand, __test__ } from './user.js';

const sampleUserVideoRow = {
    index: 1,
    id: '7350000000000000000',
    source: 'profile-api',
    author: 'dictogo',
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

function makePage(rows = []) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(rows),
    };
}

function makeFailingPage(error) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockRejectedValue(error),
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
            'source',
            'author',
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
        await expect(userCommand.func(page, { username: 'dictogo', limit: __test__.MAX_LIMIT + 1 })).rejects.toBeInstanceOf(ArgumentError);

        expect(page.goto).not.toHaveBeenCalled();
    });

    it('navigates to the profile and returns sourced video rows', async () => {
        const page = makePage([sampleUserVideoRow]);

        await expect(userCommand.func(page, { username: '@dictogo', limit: 2 })).resolves.toEqual([sampleUserVideoRow]);
        expect(page.goto).toHaveBeenCalledWith('https://www.tiktok.com/@dictogo', { waitUntil: 'load', settleMs: 6000 });
        expect(page.evaluate.mock.calls[0][0]).toContain('/api/post/item_list/');
        expect(page.evaluate.mock.calls[0][0]).toContain('/api/user/detail/');
        expect(page.evaluate.mock.calls[0][0]).toContain('/api/search/general/full/');
    });

    it('maps page context failures to typed errors', async () => {
        await expect(userCommand.func(makePage([]), { username: 'dictogo', limit: 1 })).rejects.toBeInstanceOf(EmptyResultError);
        await expect(userCommand.func(makeFailingPage(new Error('No videos found for @dictogo')), { username: 'dictogo', limit: 1 })).rejects.toBeInstanceOf(EmptyResultError);
        await expect(userCommand.func(makeFailingPage(new Error('No videos found for @dictogo (profile/search API failed: HTTP 500)')), { username: 'dictogo', limit: 1 })).rejects.toBeInstanceOf(CommandExecutionError);
        await expect(userCommand.func(makeFailingPage(new Error('No videos found for @dictogo (profile/search API failed: HTTP 403)')), { username: 'dictogo', limit: 1 })).rejects.toBeInstanceOf(AuthRequiredError);
        await expect(userCommand.func(makeFailingPage(new Error('No videos found for @dictogo (profile/search API failed: invalid JSON)')), { username: 'dictogo', limit: 1 })).rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('keeps helper output free from intercept capture logic', () => {
        const script = __test__.buildUserScript('dictogo', 20);

        expect(script).not.toContain('No network capture');
        expect(script).not.toContain('querySelectorAll(\'a[href*="/video/"]\')');
        expect(script).toContain("assertTikTokApiSuccess(detail, 'user-detail')");
        expect(script).toContain("assertTikTokApiSuccess(data, 'post-list')");
        expect(script).toContain("assertTikTokApiSuccess(data, 'search')");
        expect(script).toContain("'profile-api'");
        expect(script).toContain("'bootstrap'");
        expect(script).toContain("'search-fallback'");
    });

    it('replaces a low-quality bootstrap row with a more complete profile-api row for the same id', async () => {
        const videoId = '7350000000000000000';
        const bootstrapRow = {
            id: videoId,
            author: { uniqueId: 'dictogo', secUid: 'sec-1' },
            desc: 'bootstrap title only',
            createTime: 1710000000,
        };
        const profileApiRow = {
            id: videoId,
            author: { uniqueId: 'dictogo', secUid: 'sec-1' },
            desc: 'profile api complete row',
            createTime: 1710000100,
            video: { cover: 'https://example.invalid/profile-cover.jpg' },
            stats: { playCount: 456, diggCount: 45, commentCount: 6, shareCount: 7 },
        };
        const universal = {
            userInfo: { user: { uniqueId: 'dictogo', secUid: 'sec-1' } },
            itemList: [bootstrapRow],
        };
        const fetchMock = vi.fn(async (url) => {
            const requestUrl = String(url);
            if (requestUrl.includes('/api/post/item_list/')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ status_code: 0, itemList: [profileApiRow], hasMore: false }) };
            }
            if (requestUrl.includes('/api/search/general/full/')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ status_code: 0, data: [] }) };
            }
            throw new Error(`unexpected fetch ${requestUrl}`);
        });

        vi.stubGlobal('document', {
            cookie: '',
            querySelectorAll: () => [{ textContent: JSON.stringify(universal) }],
        });
        vi.stubGlobal('fetch', fetchMock);

        try {
            const rows = await Function(`return (${__test__.buildUserScript('dictogo', 2)})`)();

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                id: videoId,
                source: 'profile-api',
                title: 'profile api complete row',
                cover: 'https://example.invalid/profile-cover.jpg',
                plays: 456,
                likes: 45,
                comments: 6,
                shares: 7,
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
