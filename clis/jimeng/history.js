import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
    site: 'jimeng',
    name: 'history',
    access: 'read',
    description: '即梦AI 查看最近生成的作品',
    domain: 'jimeng.jianying.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'limit', type: 'int', default: 5 },
    ],
    columns: ['prompt', 'model', 'status', 'image_url', 'created_at'],
    pipeline: [
        { navigate: 'https://jimeng.jianying.com/ai-tool/generate?type=image&workspace=0' },
        { evaluate: `(async () => {
  const limit = \${{ args.limit }};
  const res = await fetch('/mweb/v1/get_history?aid=513695&device_platform=web&region=cn&da_version=3.3.11&web_version=7.5.0&aigc_features=app_lip_sync', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: '', count: limit, need_page_item: true, need_aigc_data: true, aigc_mode_list: ['workbench'] })
  });
  const data = await res.json();
  const statusMap = { 10: 'queued', 20: 'processing', 30: 'failed', 50: 'completed', 100: 'processing', 102: 'completed', 103: 'failed' };
  const items = data?.data?.records_list || data?.data?.history_list || [];
  return items.slice(0, limit).map(record => {
    const i0 = record.item_list?.[0];
    const params = i0?.aigc_image_params?.text2image_params
      || record.aigc_image_params?.text2image_params
      || {};
    const images = i0?.image?.large_images || record.image?.large_images || [];
    const statusCode = record.status ?? record.common_attr?.status ?? i0?.common_attr?.status ?? 0;
    const timestamp = record.created_time || record.common_attr?.create_time || i0?.common_attr?.create_time || 0;
    return {
      prompt: params.prompt || i0?.common_attr?.prompt || record.common_attr?.title || 'N/A',
      model: record.model_info?.model_name || params.model_config?.model_name || 'unknown',
      status: statusMap[statusCode] || `unknown(${statusCode})`,
      image_url: images[0]?.image_url || '',
      created_at: new Date(timestamp * 1000).toLocaleString('zh-CN'),
    };
  });
})()
` },
        { map: {
                prompt: '${{ item.prompt }}',
                model: '${{ item.model }}',
                status: '${{ item.status }}',
                image_url: '${{ item.image_url }}',
                created_at: '${{ item.created_at }}',
            } },
        { limit: '${{ args.limit }}' },
    ],
});
