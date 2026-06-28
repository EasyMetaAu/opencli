import { AuthRequiredError, CommandExecutionError, getErrorMessage } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { BROWSER_HELPERS, OWNER_IDENTITY_RESOLVER, looksTikTokAuthFailure } from './utils.js';

async function hasTiktokSessionCookie(page) {
  const cookies = await page.getCookies({ url: 'https://www.tiktok.com' });
  const names = new Set(cookies.map(c => c.name));
  return names.has('sessionid') || names.has('sid_tt') || names.has('uid_tt');
}

function buildIdentityScript() {
  return `
(async () => {
  ${BROWSER_HELPERS}
  ${OWNER_IDENTITY_RESOLVER}
  return await resolveOwnerIdentity();
})()
`;
}

async function verifyTiktokIdentity(page) {
  if (!await hasTiktokSessionCookie(page)) {
    throw new AuthRequiredError('www.tiktok.com', 'TikTok session cookies (sessionid/sid_tt/uid_tt) missing');
  }
  // Same-origin navigation so the page-context fetch in resolveOwnerIdentity()
  // carries the session cookies; the short wait gives /foryou a chance to embed
  // the rehydration snapshot (Path 1) before we fall back to the API (Path 2).
  await page.goto('https://www.tiktok.com/foryou');
  await page.wait(2);
  let info = null;
  try {
    info = await page.evaluate(buildIdentityScript());
  } catch (error) {
    // Auth-shaped probe failures stay AuthRequiredError so `login` polling keeps
    // waiting (site-auth only retries on AuthRequiredError); anything else is a
    // genuine command failure.
    const message = getErrorMessage(error);
    if (looksTikTokAuthFailure(message)) {
      throw new AuthRequiredError('www.tiktok.com', message);
    }
    throw new CommandExecutionError(`TikTok whoami probe failed: ${message}`);
  }
  if (!info?.sec_uid) {
    throw new AuthRequiredError('www.tiktok.com', 'TikTok identity unresolved — neither rehydration data nor /passport/web/account/info returned an owner user');
  }
  return { sec_uid: info.sec_uid, username: info.username, nickname: info.nickname };
}

registerSiteAuthCommands({
  site: 'tiktok',
  domain: 'tiktok.com',
  loginUrl: 'https://www.tiktok.com/login',
  columns: ['sec_uid', 'username', 'nickname'],
  quickCheck: hasTiktokSessionCookie,
  verify: verifyTiktokIdentity,
  poll: async (page) => {
    if (!await hasTiktokSessionCookie(page)) {
      throw new AuthRequiredError('www.tiktok.com', 'Waiting for TikTok session cookies');
    }
    return verifyTiktokIdentity(page);
  },
});

export const __test__ = { verifyTiktokIdentity, buildIdentityScript };
