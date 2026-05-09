import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
    buildDescriptionWithTags,
    classifyPlatformFailure,
    requireBrowserUploadSupport,
    setFileInput,
    successResult,
    unsupportedResult,
    validateVideoPublishInput,
    visibleElementScript,
} from '../_shared/video-publish.js';

const PLATFORM = 'youtube';
const DOMAIN = 'studio.youtube.com';
const STUDIO_URL = 'https://studio.youtube.com';
const FILE_SELECTORS = [
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
];
const UPLOAD_TIMEOUT_MS = 240_000;
const POLL_MS = 1500;
const DIALOG_TIMEOUT_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 120_000;

function unsupportedForInput(input) {
    if (input.schedule) {
        return unsupportedResult(PLATFORM, 'schedule', 'YouTube publish adapter currently supports immediate publish only; scheduled publish is reported as unsupported.');
    }
    if (input.cover) {
        return unsupportedResult(PLATFORM, 'cover', 'YouTube thumbnail/cover upload is not automated yet; pass no --cover or handle thumbnail manually.');
    }
    if (input.account) {
        return unsupportedResult(PLATFORM, 'account', 'YouTube account/channel switching is not automated yet; use the active Studio channel.');
    }
    if (input.draft) {
        return unsupportedResult(PLATFORM, 'draft', 'YouTube explicit draft save is not automated yet; immediate publish is supported.');
    }
    return null;
}

async function assertYouTubeLoggedIn(page) {
    const state = await page.evaluate(`
        (() => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
            const url = location.href;
            if (/accounts\.google\.com|ServiceLogin/i.test(url) || /sign in|登录/i.test(text) && !/channel dashboard|studio|内容|信息中心/i.test(text)) {
                return { ok: false, message: 'YouTube Studio requires login' };
            }
            return { ok: true, url };
        })()
    `);
    if (!state?.ok) {
        throw new AuthRequiredError(DOMAIN, state?.message || 'YouTube Studio requires login');
    }
}

async function openUploadDialog(page) {
    const directInput = await page.evaluate(`(() => !!document.querySelector('input[type="file"]'))()`);
    if (directInput) return;

    const clicked = await page.evaluate(`
        (() => {
            ${visibleElementScript()}
            const direct = clickByLabels(['Upload videos', '上传视频']);
            if (direct.ok) return direct;
            const create = clickByLabels(['Create', '创建']);
            return create;
        })()
    `);
    if (clicked?.ok) {
        await page.wait({ time: 1 });
        const uploadClicked = await page.evaluate(`
            (() => {
                ${visibleElementScript()}
                return clickByLabels(['Upload videos', '上传视频']);
            })()
        `);
        if (uploadClicked?.ok) return;
    }
}

async function waitForDetailsDialog(page) {
    const deadline = Date.now() + DIALOG_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await page.evaluate(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
                if (/accounts\.google\.com|sign in|登录/i.test(location.href + ' ' + text) && !/video details|details|详情/i.test(text)) {
                    return { error: 'auth', message: 'YouTube Studio requires login' };
                }
                if (/daily upload limit|copyright strike|not eligible|上传失败|处理失败/i.test(text)) {
                    return { error: 'upload', message: text.slice(0, 500) };
                }
                const textboxes = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'));
                if (textboxes.length >= 1 && /details|video details|title|description|详情|标题|说明/i.test(text)) {
                    return { ok: true };
                }
                return null;
            })()
        `);
        if (result?.ok) return;
        classifyPlatformFailure(PLATFORM, DOMAIN, result, 'YouTube upload failed');
        await page.wait({ time: POLL_MS / 1000 });
    }
    throw new CommandExecutionError('YouTube upload details dialog did not appear before timeout');
}

async function fillYouTubeDetails(page, title, description) {
    const result = await page.evaluateWithArgs(`
        (() => {
            ${visibleElementScript()}
            const fields = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'))
                .filter(isVisible)
                .filter((el) => {
                    const label = (el.getAttribute('aria-label') || el.closest('[aria-label]')?.getAttribute('aria-label') || '').toLowerCase();
                    const text = (el.innerText || el.value || '').trim();
                    return !label.includes('search') && text.length < 5000;
                });
            if (fields.length < 1) return { error: 'platform', message: 'YouTube title field was not found' };
            setNativeText(fields[0], videoTitle);
            if (fields[1]) setNativeText(fields[1], videoDescription);
            return { ok: true, fields: fields.length };
        })()
    `, { videoTitle: title, videoDescription: description });
    classifyPlatformFailure(PLATFORM, DOMAIN, result, 'YouTube details fill failed');
}

async function chooseNotMadeForKids(page, madeForKids) {
    const labels = madeForKids
        ? ['Yes, it\'s made for kids', '是，为儿童打造']
        : ['No, it\'s not made for kids', '不是，不是为儿童打造', 'No, it is not made for kids'];
    const result = await page.evaluateWithArgs(`
        (() => {
            ${visibleElementScript()}
            const wanted = labels.map((label) => label.toLowerCase());
            const candidates = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, ytcp-radio-button, [role="radio"], label, div'));
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!text || text.length > 240 || !isVisible(el)) continue;
                if (wanted.some((label) => text.includes(label))) {
                    el.click();
                    return { ok: true, text };
                }
            }
            return { ok: false, message: 'made-for-kids radio was not found' };
        })()
    `, { labels });
    return result?.ok;
}

async function goThroughChecks(page, privacy) {
    await chooseNotMadeForKids(page, false);

    for (let i = 0; i < 3; i += 1) {
        const clicked = await page.evaluate(`
            (() => {
                ${visibleElementScript()}
                return clickByLabels(['Next', '下一步']);
            })()
        `);
        if (!clicked?.ok) break;
        await page.wait({ time: 1.2 });
    }

    if (privacy !== 'public') {
        const labels = privacy === 'private'
            ? ['Private', '私享', '私密']
            : ['Unlisted', '不公开列出'];
        await page.evaluateWithArgs(`
            (() => {
                ${visibleElementScript()}
                const wanted = labels.map((label) => label.toLowerCase());
                const radios = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, ytcp-radio-button, [role="radio"], label, div'));
                for (const el of radios) {
                    const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    if (text && text.length < 200 && isVisible(el) && wanted.some((label) => text.includes(label))) {
                        el.click();
                        return { ok: true, text };
                    }
                }
                return { ok: false };
            })()
        `, { labels });
    } else {
        await page.evaluate(`
            (() => {
                ${visibleElementScript()}
                const labels = ['Public', '公开'];
                const wanted = labels.map((label) => label.toLowerCase());
                const radios = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, ytcp-radio-button, [role="radio"], label, div'));
                for (const el of radios) {
                    const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    if (text && text.length < 200 && isVisible(el) && wanted.some((label) => text.includes(label))) {
                        el.click();
                        return { ok: true, text };
                    }
                }
                return { ok: false };
            })()
        `);
    }
}

async function clickPublish(page) {
    const result = await page.evaluate(`
        (() => {
            ${visibleElementScript()}
            return clickByLabels(['Publish', 'Save', '发布', '保存']);
        })()
    `);
    if (!result?.ok) {
        throw new CommandExecutionError(result?.message || 'YouTube publish/save button was not found');
    }
}

async function waitForYouTubePublishResult(page) {
    const deadline = Date.now() + PUBLISH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await page.evaluate(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const anchors = Array.from(document.querySelectorAll('a[href*="watch?v="], a[href*="youtu.be/"]')).map((a) => a.href).filter(Boolean);
                if (/video published|video is now public|upload complete|processing will begin|已发布|上传完成|处理完毕/i.test(text)) {
                    return { ok: true, url: anchors[0] || '', message: 'YouTube publish completed' };
                }
                if (anchors.length && /share|copy video link|视频链接|复制/i.test(text)) {
                    return { ok: true, url: anchors[0], message: 'YouTube publish completed' };
                }
                if (/sign in|session expired|登录|会话/i.test(text) && /accounts\.google\.com/i.test(location.href)) {
                    return { error: 'auth', message: 'YouTube login expired during publish' };
                }
                if (/failed|error|try again|copyright|policy|restriction|发布失败|上传失败|版权|违规/i.test(text)) {
                    return { error: 'platform', message: text.slice(0, 500) };
                }
                return null;
            })()
        `);
        if (result?.ok) return result;
        classifyPlatformFailure(PLATFORM, DOMAIN, result, 'YouTube publish failed');
        await page.wait({ time: POLL_MS / 1000 });
    }
    throw new CommandExecutionError('YouTube publish button clicked but result was unclear before timeout; check YouTube Studio manually.');
}

export const publishCommand = cli({
    site: 'youtube',
    name: 'publish',
    access: 'write',
    description: 'Upload and publish a local video to YouTube Studio and return a structured result',
    domain: DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: STUDIO_URL,
    args: [
        { name: 'video', required: true, positional: true, help: 'Local video file path (mp4/mov/m4v/webm)' },
        { name: 'title', required: true, help: 'Video title' },
        { name: 'description', default: '', help: 'Video description' },
        { name: 'tags', default: '', help: 'Comma-separated tags; written as hashtags in the description' },
        { name: 'cover', default: '', help: 'Thumbnail image path (currently returns unsupported_capability)' },
        { name: 'schedule', default: '', help: 'Scheduled publish time (currently returns unsupported_capability)' },
        { name: 'privacy', default: 'public', choices: ['public', 'unlisted', 'private'], help: 'YouTube visibility' },
        { name: 'account', default: '', help: 'Channel/account selector (currently returns unsupported_capability)' },
        { name: 'draft', type: 'bool', default: false, help: 'Save as draft (currently returns unsupported_capability)' },
    ],
    columns: ['ok', 'platform', 'status', 'code', 'capability', 'message', 'url', 'draft'],
    func: async (page, kwargs) => {
        const input = validateVideoPublishInput(kwargs, PLATFORM, {
            maxTitleLength: 100,
            maxDescriptionLength: 5000,
            validateCover: false,
        });
        const unsupported = unsupportedForInput(input);
        if (unsupported) return unsupported;

        await requireBrowserUploadSupport(page, PLATFORM);
        await page.goto(STUDIO_URL, { waitUntil: 'load', settleMs: 4000 });
        await assertYouTubeLoggedIn(page);
        await openUploadDialog(page);
        await setFileInput(page, [input.videoPath], FILE_SELECTORS, PLATFORM);
        await waitForDetailsDialog(page);

        const description = buildDescriptionWithTags(input.description, input.tags);
        await fillYouTubeDetails(page, input.title, description);
        await goThroughChecks(page, input.privacy);
        await clickPublish(page);
        const publishResult = await waitForYouTubePublishResult(page);

        return successResult(PLATFORM, publishResult.message || 'YouTube publish completed', {
            url: publishResult.url || '',
            draft: false,
        });
    },
});

export const __test__ = {
    unsupportedForInput,
    fillYouTubeDetails,
    waitForYouTubePublishResult,
};
