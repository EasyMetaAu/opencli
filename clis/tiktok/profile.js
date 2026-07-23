import { cli } from '@jackwener/opencli/registry';

export const profileCommand = cli({
    site: 'tiktok',
    name: 'profile',
    access: 'read',
    description: 'Get TikTok user profile info',
    domain: 'www.tiktok.com',
    args: [
        {
            name: 'username',
            required: true,
            positional: true,
            help: 'TikTok username (without @)',
        },
    ],
    columns: [
        'username',
        'name',
        'followers',
        'following',
        'likes',
        'videos',
        'verified',
        'bio',
    ],
    pipeline: [
        { navigate: { url: 'https://www.tiktok.com/@${{ args.username | urlencode }}', settleMs: 8000 } },
        { evaluate: `(async () => {
  const username = \${{ args.username | json }};
  const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  if (!script || !script.textContent) {
    const bodyText = document.body && document.body.innerText || '';
    if (/Please wait/i.test(bodyText)) throw new Error('TikTok WAF challenge did not finish');
    throw new Error('Could not parse profile data');
  }
  const data = JSON.parse(script.textContent);
  const ud = data['__DEFAULT_SCOPE__'] && data['__DEFAULT_SCOPE__']['webapp.user-detail'];
  const u = ud && ud.userInfo && ud.userInfo.user;
  const s = ud && ud.userInfo && ud.userInfo.stats;
  if (!u) throw new Error('User not found: ' + username);
  return [{
    username: u.uniqueId || username,
    name: u.nickname || '',
    bio: (u.signature || '').replace(/\\n/g, ' ').substring(0, 120),
    followers: s && s.followerCount || 0,
    following: s && s.followingCount || 0,
    likes: s && s.heartCount || 0,
    videos: s && s.videoCount || 0,
    verified: u.verified ? 'Yes' : 'No',
  }];
})()
` },
    ],
});
