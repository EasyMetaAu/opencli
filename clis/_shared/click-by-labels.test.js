// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { visibleElementScript } from './video-publish.js';

// clickByLabels lives inside the browser-injected source returned by
// visibleElementScript(). Eval it once so we can exercise the matching logic
// against a real (jsdom) DOM. This guards the regression where a substring
// label like "Post" clicked the left-nav "Posts" link instead of the submit
// button, which navigated away and popped TikTok's "exit?" confirm dialog.
const clickByLabels = new Function(`${visibleElementScript()}\nreturn clickByLabels;`)();

beforeAll(() => {
    // jsdom performs no layout, so getBoundingClientRect() returns an all-zero
    // box and isVisible() would reject every element. Report a non-zero box.
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value() {
            return { width: 120, height: 32, top: 0, left: 0, right: 120, bottom: 32, x: 0, y: 0, toJSON() {} };
        },
    });
});

afterEach(() => { document.body.innerHTML = ''; });

// Record which button actually received the click.
function trackClicks() {
    let hit = null;
    for (const el of document.querySelectorAll('button')) {
        el.addEventListener('click', () => { hit = el.id || el.textContent; });
    }
    return () => hit;
}

describe('clickByLabels — submit button vs left-nav', () => {
    it('clicks the "Post" submit button, not the left-nav "Posts" link', () => {
        document.body.innerHTML = `
            <nav><button id="nav-posts">Posts</button></nav>
            <div><button id="submit">Post</button></div>
        `;
        const hit = trackClicks();
        const r = clickByLabels(['Post now', 'Post', 'Publish']);
        expect(r.ok).toBe(true);
        expect(r.text).toBe('post');
        expect(hit()).toBe('submit');
    });

    it('prefers an exact "Post now" button even when a "Post" button precedes it', () => {
        document.body.innerHTML = `
            <nav><button id="nav-posts">Posts</button></nav>
            <button id="post">Post</button>
            <button id="postnow">Post now</button>
        `;
        const hit = trackClicks();
        const r = clickByLabels(['Post now', 'Post']);
        expect(r.text).toBe('post now');
        expect(hit()).toBe('postnow');
    });

    it('excludes nav containers entirely (no click when only a nav item matches)', () => {
        document.body.innerHTML = `<nav><button id="nav-post">Post</button></nav>`;
        const hit = trackClicks();
        const r = clickByLabels(['Post']);
        expect(r.ok).toBe(false);
        expect(hit()).toBe(null);
    });

    it('still falls back to substring matching for non-exact labels (YouTube-style)', () => {
        document.body.innerHTML = `<div><button id="up">Upload videos to channel</button></div>`;
        const hit = trackClicks();
        const r = clickByLabels(['Upload videos', '上传视频']);
        expect(r.ok).toBe(true);
        expect(hit()).toBe('up');
    });

    it('excludeWithin skips link-style nav items the substring fallback would otherwise click', () => {
        document.body.innerHTML = `<a href="/tiktokstudio/content" role="button" id="nav-posts">Posts</a>`;
        // jsdom attempts real navigation on a link click; suppress it for the test.
        document.getElementById('nav-posts').addEventListener('click', (e) => e.preventDefault());
        // Without the exclusion, the "Post" substring fallback clicks the nav link.
        const without = clickByLabels(['Post']);
        expect(without.ok).toBe(true);
        expect(without.tag).toBe('A');
        // With a[href] excluded, the nav link is skipped entirely -> no match.
        const r = clickByLabels(['Post'], { excludeWithin: 'a[href]' });
        expect(r.ok).toBe(false);
    });

    it('scheduled labels (no bare "Post") never match the left-nav "Posts" button', () => {
        document.body.innerHTML = `
            <button id="nav-posts">Posts</button>
            <button id="sch">Schedule</button>
        `;
        const hit = trackClicks();
        const r = clickByLabels(['预约发布', 'Schedule video', 'Schedule', '排程', '定时发布']);
        expect(r.ok).toBe(true);
        expect(r.tag).toBe('BUTTON');
        expect(hit()).toBe('sch');
    });
});
