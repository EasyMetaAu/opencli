import { describe, expect, it } from 'vitest';
import { __test__ } from './channel.js';

function tab(title, contents, selected = false, overrides = {}) {
    return {
        tabRenderer: {
            title,
            selected,
            content: {
                richGridRenderer: {
                    contents,
                },
            },
            ...overrides,
        },
    };
}

function browseData(tabs) {
    return {
        contents: {
            twoColumnBrowseResultsRenderer: {
                tabs,
            },
        },
    };
}

describe('youtube channel helpers', () => {
    it('uses the selected rich-grid tab instead of the first tab', () => {
        const home = [{ richItemRenderer: { content: { videoRenderer: { videoId: 'home' } } } }];
        const videos = [{ richItemRenderer: { content: { videoRenderer: { videoId: 'videos' } } } }];

        expect(__test__.extractSelectedRichGridContents(browseData([
            tab('Home', home),
            tab('Videos', videos, true),
        ]))).toBe(videos);
    });

    it('falls back to the first non-empty rich-grid tab when no tab is selected', () => {
        const videos = [{ richItemRenderer: { content: { videoRenderer: { videoId: 'only' } } } }];

        expect(__test__.extractSelectedRichGridContents(browseData([
            tab('Home', []),
            tab('Videos', videos),
        ]))).toBe(videos);
    });

    it('is self-contained for browser evaluate injection', () => {
        const extractSelectedRichGridContents = Function(
            `return ${__test__.extractSelectedRichGridContents.toString()}`
        )();
        const videos = [{ richItemRenderer: { content: { videoRenderer: { videoId: 'serialized' } } } }];

        expect(extractSelectedRichGridContents(browseData([
            tab('Home', []),
            tab('Videos', videos, true),
        ]))).toEqual(videos);
    });

    it('detects shorts channel URLs and tab renderers', () => {
        expect(__test__.isShortsInput('https://www.youtube.com/@openai/shorts')).toBe(true);
        expect(__test__.isShortsInput('@openai/shorts')).toBe(true);
        expect(__test__.isShortsInput('@openai/videos')).toBe(false);
        expect(__test__.getChannelResolveUrl('https://www.youtube.com/@openai/shorts?view=0')).toBe('https://www.youtube.com/@openai/shorts');
        expect(__test__.getChannelResolveUrl('@openai/shorts')).toBe('https://www.youtube.com/@openai/shorts');
        expect(__test__.isShortsTab(tab('Shorts', [], false, {
            tabIdentifier: 'SHORTS',
            endpoint: { commandMetadata: { webCommandMetadata: { url: '/@openai/shorts' } } },
        }))).toBe(true);
    });


    it('extracts channel stats from pageHeaderRenderer metadata rows', () => {
        const stats = __test__.extractChannelStats({
            header: {
                pageHeaderRenderer: {
                    content: {
                        pageHeaderViewModel: {
                            metadata: {
                                contentMetadataViewModel: {
                                    metadataRows: [
                                        {
                                            metadataParts: [
                                                {
                                                    text: {
                                                        content: '1.2M',
                                                        accessibility: {
                                                            accessibilityData: { label: '1.2M subscribers' },
                                                        },
                                                    },
                                                },
                                                { text: { simpleText: '321 videos' } },
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
            },
        });

        expect(stats).toEqual({ subscribers: '1.2M subscribers', videoCount: '321 videos' });
    });

    it('extracts channel stats from old c4TabbedHeaderRenderer fields', () => {
        const stats = __test__.extractChannelStats({
            header: {
                c4TabbedHeaderRenderer: {
                    subscriberCountText: { simpleText: '42K subscribers' },
                    videosCountText: { runs: [{ text: '18' }, { text: ' videos' }] },
                },
            },
        });

        expect(stats).toEqual({ subscribers: '42K subscribers', videoCount: '18 videos' });
    });

    it('extracts localized Chinese subscriber and video counts', () => {
        const stats = __test__.extractChannelStats({
            pageHeaderRenderer: {
                content: {
                    pageHeaderViewModel: {
                        metadata: {
                            contentMetadataViewModel: {
                                metadataRows: [
                                    {
                                        metadataParts: [
                                            { text: { simpleText: '12万位订阅者' } },
                                            { text: { runs: [{ text: '456' }, { text: ' 个视频' }] } },
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });

        expect(stats).toEqual({ subscribers: '12万位订阅者', videoCount: '456 个视频' });
    });

    it('returns explicit empty strings when channel count fields are missing', () => {
        expect(__test__.extractChannelStats({ header: { pageHeaderRenderer: {} } })).toEqual({
            subscribers: '',
            videoCount: '',
        });
        expect(__test__.formatChannelRows({ name: 'No Counts', subscribers: '', videoCount: '' })).toEqual([
            { field: 'name', value: 'No Counts' },
            { field: 'subscribers', value: '' },
            { field: 'videoCount', value: '' },
        ]);
    });

    it('extracts shortsLockupViewModel items separately from videoRenderer items', () => {
        const short = __test__.extractShortsLockupVideo({
            richItemRenderer: {
                content: {
                    shortsLockupViewModel: {
                        entityId: 'shorts-shelf-item-fallback-id',
                        overlayMetadata: {
                            primaryText: { content: 'A short title' },
                            secondaryText: { content: '42K views' },
                        },
                        onTap: {
                            innertubeCommand: {
                                reelWatchEndpoint: { videoId: 'short-video-id' },
                            },
                        },
                    },
                },
            },
        });

        expect(short).toEqual({
            videoId: 'short-video-id',
            title: 'A short title',
            duration: 'Shorts',
            views: '42K views',
            url: 'https://www.youtube.com/shorts/short-video-id',
        });
        expect(__test__.extractRichGridVideo({ richItemRenderer: { content: { shortsLockupViewModel: {} } } })).toBeNull();
    });

    it('keeps field/value compatibility while exposing stable shorts JSON fields', () => {
        const rows = __test__.formatChannelRows({
            name: 'OpenAI',
            recentVideos: [
                {
                    videoId: 'short-video-id',
                    title: 'A short title',
                    duration: 'Shorts',
                    views: '42K views',
                    url: 'https://www.youtube.com/shorts/short-video-id',
                },
            ],
        });

        const shortRow = rows.find(row => row.type === 'shorts');
        expect(shortRow).toMatchObject({
            field: 'A short title',
            value: 'Shorts | 42K views | https://www.youtube.com/shorts/short-video-id',
            type: 'shorts',
            videoId: 'short-video-id',
            title: 'A short title',
            viewCount: '42K views',
            url: 'https://www.youtube.com/shorts/short-video-id',
        });
        expect(shortRow.value).not.toContain(' | short-video-id | ');
    });

    it('does not add shorts-only JSON fields to normal channel video rows', () => {
        const rows = __test__.formatChannelRows({
            name: 'OpenAI',
            recentVideos: [
                {
                    videoId: 'normal-video-id',
                    title: 'A normal video',
                    duration: '10:00',
                    views: '1K views',
                    url: 'https://www.youtube.com/watch?v=normal-video-id',
                },
            ],
        });

        const videoRow = rows.find(row => row.field === 'A normal video');
        expect(videoRow).toEqual({
            field: 'A normal video',
            value: '10:00 | 1K views | https://www.youtube.com/watch?v=normal-video-id',
        });
    });
});
