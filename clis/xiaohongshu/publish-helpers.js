/**
 * Shared helpers for xiaohongshu creator-center publishing commands
 * (publish.js 图文 and publish-video.js 视频).
 *
 * Everything here is a verbatim extraction from publish.js — the inline
 * evaluate scripts keep their marker strings (`__opencli_xhs_fill_phase`,
 * `xhs-publish-btn`, …) so existing page-mock tests keep matching.
 */
import { CommandExecutionError } from '@jackwener/opencli/errors';

export function unwrapBrowserResult(value) {
    if (
        value
        && typeof value === 'object'
        && typeof value.session === 'string'
        && Object.prototype.hasOwnProperty.call(value, 'data')
    ) {
        return value.data;
    }
    return value;
}

/**
 * XHS creator center wraps the publish/save button in an `<xhs-publish-btn>`
 * web component backed by a CLOSED shadow root. Host-level `.click()` does
 * not dispatch into the internal handler. Invoke these instance methods on
 * the host element to trigger publish / save-draft directly (#1606).
 */
export const PUBLISH_METHOD_NAMES = ['_onPublish', 'onPublish', '_onSubmit', '_handlePublish'];
export const DRAFT_METHOD_NAMES = ['_onSave', '_onSaveDraft', '_onDraft'];

/** Selectors for the title field, ordered by priority across current UI variants. */
export const TITLE_SELECTORS = [
    // Some creator-center variants expose the title as contenteditable,
    // others use a normal <input> with the same placeholder. Visible
    // user-facing variants always carry a Chinese placeholder; class-based
    // variants also match a pair of 4 px wide hidden scaffolding inputs
    // (same `class*="title"`, empty placeholder, no v-model commit on save)
    // so placeholder-based selectors take precedence to avoid filling those.
    '[contenteditable="true"][placeholder*="标题"]',
    '[contenteditable="true"][placeholder*="赞"]',
    'input[placeholder*="标题"]',
    'input[placeholder*="title" i]',
    '[contenteditable="true"][class*="title"]',
    'input[maxlength="20"]',
    'input[class*="title"]',
    '.title-input input',
    '.note-title input',
    'input[maxlength]',
];

/** Selectors for the note body / content editor, ordered by priority. */
export const BODY_SELECTORS = [
    '[contenteditable="true"][class*="content"]',
    '[contenteditable="true"][class*="editor"]',
    '[contenteditable="true"][placeholder*="描述"]',
    '[contenteditable="true"][placeholder*="正文"]',
    '[contenteditable="true"][placeholder*="内容"]',
    '.note-content [contenteditable="true"]',
    '.editor-content [contenteditable="true"]',
    // Broad fallback — last resort; filter out any title contenteditable
    '[contenteditable="true"]:not([placeholder*="标题"]):not([placeholder*="赞"]):not([placeholder*="title" i])',
];

/**
 * Fill a visible text input or contenteditable with the given text.
 * Tries multiple selectors in priority order.
 * Returns { ok, sel }.
 */
export async function fillField(page, selectors, text, fieldName) {
    const located = await page.evaluate(`
    (function(selectors) {
      const __opencli_xhs_fill_phase = "locate";
      for (const sel of selectors) {
        const candidates = document.querySelectorAll(sel);
        for (const el of candidates) {
          if (!el || el.offsetParent === null) continue;
          const kind = el.isContentEditable
            ? 'contenteditable'
            : (el.tagName === 'TEXTAREA' ? 'textarea' : 'input');
          return { ok: true, sel, kind };
        }
      }
      return { ok: false };
    })(${JSON.stringify(selectors)})
  `);
    if (!located.ok) {
        await page.screenshot({ path: `/tmp/xhs_publish_${fieldName}_debug.png` });
        throw new Error(`Could not find ${fieldName} input. Debug screenshot: /tmp/xhs_publish_${fieldName}_debug.png`);
    }
    const applyInPage = () => page.evaluate(`
      ((selector, expectedText) => {
        const __opencli_xhs_fill_phase = "apply";
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const fireBeforeInput = (el, value) => {
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          } catch {
            el.dispatchEvent(new Event('beforeinput', { bubbles: true }));
          }
        };
        const fireInput = (el, value) => {
          try {
            el.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          } catch {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        };
        const el = Array.from(document.querySelectorAll(selector)).find(node => node && node.offsetParent !== null);
        if (!el) return { ok: false, actual: '' };
        el.focus();
        fireBeforeInput(el, expectedText);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = el.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, expectedText);
          else el.value = expectedText;
          fireInput(el, expectedText);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return { ok: el.value === expectedText, actual: el.value || '' };
        }
        el.textContent = '';
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const inserted = document.execCommand('insertText', false, expectedText);
        if (!inserted) el.textContent = expectedText;
        fireInput(el, expectedText);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        const actual = normalize(el.innerText || el.textContent || '');
        return { ok: actual === normalize(expectedText), actual };
      })(${JSON.stringify(located.sel)}, ${JSON.stringify(text)})
    `);
    let result;
    if (located.kind === 'contenteditable' && page.insertText) {
        const prepared = await page.evaluate(`
      ((selector, nextText) => {
        const __opencli_xhs_fill_phase = "prepare";
        const fireBeforeInput = (el, value) => {
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          } catch {
            el.dispatchEvent(new Event('beforeinput', { bubbles: true }));
          }
        };
        const el = Array.from(document.querySelectorAll(selector)).find(node => node && node.offsetParent !== null);
        if (!el) return { ok: false };
        el.focus();
        el.textContent = '';
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        fireBeforeInput(el, nextText);
        return { ok: true };
      })(${JSON.stringify(located.sel)}, ${JSON.stringify(text)})
    `);
        if (!prepared?.ok) {
            await page.screenshot({ path: `/tmp/xhs_publish_${fieldName}_debug.png` });
            throw new Error(`Could not prepare ${fieldName} input. Debug screenshot: /tmp/xhs_publish_${fieldName}_debug.png`);
        }
        try {
            await page.insertText(text);
            result = await page.evaluate(`
      ((selector, expectedText) => {
        const __opencli_xhs_fill_phase = "verify";
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const fireInput = (el, value) => {
          try {
            el.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          } catch {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        };
        const el = Array.from(document.querySelectorAll(selector)).find(node => node && node.offsetParent !== null);
        if (!el) return { ok: false, actual: '' };
        fireInput(el, expectedText);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        const actual = normalize(el.innerText || el.textContent || '');
        return { ok: actual === normalize(expectedText), actual };
      })(${JSON.stringify(located.sel)}, ${JSON.stringify(text)})
    `);
        }
        catch {
            result = await applyInPage();
        }
    }
    else {
        result = await applyInPage();
    }
    if (!result?.ok) {
        await page.screenshot({ path: `/tmp/xhs_publish_${fieldName}_debug.png` });
        const actual = typeof result?.actual === 'string' ? result.actual : '';
        throw new Error(`Failed to set ${fieldName}. Expected "${text}", got "${actual}". Debug screenshot: /tmp/xhs_publish_${fieldName}_debug.png`);
    }
}

/**
 * Add topic hashtags by driving the editor's native inline "#" flow.
 *
 * Modern XHS creator-center editors turn a "#keyword" typed into the note body
 * into a linked topic entity only after the author picks an item from the
 * suggestion dropdown that appears while typing. There is no standalone
 * "添加话题" search input anymore, so we type directly into the body editor.
 *
 * For each topic we:
 *   1. focus the body contenteditable and move the caret to the end,
 *   2. type " #<topic>" using native CDP insertion (falls back to execCommand)
 *      so XHS fires its inline suggestion dropdown,
 *   3. wait for the dropdown, then click the suggestion whose text best matches
 *      the topic (falling back to the first suggestion, then to Enter),
 *   4. confirm a topic chip/link was produced before moving on.
 *
 * A requested topic is a write-side postcondition: if XHS does not create a
 * real topic entity, fail before publishing instead of silently emitting a note
 * with bare "#text".
 */
export async function focusBodyEnd(page, bodySelectors) {
    return unwrapBrowserResult(await page.evaluate(`
    (selectors => {
      const el = selectors
        .map(sel => Array.from(document.querySelectorAll(sel)))
        .flat()
        .find(node => node && node.offsetParent !== null && node.isContentEditable);
      if (!el) return false;
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    })(${JSON.stringify(bodySelectors)})
  `));
}

export function topicMarkerCountScript(topic, bodySelectors) {
    return `
    ((topicName, selectors) => {
      const __opencli_xhs_topic_marker_count = true;
      const marker = '#' + topicName + '[话题]';
      const editor = selectors
        .map(sel => Array.from(document.querySelectorAll(sel)))
        .flat()
        .find(node => node && node.offsetParent !== null && node.isContentEditable);
      if (!editor || !marker) return 0;
      const text = editor.innerText || editor.textContent || '';
      let count = 0;
      let index = text.indexOf(marker);
      while (index !== -1) {
        count += 1;
        index = text.indexOf(marker, index + marker.length);
      }
      return count;
    })(${JSON.stringify(topic)}, ${JSON.stringify(bodySelectors)})
  `;
}

export async function addTopics(page, bodySelectors, topics) {
    const added = [];
    for (const topic of topics) {
        const focused = await focusBodyEnd(page, bodySelectors);
        if (!focused) {
            throw new CommandExecutionError(`Could not attach topic "${topic}": body editor not found`);
        }
        const beforeMarkerCount = Number(unwrapBrowserResult(await page.evaluate(topicMarkerCountScript(topic, bodySelectors)))) || 0;
        // Separate this topic from the preceding text so the dropdown is clean.
        if (typeof page.pressKey === 'function') {
            try {
                await page.pressKey('Enter');
            }
            catch { /* non-fatal */ }
        }
        // Type the inline "#<topic>" query so XHS pops the inline suggestion
        // dropdown. We must use `page.insertText` (CDP) rather than the legacy
        // `execCommand` path, otherwise XHS's editor doesn't fire its keyup
        // listener and no dropdown appears.
        if (typeof page.insertText !== 'function') {
            throw new CommandExecutionError(`Could not attach topic "${topic}": page.insertText is unavailable`);
        }
        try {
            await page.insertText(`#${topic}`);
        }
        catch {
            throw new CommandExecutionError(`Could not attach topic "${topic}": failed to type inline topic query`);
        }
        await page.wait({ time: 1.2 }); // Let the suggestion dropdown render.
        // The suggestion dropdown lives inside the editor's closed shadow root,
        // so light-DOM queries cannot enumerate its items. XHS auto-highlights
        // the first matching suggestion as soon as the query is typed, so
        // pressing Enter accepts it directly. `page.nativeClick` would also
        // work but is not always wired up in the browser-bridge wrapper.
        if (typeof page.pressKey !== 'function') {
            throw new CommandExecutionError(`Could not attach topic "${topic}": page.pressKey is unavailable`);
        }
        try {
            await page.pressKey('Enter');
        }
        catch (err) {
            throw new CommandExecutionError(`Could not attach topic "${topic}": failed to accept suggestion (${err && err.message || err})`);
        }
        await page.wait({ time: 0.8 });
        // Verify the topic chip actually rendered. The chip itself lives in a
        // closed shadow root so we cannot count `<a>` elements, but XHS exposes
        // a stable "#<topic>[话题]" marker in the body editor's innerText once
        // the suggestion is accepted. Require the scoped marker count to
        // increase so an existing marker elsewhere cannot satisfy the write
        // postcondition.
        const afterMarkerCount = Number(unwrapBrowserResult(await page.evaluate(topicMarkerCountScript(topic, bodySelectors)))) || 0;
        if (afterMarkerCount <= beforeMarkerCount) {
            throw new CommandExecutionError(`Could not attach topic "${topic}": no real topic entity appeared after selection`);
        }
        added.push(topic);
        await page.wait({ time: 0.4 });
    }
    return added;
}

export async function inspectPublishSurfaceState(page) {
    return page.evaluate(`
    () => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const hasTitleInput = !!Array.from(document.querySelectorAll('input, textarea')).find((el) => {
        if (!el || el.offsetParent === null) return false;
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        const cls = el.className ? String(el.className) : '';
        const maxLength = Number(el.getAttribute('maxlength') || 0);
        return (
          placeholder.includes('标题') ||
          /title/i.test(placeholder) ||
          /title/i.test(cls) ||
          maxLength === 20
        );
      });
      const hasImageInput = !!Array.from(document.querySelectorAll('input[type="file"]')).find((el) => {
        const accept = el.getAttribute('accept') || '';
        return (
          accept.includes('image') ||
          accept.includes('.jpg') ||
          accept.includes('.jpeg') ||
          accept.includes('.png') ||
          accept.includes('.gif') ||
          accept.includes('.webp')
        );
      });
      const hasVideoSurface = text.includes('拖拽视频到此处点击上传') || text.includes('上传视频');
      const state = hasTitleInput ? 'editor_ready' : hasImageInput || !hasVideoSurface ? 'image_surface' : 'video_surface';
      return { state, hasTitleInput, hasImageInput, hasVideoSurface };
    }
  `);
}

export async function waitForPublishSurfaceState(page, maxWaitMs = 5_000) {
    const pollMs = 500;
    const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / pollMs));
    let surface = await inspectPublishSurfaceState(page);
    for (let i = 0; i < maxAttempts; i++) {
        if (surface.state !== 'video_surface') {
            return surface;
        }
        if (i < maxAttempts - 1) {
            await page.wait({ time: pollMs / 1_000 });
            surface = await inspectPublishSurfaceState(page);
        }
    }
    return surface;
}

/**
 * Poll until the title/content editing form appears on the page.
 * The new creator center UI only renders the editor after images are uploaded.
 */
export async function waitForEditForm(page, maxWaitMs = 10_000) {
    const pollMs = 1_000;
    const maxAttempts = Math.ceil(maxWaitMs / pollMs);
    for (let i = 0; i < maxAttempts; i++) {
        const found = await page.evaluate(`
      (() => {
        const sels = ${JSON.stringify(TITLE_SELECTORS)};
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) return true;
        }
        return false;
      })()`);
        if (found)
            return true;
        if (i < maxAttempts - 1)
            await page.wait({ time: pollMs / 1_000 });
    }
    return false;
}

/**
 * Trigger publish / save-draft on the creator-center editor.
 *
 * Path 1: invoke the `<xhs-publish-btn>` web-component instance methods
 * (closed shadow root — host `.click()` never reaches the handler, #1606).
 * Path 2: legacy text-match click on visible <button>/[role=button].
 *
 * Returns the raw invoke result { ok, via, ... } — callers layer their own
 * draft fallbacks / error reporting on top.
 */
export async function invokePublishAction(page, { isDraft, labels }) {
    return page.evaluate(`
      (cfg => {
        const { isDraftMode, publishNames, draftNames, labels } = cfg;
        const isVisible = (el) => {
          if (!el || el.offsetParent === null) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        // Path 1: web component method invoke on <xhs-publish-btn>.
        const hosts = Array.from(document.querySelectorAll('xhs-publish-btn')).filter(isVisible);
        const wanted = isDraftMode ? draftNames : publishNames;
        // Try every host + every candidate; do NOT bail on the first throw
        // (multiple hosts can exist, and a later name may succeed).
        let lastMethodError = null;
        for (const host of hosts) {
          for (const name of wanted) {
            if (typeof host[name] !== 'function') continue;
            try {
              host[name]();
              return { ok: true, via: 'method', name };
            } catch (err) {
              lastMethodError = String(err && err.message || err);
            }
          }
        }
        // Path 2: legacy <button>/[role=button] text-match click fallback.
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || '').trim();
          if (
            labels.some(l => text === l || text.includes(l)) &&
            isVisible(btn) &&
            !btn.disabled
          ) {
            btn.click();
            return { ok: true, via: 'click', text };
          }
        }
        return { ok: false, via: 'none', hosts: hosts.length, lastMethodError };
      })(${JSON.stringify({
        isDraftMode: isDraft,
        publishNames: PUBLISH_METHOD_NAMES,
        draftNames: DRAFT_METHOD_NAMES,
        labels,
    })})
    `);
}
