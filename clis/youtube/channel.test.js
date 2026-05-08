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
});
