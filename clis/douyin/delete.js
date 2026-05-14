import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { browserFetch } from './_shared/browser-fetch.js';

const CREATOR_MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';
const WORK_LIST_URL = '/janus/douyin/creator/pc/work_list?status=0&count=20&max_cursor=0&scene=star_atlas&device_platform=android&aid=1128';

async function deleteViaCreatorManage(page, workId) {
    await page.goto(CREATOR_MANAGE_URL, { waitUntil: 'none' });
    const result = await page.evaluate(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const targetId = ${JSON.stringify(String(workId))};
      const textOf = (node) => (node && (node.innerText || node.textContent) || '').trim();
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();

      async function loadTarget() {
        const res = await fetch(${JSON.stringify(WORK_LIST_URL)}, { credentials: 'include' });
        const payload = await res.json();
        const list = Array.isArray(payload.aweme_list) ? payload.aweme_list : [];
        const item = list.find((entry) => String(entry.aweme_id || '') === targetId || String(entry.item_id || '') === targetId);
        if (!item) {
          return { ok: false, reason: 'not_found', status_code: payload.status_code, count: list.length };
        }
        const title = normalize(item.desc || item.caption || item.title || item.item_title || '');
        return { ok: true, item, title };
      }

      const target = await loadTarget();
      if (!target.ok) return target;
      await sleep(1500);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const cards = Array.from(document.querySelectorAll('[class*="video-card"]'));
        const matchingCards = cards.filter((card) => {
          const text = normalize(textOf(card));
          return target.title ? text.includes(target.title) : text.includes(targetId);
        });
        const card = matchingCards[0];
        if (card) {
          const deleteButton = Array.from(card.querySelectorAll('button,[role="button"],span,div'))
            .find((element) => /^删除作品$/.test(normalize(textOf(element))));
          if (!deleteButton) return { ok: false, reason: 'delete_button_not_found', title: target.title, matches: matchingCards.length };
          deleteButton.click();
          await sleep(800);
          const confirmButton = Array.from(document.querySelectorAll('button,[role="button"]'))
            .find((element) => ['确定', '确认', '删除'].includes(normalize(textOf(element))));
          if (!confirmButton) return { ok: false, reason: 'confirm_button_not_found', title: target.title };
          confirmButton.click();
          for (let wait = 0; wait < 20; wait += 1) {
            await sleep(500);
            const after = await loadTarget();
            if (!after.ok && after.reason === 'not_found') {
              return { ok: true, aweme_id: target.item.aweme_id, item_id: target.item.item_id, title: target.title };
            }
          }
          return { ok: false, reason: 'delete_not_confirmed', title: target.title };
        }
        await sleep(500);
      }
      return { ok: false, reason: 'card_not_found', title: target.title };
    })()
  `);

    if (!result?.ok) {
        throw new CommandExecutionError(`抖音后台管理删除失败: ${JSON.stringify(result)}`);
    }
    return result;
}

cli({
    site: 'douyin',
    name: 'delete',
    access: 'write',
    description: '删除作品（优先调用接口；接口无权限时回退到创作者后台作品管理删除）',
    domain: 'creator.douyin.com',
    strategy: Strategy.COOKIE,
    siteSession: 'persistent',
    args: [
        { name: 'aweme_id', required: true, positional: true, help: '作品 ID / item_id' },
    ],
    columns: ['status'],
    func: async (page, kwargs) => {
        const url = 'https://creator.douyin.com/web/api/media/aweme/delete/?aid=1128';
        try {
            await browserFetch(page, 'POST', url, { body: { aweme_id: kwargs.aweme_id } });
            return [{ status: `✅ 已删除 ${kwargs.aweme_id}` }];
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('Douyin API error 18') && !message.includes('No item permission')) {
                throw error;
            }
        }

        const deleted = await deleteViaCreatorManage(page, kwargs.aweme_id);
        return [{ status: `✅ 已通过后台管理删除 ${deleted.aweme_id || kwargs.aweme_id}` }];
    },
});
