import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';
import { publishCommand, __test__ } from './publish.js';

function tempVideo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-youtube-publish-'));
    const file = path.join(dir, 'video.mp4');
    fs.writeFileSync(file, 'fake video');
    return file;
}

function pageReturning(result) {
    return {
        async evaluate() { return result; },
        async evaluateWithArgs() { return result; },
        async wait() {},
    };
}

describe('youtube publish adapter', () => {
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

    it('selects the made-for-kids radio by name once it mounts (even at rect 0×0)', async () => {
        // Flow: presence-probe → (present) → click pass → verify pass. The radio
        // mounts on the first probe; the name-anchored click no longer needs the
        // element to be laid out.
        const evaluateWithArgsResults = [
            true, // presence probe: nameSelector found in DOM
            { ok: true, via: 'attr', sel: '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]', checked: true }, // click pass
            { ok: true, via: 'attr', sel: '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]' }, // verify pass
        ];
        const page = {
            async evaluate() { return { ok: false }; },
            async evaluateWithArgs() { return evaluateWithArgsResults.shift(); },
            async wait() {},
        };
        await expect(__test__.chooseNotMadeForKids(page, false)).resolves.toMatchObject({ ok: true, via: 'attr' });
    });

    it('still requires privacy radio selection after optional audience skip', async () => {
        await expect(__test__.clickAndVerifyYouTubeRadio(
            pageReturning({ ok: false, message: 'privacy radio was not found' }),
            { nameSelectors: ['[name="PUBLIC"]'], labels: ['Public'], settingName: 'privacy', required: true },
        )).rejects.toMatchObject({ code: 'platform_error' });
    });

    it('selects a radio via its stable name attribute and confirms via read-back', async () => {
        // First evaluateWithArgs = click pass (attr hit); second = verify pass (aria-checked read-back).
        const results = [
            { ok: true, via: 'attr', sel: '[name="PUBLIC"]', checked: true },
            { ok: true, via: 'attr', sel: '[name="PUBLIC"]' },
        ];
        const page = {
            async evaluate() { return { ok: false }; },
            async evaluateWithArgs() { return results.shift(); },
            async wait() {},
        };
        await expect(__test__.clickAndVerifyYouTubeRadio(
            page,
            { nameSelectors: ['[name="PUBLIC"]'], labels: ['Public'], settingName: 'privacy', required: true },
        )).resolves.toMatchObject({ ok: true, via: 'attr' });
    });

    it('pages until the privacy radios appear (on the REVIEW step), waiting out processing', async () => {
        // The privacy radios live on the REVIEW step — there is no separate
        // VISIBILITY step. Page on privacyReady, tolerating the disabled-Continue
        // processing window on REVIEW. Sequence readWorkflowStep() will observe:
        const steps = [
            { present: true, step: 'DETAILS', privacyReady: false },
            { present: true, step: 'VIDEO_ELEMENTS', privacyReady: false },
            { present: true, step: 'CHECKS', privacyReady: false },
            { present: true, step: 'REVIEW', privacyReady: false }, // still processing
            { present: true, step: 'REVIEW', privacyReady: false }, // still processing
            { present: true, step: 'REVIEW', privacyReady: true },  // radios now on screen
        ];
        let i = 0;
        const clickCalls = [];
        const page = {
            // Both readWorkflowStep and the next-button click go through evaluate();
            // distinguish by script content. The probe reads workflow-step and
            // advances the sequence; the click just reports success.
            async evaluate(script) {
                if (/workflow-step/.test(script)) { const s = steps[Math.min(i, steps.length - 1)]; i += 1; return s; }
                clickCalls.push(script);
                return { ok: true };
            },
            async wait() {},
        };
        const result = await __test__.advanceToPrivacyStep(page);
        expect(result).toMatchObject({ privacyReady: true });
        expect(clickCalls.length).toBeGreaterThanOrEqual(3);
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
