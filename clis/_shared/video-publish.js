import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError, getErrorMessage } from '@jackwener/opencli/errors';

export const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
export const SUPPORTED_COVER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function normalizeText(value) {
    return String(value ?? '').trim();
}

export function parseTags(raw) {
    if (!raw) return [];
    const parts = Array.isArray(raw) ? raw : String(raw).split(',');
    const tags = [];
    const seen = new Set();
    for (const part of parts) {
        const tag = normalizeText(part).replace(/^#+/, '').replace(/\s+/g, '');
        if (!tag) continue;
        if (tag.length > 100) {
            throw new ArgumentError(`tag is too long: ${tag.slice(0, 32)}...`);
        }
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            tags.push(tag);
        }
    }
    if (tags.length > 30) {
        throw new ArgumentError('too many tags (max 30)');
    }
    return tags;
}

export function formatHashtags(tags) {
    return tags.map((tag) => `#${tag}`).join(' ');
}

export function validateVideoPublishInput(kwargs, platform, options = {}) {
    const rawVideo = normalizeText(kwargs.video);
    if (!rawVideo) {
        throw new ArgumentError(`${platform} publish requires a video file path`);
    }
    const videoPath = path.resolve(rawVideo);
    const videoStat = fs.statSync(videoPath, { throwIfNoEntry: false });
    if (!videoStat || !videoStat.isFile()) {
        throw new ArgumentError(`video file does not exist: ${videoPath}`);
    }
    const videoExt = path.extname(videoPath).toLowerCase();
    if (!SUPPORTED_VIDEO_EXTENSIONS.has(videoExt)) {
        throw new ArgumentError(`unsupported video format: ${videoExt || '(none)'} (supported: mp4, mov, m4v, webm)`);
    }

    const title = normalizeText(kwargs.title);
    if (!title) {
        throw new ArgumentError(`${platform} publish title cannot be empty`);
    }
    const maxTitleLength = options.maxTitleLength ?? 100;
    if (title.length > maxTitleLength) {
        throw new ArgumentError(`${platform} publish title exceeds ${maxTitleLength} characters`);
    }

    const description = normalizeText(kwargs.description ?? kwargs.caption);
    const maxDescriptionLength = options.maxDescriptionLength ?? 5000;
    if (description.length > maxDescriptionLength) {
        throw new ArgumentError(`${platform} publish description exceeds ${maxDescriptionLength} characters`);
    }

    const tags = parseTags(kwargs.tags);
    const cover = normalizeText(kwargs.cover);
    if (cover && options.validateCover !== false) {
        const coverPath = path.resolve(cover);
        const coverStat = fs.statSync(coverPath, { throwIfNoEntry: false });
        if (!coverStat || !coverStat.isFile()) {
            throw new ArgumentError(`cover file does not exist: ${coverPath}`);
        }
        const coverExt = path.extname(coverPath).toLowerCase();
        if (!SUPPORTED_COVER_EXTENSIONS.has(coverExt)) {
            throw new ArgumentError(`unsupported cover format: ${coverExt || '(none)'} (supported: jpg, png, webp)`);
        }
    }

    return {
        videoPath,
        title,
        description,
        tags,
        cover,
        schedule: normalizeText(kwargs.schedule),
        privacy: normalizeText(kwargs.privacy || 'public'),
        draft: Boolean(kwargs.draft),
        account: normalizeText(kwargs.account),
    };
}

export function buildDescriptionWithTags(description, tags) {
    const hashtagText = formatHashtags(tags);
    return [description, hashtagText].filter(Boolean).join(description && hashtagText ? '\n\n' : '');
}

export function unsupportedResult(platform, capability, message) {
    return [{
        ok: false,
        platform,
        status: 'unsupported',
        code: 'unsupported_capability',
        capability,
        message,
        url: '',
        draft: false,
    }];
}

export function successResult(platform, message, extra = {}) {
    return [{
        ok: true,
        platform,
        status: 'success',
        code: 'success',
        capability: '',
        message,
        url: extra.url || '',
        draft: Boolean(extra.draft),
        ...extra,
    }];
}

export function classifyPlatformFailure(platform, domain, result, fallbackMessage) {
    if (result?.error === 'auth') {
        throw new AuthRequiredError(domain, result.message || `${platform} publish requires login`);
    }
    if (result?.error === 'validation') {
        throw new ArgumentError(result.message || `${platform} publish validation failed`);
    }
    if (result?.error === 'upload') {
        throw new CommandExecutionError(result.message || `${platform} video upload failed`);
    }
    if (result?.error) {
        throw new CommandExecutionError(result.message || fallbackMessage || `${platform} publish failed`);
    }
}

export async function requireBrowserUploadSupport(page, platform) {
    if (!page) {
        throw new CommandExecutionError(`${platform} publish requires a browser session`);
    }
    if (!page.setFileInput) {
        throw new CommandExecutionError('Browser extension does not support file upload. Please update OpenCLI browser support.');
    }
}

export async function waitForAnySelector(page, selectors, timeoutMs = 30_000, intervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = await page.evaluateWithArgs?.(`
            (() => selectors.find((selector) => !!document.querySelector(selector)) || '')()
        `, { selectors }) ?? await page.evaluate(`
            (() => ${JSON.stringify(selectors)}.find((selector) => !!document.querySelector(selector)) || '')()
        `);
        if (found) return found;
        await page.wait({ time: intervalMs / 1000 });
    }
    return '';
}

export async function setFileInput(page, files, selectors, platform) {
    const selector = await waitForAnySelector(page, selectors, 45_000, 750);
    if (!selector) {
        throw new CommandExecutionError(`${platform} upload failed: file input was not found`);
    }
    try {
        await page.setFileInput(files, selector);
    } catch (error) {
        throw new CommandExecutionError(`${platform} upload failed while setting file input: ${getErrorMessage(error)}`);
    }
    return selector;
}

export function visibleElementScript() {
    return `
function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}
function setNativeText(el, text) {
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
  } else {
    el.textContent = text;
  }
  el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function clickByLabels(labels) {
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], ytcp-button, tp-yt-paper-button'));
  for (const label of labels) {
    const needle = String(label).toLowerCase();
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
      if (!disabled && isVisible(el) && text.includes(needle)) {
        el.click();
        return { ok: true, label, text };
      }
    }
  }
  return { ok: false, message: 'button not found: ' + labels.join(', ') };
}
`;
}
