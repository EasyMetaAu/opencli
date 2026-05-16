import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';
import {
    buildDescriptionWithTags,
    PUBLISH_ERROR_CODES,
    classifyPlatformFailure,
    throwPublishFailure,
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
const POLL_MS = 1500;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 420;


function requirePositiveTimeoutSeconds(value) {
    const parsed = Number(value ?? DEFAULT_COMMAND_TIMEOUT_SECONDS);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ArgumentError('youtube publish --timeout must be a positive integer (seconds)');
    }
    return parsed;
}

function timeoutMsFromSeconds(timeoutSeconds, fallbackMs) {
    const parsed = Number(timeoutSeconds);
    return Number.isInteger(parsed) && parsed > 0 ? parsed * 1000 : fallbackMs;
}

function createFlowDeadline(timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_SECONDS) {
    return Date.now() + timeoutMsFromSeconds(timeoutSeconds, DEFAULT_COMMAND_TIMEOUT_SECONDS * 1000);
}

function remainingTimeoutMs(deadlineMs) {
    return Math.max(0, Number(deadlineMs) - Date.now());
}

function browserLiteral(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function basename(filePath) {
    return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

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

async function collectUploadDiagnostics(page) {
    try {
        return await page.evaluate(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const textboxes = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'));
                const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map((input) => ({
                    count: input.files?.length || 0,
                    names: Array.from(input.files || []).map((file) => file.name).filter(Boolean),
                    accept: input.getAttribute('accept') || '',
                    visible: !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
                }));
                return {
                    pageUrl: location.href,
                    pageTitle: document.title || '',
                    dialogTitle: document.querySelector('ytcp-uploads-dialog #title, [role="dialog"] #title')?.innerText || '',
                    bodyText: text.slice(0, 1000),
                    inputs,
                    pickerVisible: /select files|选择文件|drag and drop|拖放/i.test(text) || !!document.querySelector('ytcp-uploads-file-picker'),
                    isDetailsReady: textboxes.length >= 1 && /details|video details|title|description|详情|标题|说明/i.test(text),
                };
            })()
        `);
    } catch (error) {
        return { diagnosticError: error instanceof Error ? error.message : String(error) };
    }
}

function formatUploadDiagnostics(diagnostics = {}) {
    const inputs = Array.isArray(diagnostics.inputs)
        ? diagnostics.inputs.map((input, index) => {
            const names = Array.isArray(input.names) && input.names.length ? input.names.join('|') : 'none';
            return `#${index}:count=${input.count || 0},names=${names},accept=${input.accept || 'none'}`;
        }).join('; ')
        : 'unknown';
    const text = String(diagnostics.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    return [
        `pageUrl=${diagnostics.pageUrl || 'unknown'}`,
        `dialogTitle=${diagnostics.dialogTitle || 'unknown'}`,
        `pickerVisible=${diagnostics.pickerVisible === true}`,
        `isDetailsReady=${diagnostics.isDetailsReady === true}`,
        `inputs=[${inputs}]`,
        diagnostics.diagnosticError ? `diagnosticError=${diagnostics.diagnosticError}` : '',
        text ? `bodyText="${text}"` : '',
    ].filter(Boolean).join('; ');
}

async function verifyYouTubeFileSelected(page, expectedPath) {
    const diagnostics = await collectUploadDiagnostics(page);
    if (diagnostics?.isDetailsReady) return diagnostics;

    const selectedInputs = Array.isArray(diagnostics?.inputs)
        ? diagnostics.inputs.filter((input) => Number(input.count) > 0)
        : [];
    if (selectedInputs.length === 0) {
        throwPublishFailure(
            PUBLISH_ERROR_CODES.uploadFailed,
            `YouTube upload failed: file input has no selected file after setFileInput (${formatUploadDiagnostics(diagnostics)})`,
        );
    }

    const expectedName = basename(expectedPath);
    const selectedNames = selectedInputs.flatMap((input) => Array.isArray(input.names) ? input.names : []);
    if (expectedName && selectedNames.length > 0 && !selectedNames.includes(expectedName)) {
        throwPublishFailure(
            PUBLISH_ERROR_CODES.uploadFailed,
            `YouTube upload failed: selected file name did not match ${expectedName} (${formatUploadDiagnostics(diagnostics)})`,
        );
    }
    return diagnostics;
}

async function waitForDetailsDialog(page, flowDeadlineMs = createFlowDeadline()) {
    while (Date.now() < flowDeadlineMs) {
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
        const waitMs = Math.min(POLL_MS, remainingTimeoutMs(flowDeadlineMs));
        if (waitMs > 0) await page.wait({ time: waitMs / 1000 });
    }
    const diagnostics = await collectUploadDiagnostics(page);
    throwPublishFailure(
        PUBLISH_ERROR_CODES.uploadFailed,
        `YouTube upload details dialog did not appear before timeout (${formatUploadDiagnostics(diagnostics)})`,
    );
}

async function fillYouTubeDetails(page, title, description) {
    const result = await page.evaluate(`
        (() => {
            const videoTitle = ${browserLiteral(title)};
            const videoDescription = ${browserLiteral(description)};
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
    `);
    classifyPlatformFailure(PLATFORM, DOMAIN, result, 'YouTube details fill failed');
}


function normalizeBodyText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

const PRIVACY_TEXT = {
    public: ['public', '公开'],
    unlisted: ['unlisted', '不公开列出'],
    private: ['private', '私享', '私密'],
};

function textMentionsPrivacy(text, privacy) {
    const normalized = normalizeBodyText(text).toLowerCase();
    return (PRIVACY_TEXT[privacy] || []).some((label) => normalized.includes(label.toLowerCase()));
}

function textMentionsOtherPrivacy(text, privacy) {
    return Object.keys(PRIVACY_TEXT).some((candidate) => candidate !== privacy && textMentionsPrivacy(text, candidate));
}

export function classifyYouTubePublishState({ text = '', anchors = [], privacy = 'public' } = {}) {
    const bodyText = normalizeBodyText(text);
    if (/sign in|session expired|登录|会话/i.test(bodyText)) {
        return { error: 'auth', message: 'YouTube login expired during publish' };
    }
    if (/failed|error|try again|copyright|policy|restriction|发布失败|上传失败|版权|违规/i.test(bodyText)) {
        return { error: 'platform', message: bodyText.slice(0, 500) };
    }

    const uploadOnly = /upload complete|processing will begin|上传完成|处理将开始/i.test(bodyText);
    const publishDone = /video published|published successfully|video is now public|changes saved|video saved|saved successfully|已发布|保存成功|已保存/i.test(bodyText);
    if (!publishDone) {
        return uploadOnly ? { pending: true, message: 'YouTube upload complete is not a publish success signal' } : null;
    }

    if (textMentionsOtherPrivacy(bodyText, privacy) && !textMentionsPrivacy(bodyText, privacy)) {
        return { error: 'platform', message: `YouTube publish completed with unexpected visibility; expected ${privacy}` };
    }
    return { ok: true, url: anchors[0] || '', message: 'YouTube publish completed' };
}

async function clickAndVerifyYouTubeRadio(page, labels, settingName, { required = true } = {}) {
    const result = await page.evaluate(`
        (() => {
            const radioLabels = ${browserLiteral(labels)};
            const settingName = ${browserLiteral(settingName)};
            ${visibleElementScript()}
            const wanted = radioLabels.map((label) => String(label).toLowerCase());
            const candidates = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, ytcp-radio-button, [role="radio"], label'));
            function isChecked(el) {
                return el.checked === true
                    || el.getAttribute('aria-checked') === 'true'
                    || el.getAttribute('checked') === 'true'
                    || el.hasAttribute('checked')
                    || el.classList?.contains('iron-selected')
                    || el.classList?.contains('checked');
            }
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!text || text.length > 240 || !isVisible(el)) continue;
                if (wanted.some((label) => text.includes(label))) {
                    el.click();
                    return { ok: true, text, checked: isChecked(el) };
                }
            }
            return { ok: false, message: settingName + ' radio was not found' };
        })()
    `);
    if (!result?.ok) {
        if (!required && /radio was not found/i.test(result?.message || '')) {
            return { ok: false, skipped: true, message: result?.message || `YouTube ${settingName} radio was not found` };
        }
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, result?.message || `YouTube ${settingName} radio was not found`);
    }

    await page.wait({ time: 0.3 });
    const verified = await page.evaluate(`
        (() => {
            const radioLabels = ${browserLiteral(labels)};
            const settingName = ${browserLiteral(settingName)};
            const wanted = radioLabels.map((label) => String(label).toLowerCase());
            const candidates = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, ytcp-radio-button, [role="radio"], label'));
            function radioSelected(el) {
                const nodes = [el, el.closest?.('[role="radio"]'), el.querySelector?.('[role="radio"]'), el.querySelector?.('input[type="radio"]')].filter(Boolean);
                return nodes.some((node) => node.checked === true
                    || node.getAttribute?.('aria-checked') === 'true'
                    || node.getAttribute?.('checked') === 'true'
                    || node.hasAttribute?.('checked')
                    || node.classList?.contains('iron-selected')
                    || node.classList?.contains('checked'));
            }
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!text || text.length > 240) continue;
                if (wanted.some((label) => text.includes(label)) && radioSelected(el)) {
                    return { ok: true, text };
                }
            }
            return { ok: false, message: settingName + ' radio selection could not be confirmed after click' };
        })()
    `);
    if (!verified?.ok) {
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, verified?.message || `YouTube ${settingName} radio selection could not be confirmed`);
    }
    return verified;
}

async function chooseNotMadeForKids(page, madeForKids) {
    const labels = madeForKids
        ? ['Yes, it\'s made for kids', '是，为儿童打造']
        : ['No, it\'s not made for kids', '不是，不是为儿童打造', 'No, it is not made for kids'];
    const selected = await clickAndVerifyYouTubeRadio(page, labels, 'made-for-kids', { required: false });
    if (selected?.ok) return selected;

    // YouTube's Shorts upload flow can omit the audience radio entirely. Try expanded sections
    // for normal videos, then continue so publish can reach the required privacy step.
    await page.evaluate(`
        (() => {
            ${visibleElementScript()}
            return clickByLabels(['Show more', 'More options', '显示更多', '展开更多', '更多选项']);
        })()
    `);
    await page.wait({ time: 0.3 });
    return clickAndVerifyYouTubeRadio(page, labels, 'made-for-kids', { required: false });
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

    const privacyLabels = privacy === 'private'
        ? ['Private', '私享', '私密']
        : privacy === 'unlisted'
            ? ['Unlisted', '不公开列出']
            : ['Public', '公开'];
    await clickAndVerifyYouTubeRadio(page, privacyLabels, 'privacy');
}

async function clickPublish(page) {
    const result = await page.evaluate(`
        (() => {
            ${visibleElementScript()}
            return clickByLabels(['Publish', 'Save', '发布', '保存']);
        })()
    `);
    if (!result?.ok) {
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, result?.message || 'YouTube publish/save button was not found');
    }
}

async function waitForYouTubePublishResult(page, privacy, flowDeadlineMs = createFlowDeadline()) {
    while (Date.now() < flowDeadlineMs) {
        const result = await page.evaluate(`
            (() => {
                const privacy = ${browserLiteral(privacy)};
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const anchors = Array.from(document.querySelectorAll('a[href*="watch?v="], a[href*="youtu.be/"]')).map((a) => a.href).filter(Boolean);
                return { text, anchors, privacy };
            })()
        `);
        const state = classifyYouTubePublishState(result);
        if (state?.ok) return state;
        classifyPlatformFailure(PLATFORM, DOMAIN, state, 'YouTube publish failed');
        const waitMs = Math.min(POLL_MS, remainingTimeoutMs(flowDeadlineMs));
        if (waitMs > 0) await page.wait({ time: waitMs / 1000 });
    }
    throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'YouTube publish/save clicked but final publish state was not confirmed before timeout; check YouTube Studio manually.');
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
        { name: 'timeout', type: 'int', default: DEFAULT_COMMAND_TIMEOUT_SECONDS, help: 'Max seconds for the full YouTube publish flow' },
    ],
    columns: ['ok', 'platform', 'status', 'code', 'capability', 'message', 'url', 'draft'],
    func: async (page, kwargs) => {
        const input = validateVideoPublishInput(kwargs, PLATFORM, {
            maxTitleLength: 100,
            maxDescriptionLength: 5000,
            validateCover: false,
        });
        const timeoutSeconds = requirePositiveTimeoutSeconds(kwargs.timeout);
        const flowDeadlineMs = createFlowDeadline(timeoutSeconds);
        const unsupported = unsupportedForInput(input);
        if (unsupported) return unsupported;

        await requireBrowserUploadSupport(page, PLATFORM);
        await page.goto(STUDIO_URL, { waitUntil: 'load', settleMs: 4000 });
        await assertYouTubeLoggedIn(page);
        await openUploadDialog(page);
        await setFileInput(page, [input.videoPath], FILE_SELECTORS, PLATFORM, remainingTimeoutMs(flowDeadlineMs));
        await verifyYouTubeFileSelected(page, input.videoPath);
        await waitForDetailsDialog(page, flowDeadlineMs);

        const description = buildDescriptionWithTags(input.description, input.tags);
        await fillYouTubeDetails(page, input.title, description);
        await goThroughChecks(page, input.privacy);
        await clickPublish(page);
        const publishResult = await waitForYouTubePublishResult(page, input.privacy, flowDeadlineMs);

        return successResult(PLATFORM, publishResult.message || 'YouTube publish completed', {
            url: publishResult.url || '',
            draft: false,
        });
    },
});

export const __test__ = {
    unsupportedForInput,
    fillYouTubeDetails,
    chooseNotMadeForKids,
    goThroughChecks,
    clickAndVerifyYouTubeRadio,
    classifyYouTubePublishState,
    collectUploadDiagnostics,
    formatUploadDiagnostics,
    verifyYouTubeFileSelected,
    createFlowDeadline,
    remainingTimeoutMs,
    waitForDetailsDialog,
    waitForYouTubePublishResult,
};
