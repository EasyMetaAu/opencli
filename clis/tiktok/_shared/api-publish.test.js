import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildProjectPostBody, waitForVideoId, __test__ } from './api-publish.js';

const { buildTextExtra, VISIBILITY_TYPE } = __test__;

describe('tiktok api-publish: waitForVideoId (page-hook poll)', () => {
    // The vid hook stashes { video_id, ... } on window.__ttUploadVid; waitForVideoId
    // reads it via page.evaluate('window.__ttUploadVid || null'). Mock that.
    function hookPage(sequence) {
        // sequence: array of successive values returned by evaluate() across polls
        let i = 0;
        return {
            async evaluate() { const v = sequence[Math.min(i, sequence.length - 1)]; i += 1; return v; },
            async wait() {},
        };
    }

    it('resolves once the hook exposes a vid', async () => {
        const page = hookPage([null, null, { video_id: 'v12025gd0000dTEST', width: 1080, height: 1920, duration: 20 }]);
        const info = await waitForVideoId(page, { timeoutMs: 5000, pollMs: 1 });
        expect(info).toMatchObject({ video_id: 'v12025gd0000dTEST', width: 1080, height: 1920 });
    });

    it('unwraps the Browser Bridge {session,data} envelope', async () => {
        const page = hookPage([{ session: 's', data: { video_id: 'v_envelope000000' } }]);
        const info = await waitForVideoId(page, { timeoutMs: 5000, pollMs: 1 });
        expect(info.video_id).toBe('v_envelope000000');
    });

    it('throws if no vid appears before the timeout', async () => {
        const page = hookPage([null]);
        await expect(waitForVideoId(page, { timeoutMs: 30, pollMs: 5 })).rejects.toThrow(/did not yield a video_id/);
    });
});

describe('tiktok api-publish: XHR upload progress hook', () => {
    it('records advancing upload bytes for the shared stall deadline', () => {
        const dom = new JSDOM('<!doctype html>', { url: 'https://www.tiktok.com/tiktokstudio/upload', runScripts: 'outside-only' });
        class FakeXhr {
            static last;
            upload = { addEventListener: (name, fn) => { this.uploadListener = name === 'progress' ? fn : this.uploadListener; } };
            addEventListener() {}
            open(_method, url) { this.url = url; }
            send() { FakeXhr.last = this; }
        }
        dom.window.XMLHttpRequest = FakeXhr;
        dom.window.eval(__test__.installVidHookScript());

        const xhr = new dom.window.XMLHttpRequest();
        xhr.open('POST', 'https://tos19-up-useast1a.tiktokcdn-us.com/upload/v1/tos-test');
        xhr.send();
        xhr.uploadListener({ loaded: 42, total: 100, lengthComputable: true });

        expect(dom.window.__ttUploadProgress).toMatchObject({ loaded: 42, total: 100 });
    });

    it('ignores progress from an XHR that belongs to an older upload attempt', () => {
        const dom = new JSDOM('<!doctype html>', { url: 'https://www.tiktok.com/tiktokstudio/upload', runScripts: 'outside-only' });
        class FakeXhr {
            upload = { addEventListener: (name, fn) => { this.uploadListener = name === 'progress' ? fn : this.uploadListener; } };
            addEventListener() {}
            open(_method, url) { this.url = url; }
            send() {}
        }
        dom.window.XMLHttpRequest = FakeXhr;
        dom.window.eval(__test__.installVidHookScript());
        dom.window.eval(__test__.resetUploadCaptureScript('old-attempt'));
        const oldXhr = new dom.window.XMLHttpRequest();
        oldXhr.open('POST', 'https://tos19-up-useast1a.tiktokcdn-us.com/upload/v1/tos-old');
        oldXhr.send();

        dom.window.eval(__test__.resetUploadCaptureScript('new-attempt'));
        oldXhr.uploadListener({ loaded: 99, total: 100, lengthComputable: true });

        expect(dom.window.__ttUploadProgress).toBeNull();
        expect(dom.window.__ttUploadAttempt).toBe('new-attempt');
    });

    it('aggregates progress across chunk XHRs whose loaded counters restart at zero', () => {
        const dom = new JSDOM('<!doctype html>', { url: 'https://www.tiktok.com/tiktokstudio/upload', runScripts: 'outside-only' });
        class FakeXhr {
            upload = { addEventListener: (name, fn) => { this.uploadListener = name === 'progress' ? fn : this.uploadListener; } };
            addEventListener() {}
            open(_method, url) { this.url = url; }
            send() {}
        }
        dom.window.XMLHttpRequest = FakeXhr;
        dom.window.eval(__test__.installVidHookScript());
        dom.window.eval(__test__.resetUploadCaptureScript('chunked-attempt'));

        const first = new dom.window.XMLHttpRequest();
        first.open('POST', 'https://tos19-up-useast1a.tiktokcdn-us.com/upload/v1/tos-chunk-1');
        first.send();
        first.uploadListener({ loaded: 100, total: 100, lengthComputable: true });

        const second = new dom.window.XMLHttpRequest();
        second.open('POST', 'https://tos19-up-useast1a.tiktokcdn-us.com/upload/v1/tos-chunk-2');
        second.send();
        second.uploadListener({ loaded: 10, total: 100, lengthComputable: true });

        expect(dom.window.__ttUploadProgress).toMatchObject({ loaded: 110 });
    });
});

describe('tiktok api-publish: buildTextExtra', () => {
    it('extracts hashtags with correct offsets and markup', () => {
        const { text_extra, markup_text } = buildTextExtra('hello #foo world #bar');
        expect(text_extra).toEqual([
            { tag_id: '0', start: 6, end: 10, user_id: '', type: 1, hashtag_name: 'foo' },
            { tag_id: '1', start: 17, end: 21, user_id: '', type: 1, hashtag_name: 'bar' },
        ]);
        expect(markup_text).toBe('hello <h id="0">#foo</h> world <h id="1">#bar</h>');
    });

    it('handles text with no hashtags', () => {
        const { text_extra, markup_text } = buildTextExtra('plain caption');
        expect(text_extra).toEqual([]);
        expect(markup_text).toBe('plain caption');
    });

    it('preserves non-ascii hashtags and offsets', () => {
        const { text_extra, markup_text } = buildTextExtra('6月1日#得到的 #dictogo');
        expect(text_extra).toHaveLength(2);
        expect(text_extra[0].hashtag_name).toBe('得到的');
        expect(text_extra[1].hashtag_name).toBe('dictogo');
        expect(markup_text).toContain('<h id="0">#得到的</h>');
        expect(markup_text).toContain('<h id="1">#dictogo</h>');
    });
});

describe('tiktok api-publish: buildProjectPostBody', () => {
    const base = { creationId: 'pinabcd123', videoId: 'v12025gd0000test', text: 'hi #tag' };

    it('builds a publish-now body without schedule_time', () => {
        const body = buildProjectPostBody({ ...base, scheduleTime: 0 });
        expect(body.post_common_info.creation_id).toBe('pinabcd123');
        expect(body.post_common_info.post_type).toBe(3);
        const fc = body.feature_common_info_list[0];
        expect(fc).not.toHaveProperty('schedule_time');
        expect(fc.vedit_common_info.video_id).toBe('v12025gd0000test');
        expect(fc.privacy_setting_info.visibility_type).toBe(0);
        const sp = body.single_post_req_list[0];
        expect(sp.video_id).toBe('v12025gd0000test');
        expect(sp.single_post_feature_info.text).toBe('hi #tag');
        expect(sp.single_post_feature_info.text_extra).toHaveLength(1);
    });

    it('includes schedule_time (unix seconds) when scheduled', () => {
        const body = buildProjectPostBody({ ...base, scheduleTime: 1783655400 });
        expect(body.feature_common_info_list[0].schedule_time).toBe(1783655400);
    });

    it('maps privacy to visibility_type', () => {
        expect(VISIBILITY_TYPE).toEqual({ public: 0, friends: 1, private: 2 });
        expect(buildProjectPostBody({ ...base, privacy: 'private' }).feature_common_info_list[0].privacy_setting_info.visibility_type).toBe(2);
        expect(buildProjectPostBody({ ...base, privacy: 'friends' }).feature_common_info_list[0].privacy_setting_info.visibility_type).toBe(1);
    });

    it('omits cover_info (unverified minimal-cover assumption)', () => {
        const sp = buildProjectPostBody(base).single_post_req_list[0];
        expect(sp.single_post_feature_info).not.toHaveProperty('cover_info');
    });
});
