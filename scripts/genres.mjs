// 把 Bangumi 的自由标签归一到固定题材。
// 说明：只做精确匹配，避免「非科幻」这类标签被误判；新增同义词直接补在 tags 里。
export const GENRES = [
  { id: 'sci', label: '科幻', tags: ['科幻', 'sf', 'science fiction', '科学幻想', '太空歌剧', '赛博朋克', 'cyberpunk', '硬科幻'] },
  { id: 'fan', label: '奇幻', tags: ['奇幻', '魔法', '剑与魔法', '魔幻', '高魔', '低魔'] },
  { id: 'ise', label: '异世界', tags: ['异世界', '转生', '异世界转生', '转生异世界'] },
  { id: 'rom', label: '恋爱', tags: ['恋爱', '爱情', '恋爱喜剧', '浪漫', 'romance', '纯爱'] },
  { id: 'sch', label: '校园', tags: ['校园', '学园', '学校', '学生会'] },
  { id: 'sli', label: '日常', tags: ['日常', '生活', '慢节奏', '空气系'] },
  { id: 'hea', label: '治愈', tags: ['治愈', '温情', '暖心', '治愈系'] },
  { id: 'com', label: '喜剧', tags: ['喜剧', '搞笑', '欢乐', '沙雕'] },
  { id: 'mys', label: '悬疑', tags: ['悬疑', '推理', '侦探', '谜题', '犯罪'] },
  { id: 'act', label: '动作', tags: ['动作', '热血', '战斗', '格斗', '武打'] },
  { id: 'mec', label: '机战', tags: ['机战', '机器人', '机甲'] },
  { id: 'spo', label: '运动', tags: ['运动', '体育', '竞技', '球类'] },
  { id: 'mus', label: '音乐', tags: ['音乐', '偶像', '乐队', '唱歌'] },
  { id: 'yur', label: '百合', tags: ['百合', 'gl', '女子恋爱', '轻百合'] },
  { id: 'bl', label: '耽美', tags: ['耽美', 'bl', '男性恋爱', '蔷薇'] },
  { id: 'hor', label: '恐怖', tags: ['恐怖', '惊悚', '猎奇', '灵异'] },
  { id: 'his', label: '历史', tags: ['历史', '战争', '军事', '时代剧', '大河剧'] },
  { id: 'gou', label: '美食', tags: ['美食', '料理', '做饭', '美食番'] },
  { id: 'dra', label: '剧情', tags: ['剧情', '戏剧', '人生', '青春'] },
];

const TAG_TO_GENRE = new Map();
GENRES.forEach((g) => {
  g.tags.forEach((t) => TAG_TO_GENRE.set(String(t).trim().toLowerCase(), g.id));
});

// 低于该票数的用户标签噪声较大，不参与归类
export const TAG_MIN_COUNT = 3;

export function rawTagNames(metaTags = [], tags = []) {
  const names = [];
  const seen = new Set();
  const push = (value) => {
    const name = String(value || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  (Array.isArray(metaTags) ? metaTags : []).forEach(push);
  (Array.isArray(tags) ? tags : []).forEach((t) => {
    if (!t || !t.name) return;
    if (Number(t.count) < TAG_MIN_COUNT) return;
    push(t.name);
  });
  return names;
}

export function genreIdsFromNames(names = []) {
  const hit = new Set();
  names.forEach((name) => {
    const id = TAG_TO_GENRE.get(String(name).trim().toLowerCase());
    if (id) hit.add(id);
  });
  return GENRES.filter((g) => hit.has(g.id)).map((g) => g.id);
}

export function genreIdsOf(metaTags, tags) {
  return genreIdsFromNames(rawTagNames(metaTags, tags));
}
