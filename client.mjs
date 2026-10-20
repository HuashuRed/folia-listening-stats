// listening-stats/client.mjs — 渲染端
// 两件事：
//  1) 采集播放行为（切歌/暂停/喜爱/5 秒计时/20 秒心跳/退出落盘），经 folium.rpc 交给 main 持久化
//  2) 播放器面板新增「统计」标签页：概览 + 栏目切换（Top榜单/时段热力图/最近播放/趣味统计/数据管理）
//
// 数据全部保存在模组专属数据目录，只读统计，不控制播放；
// 「最近播放」点击播放仅对本会话播放过的歌有效（宿主歌曲引用只在本会话有效）。

const LOGO_SVG = '';

const fmt = (s) => {
  s = Math.max(0, Math.round(Number(s) || 0));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
};

const fmtHm = (ts) => {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

const fmtDay = (ts) => {
  const d = new Date(ts);
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// 统一判断“全部”：筛选值可为字符串 'all' 或对象 { id: 'all' }（历史遗留的两种表示）
const isAllPeriod = (period) => period === 'all' || !!(period && period.id === 'all');

// 时间范围起点（毫秒）。阳历自然周期。
// period 可为档位字符串（week/lastWeek/month/season/year/all）
// 或自定义对象 { id:'custom', year, month, season }（年份必选，月份或季节可选）。
function rangeStart(period) {
  const now = new Date();
  const id = typeof period === 'string' ? period : period.id;
  if (isAllPeriod(period)) return 0;
  if (id !== 'custom') {
    if (id === 'week') {
      const d = new Date(now);
      const back = (now.getDay() + 6) % 7; // 周一为一周起点
      d.setDate(now.getDate() - back);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    if (id === 'lastWeek') {
      const d = new Date(now);
      const back = (now.getDay() + 6) % 7 + 7; // 上周一
      d.setDate(now.getDate() - back);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    if (id === 'month') {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return d.getTime();
    }
    if (id === 'season') {
      const m = now.getMonth() + 1;
      const start = m >= 3 && m <= 5 ? 2 : m >= 6 && m <= 8 ? 5 : m >= 9 && m <= 11 ? 8 : 11; // 0-based 月份
      const d = new Date(now.getFullYear(), start, 1);
      return d.getTime();
    }
    if (id === 'year') {
      const d = new Date(now.getFullYear(), 0, 1);
      return d.getTime();
    }
    return 0; // all
  }
  // 自定义：年份必选，月份或季节可选
  const p = period;
  const y = p.year || now.getFullYear();
  if (p.month) return new Date(y, p.month - 1, 1).getTime();
  if (p.season) {
    const start = { spring: 2, summer: 5, autumn: 8, winter: 11 }[p.season];
    return new Date(y, start, 1).getTime();
  }
  return new Date(y, 0, 1).getTime();
}

// 时间范围终点（毫秒，开区间）：与 rangeStart 配合成 [start, end) 自然周期
function rangeEnd(period) {
  const now = new Date();
  const id = typeof period === 'string' ? period : period.id;
  if (isAllPeriod(period)) return null; // 全部：无终点，调用方据此不请求区间
  if (id === 'week') {
    // 本周 = [本周一 0 点, 下周一 0 点)
    const d = new Date(now);
    const back = (now.getDay() + 6) % 7; // 距本周一
    d.setDate(now.getDate() - back + 7);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (id === 'lastWeek') {
    const d = new Date(now);
    const back = (now.getDay() + 6) % 7; // 本周一
    d.setDate(now.getDate() - back);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (id === 'month') return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  if (id === 'season') {
    const m = now.getMonth() + 1;
    const endM = m >= 3 && m <= 5 ? 5 : m >= 6 && m <= 8 ? 8 : m >= 9 && m <= 11 ? 11 : 2; // 0-based 结束月
    return new Date(endM === 2 ? now.getFullYear() + 1 : now.getFullYear(), endM, 1).getTime();
  }
  if (id === 'year') return new Date(now.getFullYear() + 1, 0, 1).getTime();
  const p = period;
  const y = p.year || now.getFullYear();
  if (p.month) return new Date(y, p.month, 1).getTime();
  if (p.season) {
    const endM = { spring: 5, summer: 8, autumn: 11, winter: 2 }[p.season];
    return new Date(p.season === 'winter' ? y + 1 : y, endM, 1).getTime();
  }
  return new Date(y + 1, 0, 1).getTime();
}

function seasonName() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return '春季';
  if (m >= 6 && m <= 8) return '夏季';
  if (m >= 9 && m <= 11) return '秋季';
  return '冬季';
}

function currentSeasonKey() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

const seasonLabel = (s) => ({ spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季' }[s] || '');
const yy = (y) => String(y % 100) + '年';

// 主下拉档位（月份/季节/年份从「历史」里选）
const BASE_CHOICES = [
  { id: 'week', label: '本周' },
  { id: 'lastWeek', label: '上周' },
  { id: 'all', label: '全部' },
  { id: 'custom', label: '历史' },
];

// 当前选择的显示名
function periodLabel(period) {
  if (typeof period === 'string') {
    const c = BASE_CHOICES.find((x) => x.id === period);
    return c ? (typeof c.label === 'function' ? c.label() : c.label) : '';
  }
  const p = period;
  const y = p.year || new Date().getFullYear();
  if (p.month) return yy(y) + p.month + '月';
  if (p.season) return yy(y) + seasonLabel(p.season);
  return yy(y);
}

const parseLocalDate = (value) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parts = value.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  return new Date(value);
};

const dayStrOf = (ts) => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

export default function activate(folium) {
  if (folium.env.context !== 'main') return undefined;

  // ---------------- 采集 ----------------
  const sessionRefs = new Map(); // songKey -> 带 ref 的 song DTO（本会话可播放）
  let cur = null; // { key, song, startedAt, secs, liked, dur }

  const getState = () => {
    try { return folium.playback.getState(); } catch (e) { return null; }
  };

  const keyOf = (song) => {
    const s = song || {};
    const raw = [s.source || '', s.id || '', s.title || '', s.artist || ''].join('\u0001');
    let h = 5381;
    for (let i = 0; i < raw.length; i += 1) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
    return 'k' + h.toString(36) + '_' + raw.length.toString(36);
  };

  const startSession = (song) => {
    const st = getState();
    cur = {
      key: keyOf(song),
      song: song || null,
      startedAt: Date.now(),
      secs: 0,
      liked: !!(st && st.liked),
      dur: (st && st.duration) || 0,
    };
    if (song && song.ref) {
      sessionRefs.set(cur.key, {
        ref: song.ref,
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        source: song.source,
      });
    }
  };

  const finalize = () => {
    if (!cur) return Promise.resolve();
    const c = cur;
    cur = null;
    // Even a very short session must be finalized: it clears any persisted
    // heartbeat so that the same segment is not recovered and counted later.
    if (!c.song) return Promise.resolve();
    return folium.rpc.call('finalize', {
      song: c.song,
      secs: c.secs,
      liked: c.liked,
      dur: c.dur,
      startedAt: c.startedAt,
    }).then((result) => { cached = null; rangeCache.clear(); return result || { ok: true }; })
      .catch((error) => ({ ok: false, error: String(error) }));
  };

  const heartbeat = () => {
    if (!cur || !cur.song) return;
    folium.rpc.call('heartbeat', {
      song: cur.song,
      secs: cur.secs,
      liked: cur.liked,
      dur: cur.dur,
      startedAt: cur.startedAt,
    }).catch(() => {});
  };

  // 5 秒计时：按实际经过时间累加（页面后台节流/休眠恢复时定时器间隔可能远大于 5 秒，
  // 不再固定 +5）；单次增量上限 10 秒，避免把休眠或长时间挂起整段算成播放时间。
  // 每次 tick 都更新 lastTickAt：暂停或没有会话时同样重置，恢复播放不会把暂停时间计入。
  let lastTickAt = Date.now();
  const tick = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.min(10, Math.max(0, (now - lastTickAt) / 1000));
    lastTickAt = now;
    if (!cur) return;
    const st = getState();
    if (!st || st.state !== 'playing') return;
    cur.secs += elapsed;
    const d = st.duration || 0;
    if (d > 0) cur.dur = d;
  }, 5000);

  // 20 秒心跳：强退最多丢最后几秒
  const beat = setInterval(() => { if (cur) heartbeat(); }, 20000);

  // 事件
  const offSong = folium.events.on('playback.songChanged', ({ song }) => {
    finalize();
    if (song) startSession(song);
  });
  const offState = folium.events.on('playback.stateChanged', ({ state }) => {
    if (state === 'stopped') finalize();
  });
  const offLike = folium.events.on('playback.likeChanged', ({ liked }) => {
    if (cur) cur.liked = !!liked;
  });
  const onHide = () => finalize();
  window.addEventListener('pagehide', onHide);
  window.addEventListener('beforeunload', onHide);

  // ---------------- 统计面板 ----------------
  let cached = null; // rpc snapshot 缓存
  const getSnapshot = () => (cached ? Promise.resolve(cached) : folium.rpc.call('snapshot').then((d) => { cached = d; return d; }));

  // 区间精确聚合：按播放流水统计 [start, end)，只用于过去时段（上周/历史年月季）的榜单与趣味统计
  const rangeCache = new Map();
  const getRange = (period) => {
    const start = rangeStart(period);
    const end = rangeEnd(period);
    const k = start + '|' + end;
    if (rangeCache.has(k)) return rangeCache.get(k);
    const p = folium.rpc.call('aggRange', { start, end }).then((d) => (d && typeof d === 'object' ? d : null)).catch(() => null);
    rangeCache.set(k, p);
    return p;
  };

  folium.registries.playerPanelTabs.register({
    id: 'stats',
    label: { 'zh-CN': '统计', en: 'Stats' },
    order: 500,
    mount: (container) => {
      const ui = buildPanel(container);
      return () => ui.dispose();
    },
  });

  // ---------------- 命令 ----------------
  folium.registries.commands.register({
    id: 'open-stats',
    label: { 'zh-CN': '打开听歌统计', en: 'Open listening stats' },
    description: { 'zh-CN': '打开播放器面板的本地听歌统计标签页。', en: 'Open the local listening stats tab.' },
    keywords: ['听歌', '统计', 'stats', '统计面板'],
    run: async () => {
      folium.ui.openPlayerPanel('stats');
      return { message: '已打开听歌统计面板' };
    },
  });

  folium.registries.commands.register({
    id: 'today-summary',
    label: { 'zh-CN': '今日听歌时长', en: 'Today listening time' },
    description: { 'zh-CN': '快速查看今天听了多久、完整播放了几首。', en: 'Quick summary of today listening.' },
    keywords: ['今日', '时长', 'today'],
    run: async () => {
      const snap = await folium.rpc.call('snapshot').catch(() => null);
      if (!snap) return { message: '暂无统计数据' };
      const today = dayStrOf(Date.now());
      const day = snap.agg.daily[today];
      if (!day || !day.secs) return { message: '今天还没听过歌' };
      return { message: '今日 ' + fmt(day.secs) + ' · 完整 ' + day.complete + ' 首 · 跳过 ' + day.skip };
    },
  });

  let clearArmed = false;
  folium.registries.commands.register({
    id: 'clear-stats',
    label: { 'zh-CN': '清空听歌统计', en: 'Clear listening stats' },
    description: { 'zh-CN': '清空全部本地听歌统计（数据不可恢复）。运行两次确认：第二次才真正清空。', en: 'Clear all stats. Run twice to confirm.' },
    keywords: ['清空', '删除', 'clear', '重置'],
    run: async () => {
      if (!clearArmed) {
        clearArmed = true;
        setTimeout(() => { clearArmed = false; }, 10000);
        return { message: '再运行一次以确认清空全部统计' };
      }
      clearArmed = false;
      const includeBackups = window.confirm('是否同时删除已导出的 backups 备份文件？此操作不可恢复。');
      const result = await folium.rpc.call('clear', { includeBackups }).catch((e) => ({ ok: false, error: String(e) }));
      if (!result || result.ok !== true) return { message: '清空失败：' + ((result && result.error) || '未知错误') };
      cached = null;
      rangeCache.clear();
      return { message: '已清空全部听歌统计' };
    },
  });

  folium.registries.commands.register({
    id: 'export-stats',
    label: { 'zh-CN': '导出统计备份', en: 'Export stats backup' },
    description: { 'zh-CN': '把全部统计数据导出为 JSON 备份文件。', en: 'Export all stats to a JSON backup file.' },
    keywords: ['导出', '备份', 'export', 'backup'],
    run: async () => {
      const r = await folium.rpc.call('export').catch(() => null);
      if (!r || !r.outputPath) return { message: '导出失败' };
      return { outputPath: r.outputPath };
    },
  });

  return async () => {
    clearInterval(tick);
    clearInterval(beat);
    // Finalize before detaching listeners so stopping/unloading the module does not
    // leave the last playback segment waiting for the next startup recovery.
    const finalization = finalize();
    offSong();
    offState();
    offLike();
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('beforeunload', onHide);
    await finalization;
  };

  // ---------------- 面板构建 ----------------

  // 时间筛选：主下拉（本周/上周/10月/秋季/26年/全部/其他）
  // 选「其他」后展开次级：年份 + 月份 + 季节联动（根据年份筛月份和季节）
  function makePeriodPicker(periodKey, state, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'ls-picker';

    const sel = document.createElement('select');
    sel.className = 'ls-picker-select';
    BASE_CHOICES.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = typeof c.label === 'function' ? c.label() : c.label;
      sel.appendChild(o);
    });

    const sub = document.createElement('div');
    sub.className = 'ls-picker-sub';
    sub.hidden = true;

    const yearSel = document.createElement('select');
    yearSel.className = 'ls-picker-mini';
    const monthSel = document.createElement('select');
    monthSel.className = 'ls-picker-mini';
    const seasonSel = document.createElement('select');
    seasonSel.className = 'ls-picker-mini';

    const mNone = document.createElement('option');
    mNone.value = '';
    mNone.textContent = '月份';
    monthSel.appendChild(mNone);
    for (let m = 1; m <= 12; m += 1) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = m + '月';
      monthSel.appendChild(o);
    }
    const sNone = document.createElement('option');
    sNone.value = '';
    sNone.textContent = '季节';
    seasonSel.appendChild(sNone);
    [['spring', '春季'], ['summer', '夏季'], ['autumn', '秋季'], ['winter', '冬季']].forEach(([v, l]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      seasonSel.appendChild(o);
    });

    // 年份：当年 + 数据里出现过的年份
    const setYears = (daily) => {
      const years = new Set([new Date().getFullYear()]);
      Object.keys(daily || {}).forEach((k) => {
        const y = Number(k.slice(0, 4));
        if (y >= 2000 && y <= 2100) years.add(y);
      });
      const list = [...years].sort((a, b) => b - a);
      const cur = yearSel.value;
      yearSel.innerHTML = '';
      list.forEach((y) => {
        const o = document.createElement('option');
        o.value = String(y);
        o.textContent = yy(y);
        yearSel.appendChild(o);
      });
      if (list.includes(Number(cur))) yearSel.value = cur;
    };

    const sync = () => {
      const p = state[periodKey];
      const id = typeof p === 'string' ? p : p.id;
      sel.value = id;
      const isCustom = id === 'custom';
      sub.hidden = !isCustom;
      if (isCustom) {
        if (!yearSel.value) yearSel.value = String(p.year || new Date().getFullYear());
        if (!monthSel.value && p.month) monthSel.value = String(p.month);
        if (!seasonSel.value && p.season) seasonSel.value = p.season;
      }
    };

    sel.addEventListener('change', () => {
      const id = sel.value;
      if (id === 'custom') {
        const prev = state[periodKey];
        state[periodKey] = {
          id: 'custom',
          year: (typeof prev === 'object' && prev.year) || new Date().getFullYear(),
          month: null,
          season: null,
        };
        sync();
      } else {
        state[periodKey] = { id };
      }
      onPick();
    });

    const commitCustom = () => {
      state[periodKey] = {
        id: 'custom',
        year: Number(yearSel.value) || new Date().getFullYear(),
        month: monthSel.value ? Number(monthSel.value) : null,
        season: seasonSel.value || null,
      };
      onPick();
    };
    yearSel.addEventListener('change', () => {
      monthSel.value = '';
      seasonSel.value = '';
      commitCustom();
    });
    monthSel.addEventListener('change', () => {
      seasonSel.value = '';
      commitCustom();
    });
    seasonSel.addEventListener('change', () => {
      monthSel.value = '';
      commitCustom();
    });

    wrap.appendChild(sel);
    sub.appendChild(yearSel);
    sub.appendChild(monthSel);
    sub.appendChild(seasonSel);
    wrap.appendChild(sub);

    return { el: wrap, sync, setYears };
  }

  function buildPanel(container) {
    cached = null;
    rangeCache.clear();
    let disposed = false; // 面板销毁标记：异步结果返回后不再写入已移除的 DOM
    let renderSeq = 0; // 渲染序号：只允许最新一次刷新更新面板
    const alive = () => !disposed && root.isConnected;
    const root = document.createElement('div');
    root.className = 'ls-root';
    container.appendChild(root);

    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'ls-wrap';
    root.appendChild(wrap);

    // 头部
    const header = document.createElement('div');
    header.className = 'ls-header';
    header.innerHTML =
      '<span class="ls-logo"></span>' +
      '<div class="ls-title-wrap"><div class="ls-title">本地听歌统计</div><div class="ls-sub">数据仅存本机 · 从启用起记录</div></div>' +
      '<button type="button" class="ls-refresh">刷新</button>';
    wrap.appendChild(header);
    const logoEl = header.querySelector('.ls-logo');
    const applyLogoData = (dataUrl) => {
      if (!logoEl || !dataUrl) return;
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = '本地听歌统计图标';
      img.width = 34;
      img.height = 34;
      img.style.cssText = 'display:block;width:34px;height:34px;object-fit:cover;border-radius:10px';
      logoEl.replaceChildren(img);
    };
    folium.rpc.call('getCustomIcon').then((r) => { if (r && r.ok && r.dataUrl) applyLogoData(r.dataUrl); }).catch(() => {});

    // 概览（常显）
    const overview = document.createElement('div');
    overview.className = 'ls-overview';
    wrap.appendChild(overview);

    // 栏目切换按钮
    const nav = document.createElement('div');
    nav.className = 'ls-nav';
    const NAVS = [
      ['rank', 'Top 榜单'],
      ['heat', '时段热力图'],
      ['recent', '最近播放'],
      ['fun', '趣味统计'],
      ['mgr', '数据管理'],
    ];
    NAVS.forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ls-nav-btn';
      b.dataset.view = id;
      b.textContent = label;
      nav.appendChild(b);
    });
    wrap.appendChild(nav);

    const views = document.createElement('div');
    views.className = 'ls-views';
    wrap.appendChild(views);

    // 状态
    const periods = { rank: 'all', heat: 'all', fun: 'all' };
    let rank = 'song';

    // —— Top 榜单 ——
    const rankSec = document.createElement('section');
    rankSec.className = 'ls-view';
    rankSec.dataset.view = 'rank';
    const rankHead = document.createElement('div');
    rankHead.className = 'ls-sec-head';
    rankHead.innerHTML = '<span class="ls-sec-title">Top 榜单</span>';
    const rankTabs = document.createElement('div');
    rankTabs.className = 'ls-ranktabs';
    [['song', '歌曲'], ['artist', '歌手'], ['album', '专辑']].forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.rank = id;
      b.textContent = label;
      b.className = 'ls-rank-tab';
      rankTabs.appendChild(b);
    });
    rankHead.appendChild(rankTabs);
    rankSec.appendChild(rankHead);
    const rankPicker = makePeriodPicker('rank', periods, () => { refresh(); });
    rankSec.appendChild(rankPicker.el);
    const rankBody = document.createElement('div');
    rankBody.className = 'ls-rank-body';
    rankSec.appendChild(rankBody);
    views.appendChild(rankSec);

    // —— 时段热力图 ——
    const heatSec = document.createElement('section');
    heatSec.className = 'ls-view';
    heatSec.dataset.view = 'heat';
    heatSec.innerHTML = '<div class="ls-sec-head"><span class="ls-sec-title">时段热力图</span></div>';
    const heatPicker = makePeriodPicker('heat', periods, () => { refresh(); });
    heatSec.appendChild(heatPicker.el);
    const heatBody = document.createElement('div');
    heatBody.className = 'ls-heat';
    heatSec.appendChild(heatBody);
    views.appendChild(heatSec);

    // —— 最近播放 ——
    const recentSec = document.createElement('section');
    recentSec.className = 'ls-view';
    recentSec.dataset.view = 'recent';
    recentSec.innerHTML = '<div class="ls-sec-head"><span class="ls-sec-title">最近播放（本会话内可点击播放）</span></div>';
    const recentBody = document.createElement('div');
    recentBody.className = 'ls-recent';
    recentSec.appendChild(recentBody);
    views.appendChild(recentSec);

    // —— 趣味统计 ——
    const funSec = document.createElement('section');
    funSec.className = 'ls-view';
    funSec.dataset.view = 'fun';
    funSec.innerHTML = '<div class="ls-sec-head"><span class="ls-sec-title">趣味统计</span></div>';
    const funPicker = makePeriodPicker('fun', periods, () => { refresh(); });
    funSec.appendChild(funPicker.el);
    const funBody = document.createElement('div');
    funBody.className = 'ls-fun';
    funSec.appendChild(funBody);
    views.appendChild(funSec);

    // —— 数据管理 ——
    const mgrSec = document.createElement('section');
    mgrSec.className = 'ls-view';
    mgrSec.dataset.view = 'mgr';
    mgrSec.innerHTML = '<div class="ls-sec-head"><span class="ls-sec-title">数据管理</span></div>';
    const mgrBody = document.createElement('div');
    mgrBody.className = 'ls-mgr';
    mgrSec.appendChild(mgrBody);
    views.appendChild(mgrSec);

    // 切换
    let activeView = 'rank';
    const setView = (id) => {
      activeView = id;
      nav.querySelectorAll('.ls-nav-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === id));
      views.querySelectorAll('.ls-view').forEach((v) => { v.hidden = v.dataset.view !== id; });
    };

    const setActive = () => {
      rankTabs.querySelectorAll('.ls-rank-tab').forEach((b) => {
        b.classList.toggle('is-on', b.dataset.rank === rank);
      });
      rankPicker.sync();
      heatPicker.sync();
      funPicker.sync();
    };

    const refresh = () => {
      const seq = ++renderSeq;
      // 不再无条件清理区间缓存：同一快照内切换栏目/榜单时复用区间结果，避免重复扫描流水文件；
      // 数据确实变化（显式刷新、清空、切换目录、finalize）时在对应位置单独清理
      getSnapshot().then((snap) => {
        if (!snap || disposed || seq !== renderSeq) return;
        rankPicker.setYears(snap.agg.daily);
        heatPicker.setYears(snap.agg.daily);
        funPicker.setYears(snap.agg.daily);
        rankPicker.sync();
        heatPicker.sync();
        funPicker.sync();
        renderOverview(snap, overview);
        renderRank(snap, rank, rankBody, periods.rank).catch(() => {});
        renderHeat(snap, heatBody, periods.heat);
        renderRecent(snap, recentBody);
        renderFun(snap, funBody, periods.fun).catch(() => {});
      }).catch(() => {});
    };

    nav.addEventListener('click', (ev) => {
      const b = ev.target.closest('.ls-nav-btn');
      if (!b) return;
      setView(b.dataset.view);
    });
    rankTabs.addEventListener('click', (ev) => {
      const b = ev.target.closest('.ls-rank-tab');
      if (!b) return;
      rank = b.dataset.rank;
      setActive();
      refresh();
    });
    header.querySelector('.ls-refresh').addEventListener('click', () => {
      cached = null;
      rangeCache.clear(); // 显式刷新：数据可能已更新，让区间聚合结果重算
      refresh();
    });

    // 数据管理按钮
    const mgrBtns = [
      { label: '导出备份', fn: async () => { const r = await folium.rpc.call('export').catch(() => null); folium.ui.toast(r && r.outputPath ? '已导出：' + r.outputPath : '导出失败', { type: r ? 'success' : 'error' }); } },
      { label: '设置完整播放比例', fn: async () => { const current = await folium.rpc.call('getCompletePercent').catch(() => ({ percent: 50 })); const initial = String(current && current.percent || 50); const input = await new Promise((resolve) => { const overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;'; const dialog = document.createElement('div'); dialog.style.cssText = 'width:min(360px,100%);padding:18px;border-radius:12px;background:var(--folium-bg,var(--background, #292929));color:inherit;border:1px solid rgba(128,128,128,.35);box-shadow:0 12px 40px rgba(0,0,0,.35);'; const title = document.createElement('div'); title.textContent = '设置完整播放比例'; title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px;'; const desc = document.createElement('div'); desc.textContent = '输入 1–100 的整数百分比。歌曲时长已知时按此比例判定完整播放；时长未知时仍按 30 秒判定。'; desc.style.cssText = 'font-size:12px;opacity:.8;line-height:1.5;margin-bottom:12px;'; const field = document.createElement('input'); field.type = 'number'; field.min = '1'; field.max = '100'; field.step = '1'; field.value = initial; field.style.cssText = 'box-sizing:border-box;width:100%;padding:9px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:inherit;margin-bottom:14px;'; const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;'; const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.className = 'ls-mgr-btn'; const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存'; save.className = 'ls-mgr-btn'; save.style.borderColor = 'var(--folium-accent, #888)'; const finish = (value) => { overlay.remove(); resolve(value); }; cancel.addEventListener('click', () => finish(null)); save.addEventListener('click', () => finish(field.value)); overlay.addEventListener('click', (ev) => { if (ev.target === overlay) finish(null); }); field.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finish(field.value); } if (ev.key === 'Escape') finish(null); }); actions.append(cancel, save); dialog.append(title, desc, field, actions); overlay.append(dialog); document.body.append(overlay); field.focus(); field.select(); }); if (input === null) return; const percent = Number(input); if (!Number.isInteger(percent) || percent < 1 || percent > 100) { folium.ui.toast('请输入 1 到 100 的整数百分比', { type: 'error' }); return; } const r = await folium.rpc.call('setCompletePercent', { percent }).catch((e) => ({ ok: false, error: String(e) })); folium.ui.toast(r && r.ok ? '完整播放比例已设置为 ' + r.percent + '%' : '设置失败：' + ((r && r.error) || '未知错误'), { type: r && r.ok ? 'success' : 'error' }); } },
      { label: '选择数据目录', fn: async () => {
        // Close the current segment against the old data root before the backend switches roots.
        // Resume a fresh segment afterward if playback was active; this prevents one session from
        // being written partly to the old directory and partly to the new directory.
        const resumeSong = cur && cur.song ? cur.song : null;
        const hadSession = !!resumeSong;
        if (hadSession) {
          const finalized = await finalize();
          if (finalized && finalized.ok === false) {
            folium.ui.toast('切换目录前保存当前播放记录失败：' + (finalized.error || '未知错误'), { type: 'error', durationMs: 4000 });
            if (getState() && getState().state === 'playing') startSession(resumeSong);
            return;
          }
        }
        const r = await folium.rpc.call('chooseDataDir').catch((e) => ({ ok: false, error: String(e) }));
        if (hadSession && getState() && getState().state === 'playing') startSession(resumeSong);
        if (r && r.ok) { cached = null; rangeCache.clear(); refresh(); folium.ui.toast(r.unchanged ? '当前已使用该目录' : '数据目录已切换：' + r.path, { type: 'success', durationMs: 4000 }); }
        else if (!(r && r.canceled)) folium.ui.toast('切换数据目录失败：' + ((r && r.error) || '未知错误'), { type: 'error', durationMs: 4000 });
      } },
      { label: '自定义图标', fn: async () => { const r = await folium.rpc.call('chooseCustomIcon').catch((e) => ({ ok: false, error: String(e) })); if (r && r.ok && r.dataUrl) { applyLogoData(r.dataUrl); folium.ui.toast('图标已更新（仅作用于统计面板）', { type: 'success' }); } else if (!(r && r.canceled)) folium.ui.toast('设置图标失败：' + ((r && r.error) || '未知错误'), { type: 'error' }); } },
      { label: '恢复默认图标', fn: async () => { const r = await folium.rpc.call('resetCustomIcon').catch((e) => ({ ok: false, error: String(e) })); if (r && r.ok && r.dataUrl) { applyLogoData(r.dataUrl); folium.ui.toast('已恢复默认猫咪图标', { type: 'success' }); } else folium.ui.toast('恢复默认图标失败：' + ((r && r.error) || '未知错误'), { type: 'error' }); } },
      { label: '打开数据目录', fn: () => { folium.rpc.call('openDir').catch(() => {}); } },
      { label: '清空统计', fn: () => { mgrClear() } },
    ];
    mgrBtns.forEach((b, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.className = 'ls-mgr-btn' + (b.label === '清空统计' ? ' ls-danger' : '');
      btn.addEventListener('click', b.fn);
      mgrBody.appendChild(btn);
    });
    let armTimer = null;
    const mgrClear = () => {
      const btn = mgrBody.querySelector('.ls-mgr-btn.ls-danger');
      if (!btn) return;
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = '再点一次确认清空';
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { btn.dataset.armed = ''; btn.textContent = '清空统计'; }, 5000);
        return;
      }
      btn.dataset.armed = '';
      btn.textContent = '清空统计';
      const includeBackups = window.confirm('是否同时删除已导出的 backups 备份文件？此操作不可恢复。');
      folium.rpc.call('clear', { includeBackups }).then((result) => {
        if (!result || result.ok !== true) { folium.ui.toast('清空失败：' + ((result && result.error) || '未知错误'), { type: 'error', durationMs: 4000 }); return; }
        cached = null; rangeCache.clear(); refresh();
        folium.ui.toast('已清空全部统计', { type: 'success', durationMs: 2000 });
      }).catch((e) => { folium.ui.toast('清空失败：' + String(e), { type: 'error', durationMs: 4000 }); });
    };

    setView(activeView);
    setActive();
    refresh();

    return { dispose: () => { disposed = true; clearTimeout(armTimer); root.remove(); } };
  }

  // ---------------- 渲染函数 ----------------

  function periodSecs(daily, period) {
    const start = rangeStart(period);
    let secs = 0;
    for (const k of Object.keys(daily)) {
      if (parseLocalDate(k).getTime() >= start) secs += daily[k].secs || 0;
    }
    return secs;
  }

  function renderOverview(snap, el) {
    const agg = snap.agg;
    const daily = agg.daily || {};
    const today = dayStrOf(Date.now());
    const todayDay = daily[today];
    // 只把实际有播放时长（secs > 0）的日期计入分母，避免 secs===0 的占位日期拉低“平均每日”
    const distinctDays = Object.values(daily).filter((day) => Number(day && day.secs) > 0).length;
    const likedSongs = Object.values(agg.songs || {}).filter((s) => (s.likes || 0) > 0).length;
    const cards = [
      ['今日', fmt(todayDay ? todayDay.secs : 0)],
      ['本周', fmt(periodSecs(daily, 'week'))],
      ['本月', fmt(periodSecs(daily, 'month'))],
      ['累计', fmt(agg.totals.secs)],
      ['完整播放', String(todayDay ? todayDay.complete : 0)],
      ['喜欢的歌', String(likedSongs)],
      ['曲目数', String(Object.keys(snap.songs || {}).length)],
      ['平均每日', fmt(distinctDays ? agg.totals.secs / distinctDays : 0)],
    ];
    el.innerHTML = cards.map(([label, value]) =>
      '<div class="ls-card"><div class="ls-card-label">' + label + '</div><div class="ls-card-value">' + value + '</div></div>'
    ).join('');
  }

  async function renderRank(snap, kind, el, period) {
    const agg = snap.agg;
    const isAll = isAllPeriod(period);
    let rows = [];
    if (isAll) {
      const start = 0;
      if (kind === 'song') {
        rows = Object.entries(agg.songs || {})
          .filter(([k, s]) => s.lastTs >= start)
          .map(([k, s]) => {
            const info = snap.songs[k] || {};
            return { name: info.title || '未知歌曲', sub: info.artist || '', secs: s.secs, plays: s.plays };
          });
      } else if (kind === 'artist') {
        rows = Object.entries(agg.artists || {})
          .filter(([k, s]) => s.lastTs >= start)
          .map(([k, s]) => ({ name: k, sub: '', secs: s.secs, plays: s.plays }));
      } else {
        rows = Object.entries(agg.albums || {})
          .filter(([k, s]) => s.lastTs >= start)
          .map(([k, s]) => ({ name: k, sub: '', secs: s.secs, plays: s.plays }));
      }
    } else {
      // 非"全部"：优先按播放流水精确聚合；若流水缺失（早期版本无流水记录），
      // 进行中的时段（本周/本月/当季/今年）回退为"最后播放时间在区间内"过滤累计值
      // （集合正确，数值为累计近似），已结束的过去时段则显示空
      const ra = await getRange(period);
      if (!alive()) return; // 面板已销毁或已被更新：不再写入 DOM
      if (ra === null) {
        el.innerHTML = '<div class="ls-empty">统计服务未就绪，请完全重启 Folia 后重试</div>';
        return;
      }
      if (!ra || ra.empty) {
        // 仅当 now 落在区间内（本周/本月/当季/今年等进行中的时段）才回退累计值；
        // 已结束的过去时段与尚未开始的未来时段（如 26 年冬季）都显示空
        const nowTs = Date.now();
        const isCurrent = rangeStart(period) <= nowTs && rangeEnd(period) > nowTs;
        if (!isCurrent) {
          el.innerHTML = '<div class="ls-empty">该时间段还没有记录</div>';
          return;
        }
        const start = rangeStart(period);
        if (kind === 'song') {
          rows = Object.entries(agg.songs || {})
            .filter(([k, s]) => s.lastTs >= start)
            .map(([k, s]) => {
              const info = snap.songs[k] || {};
              return { name: info.title || '未知歌曲', sub: info.artist || '', secs: s.secs, plays: s.plays };
            });
        } else if (kind === 'artist') {
          rows = Object.entries(agg.artists || {})
            .filter(([k, s]) => s.lastTs >= start)
            .map(([k, s]) => ({ name: k, sub: '', secs: s.secs, plays: s.plays }));
        } else {
          rows = Object.entries(agg.albums || {})
            .filter(([k, s]) => s.lastTs >= start)
            .map(([k, s]) => ({ name: k, sub: '', secs: s.secs, plays: s.plays }));
        }
      } else if (kind === 'song') {
        rows = Object.entries(ra.songs || {}).map(([k, s]) => {
          const info = snap.songs[k] || {};
          return { name: info.title || '未知歌曲', sub: info.artist || '', secs: s.secs, plays: s.plays };
        });
      } else if (kind === 'artist') {
        rows = Object.entries(ra.artists || {}).map(([k, s]) => ({ name: k, sub: '', secs: s.secs, plays: s.plays }));
      } else {
        rows = Object.entries(ra.albums || {}).map(([k, s]) => ({ name: k, sub: '', secs: s.secs, plays: s.plays }));
      }
    }
    rows.sort((a, b) => b.secs - a.secs);
    const top = rows.slice(0, 7);
    if (!top.length) {
      el.innerHTML = '<div class="ls-empty">该时间段还没有记录</div>';
      return;
    }
    const max = top[0].secs || 1;
    el.innerHTML = top.map((r, i) =>
      '<div class="ls-rank-row">' +
      '<span class="ls-rank-no">' + (i + 1) + '</span>' +
      '<div class="ls-rank-main">' +
      '<div class="ls-rank-name">' + esc(r.name) + '</div>' +
      (r.sub ? '<div class="ls-rank-artist">' + esc(r.sub) + '</div>' : '') +
      '<div class="ls-rank-bar"><i style="width:' + Math.max(2, Math.round((r.secs / max) * 100)) + '%"></i></div>' +
      '</div>' +
      '<div class="ls-rank-meta"><span class="ls-rank-secs">' + fmt(r.secs) + '</span><span class="ls-rank-plays">' + r.plays + ' 次</span></div>' +
      '</div>'
    ).join('');
  }

  // 时段热力图：纵横坐标随时间筛选变化
  //  本周/上周 → 完整星期 × 24h 表格（固定 7 行，无数据格子弱色）
  //  10月（当月）/ 其他+某月 → 日历格式
  //  秋季（当季）/ 其他+某季 → 3 个月历块（冬季跨年自动处理）
  //  26年（今年）/ 其他+仅年份 → 完整 12 月 × 24h
  //  全部 → 有记录按月
  function renderHeat(snap, el, period) {
    const daily = snap.agg.daily || {};
    const id = typeof period === 'string' ? period : period.id;
    const start = rangeStart(period);
    const dates = Object.keys(daily).filter((k) => parseLocalDate(k).getTime() >= start).sort();
    const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
    const isEmpty = () => { el.innerHTML = '<div class="ls-empty">该时间段暂无数据</div>'; };

    // 日历块：某个月份，7 列星期 × 周行，每格一天，色块深浅 = 当天时长
    const calendarBlock = (prefix) => {
      const [y, m] = prefix.split('-').map(Number);
      const startDow = new Date(y, m - 1, 1).getDay();
      const dim = new Date(y, m, 0).getDate();
      const secsByDay = {};
      const hourInfo = {};
      let max = 0;
      for (const k of Object.keys(daily)) {
        if (!k.startsWith(prefix)) continue;
        const d = Number(k.slice(8));
        const secs = daily[k].secs || 0;
        secsByDay[d] = secs;
        if (secs > max) max = secs;
        if (daily[k].hours) {
          let bv = 0, bh = -1;
          for (let h = 0; h < 24; h += 1) if (daily[k].hours[h] > bv) { bv = daily[k].hours[h]; bh = h; }
          if (bh >= 0) hourInfo[d] = String(bh).padStart(2, '0') + ':00';
        }
      }
      let html = '<div class="ls-cal"><div class="ls-cal-head">' + y + ' 年 ' + m + ' 月</div><div class="ls-cal-grid">';
      DAY_NAMES.forEach((n) => { html += '<div class="ls-cal-dow">' + n + '</div>'; });
      for (let i = 0; i < startDow; i += 1) html += '<div class="ls-cal-cell ls-cal-empty"></div>';
      for (let d = 1; d <= dim; d += 1) {
        const v = secsByDay[d] || 0;
        if (v > 0) {
          const a = Math.max(0.15, Math.min(1, 0.15 + 0.85 * (v / max)));
          html += '<div class="ls-cal-cell" style="background:rgba(139,92,246,' + a.toFixed(2) + ')" title="' + m + '/' + d + ' · ' + fmt(v) + (hourInfo[d] ? ' · 活跃 ' + hourInfo[d] : '') + '">' + d + '</div>';
        } else {
          html += '<div class="ls-cal-cell ls-cal-none">' + d + '</div>';
        }
      }
      html += '</div></div>';
      return html;
    };

    const renderCal = (blocks) => {
      const hasData = blocks.some((p) => Object.keys(daily).some((k) => k.startsWith(p) && (daily[k].secs || 0) > 0));
      if (!hasData) { isEmpty(); return; }
      el.innerHTML = blocks.map(calendarBlock).join('');
    };

    // 季节 → 3 个月份前缀（冬季跨年：12月归 y，1/2 月归 y+1）
    const seasonBlocks = (y, s) => {
      const set = { spring: [3, 4, 5], summer: [6, 7, 8], autumn: [9, 10, 11], winter: [12, 1, 2] }[s];
      return set.map((mm) => {
        const realY = mm === 12 ? y : (mm <= 2 ? y + 1 : y);
        return realY + '-' + String(mm).padStart(2, '0');
      });
    };

    const renderGrid = (rows, force) => {
      if (!force) {
        let any = false;
        for (const r of rows) for (let h = 0; h < 24; h += 1) if (r.hours[h] > 0) any = true;
        if (!any) { isEmpty(); return; }
      }
      let max = 0;
      for (const r of rows) for (let h = 0; h < 24; h += 1) max = Math.max(max, r.hours[h]);
      let html = '<div class="ls-heat-grid">';
      for (const r of rows) {
        html += '<div class="ls-heat-dow">' + esc(r.label) + '</div>';
        for (let h = 0; h < 24; h += 1) {
          const v = r.hours[h];
          if (v > 0) {
            const a = Math.max(0.18, Math.min(1, 0.18 + 0.82 * (v / max)));
            html += '<div class="ls-heat-cell" style="background:rgba(139,92,246,' + a.toFixed(2) + ')" title="' + esc(r.label) + ' ' + String(h).padStart(2, '0') + ':00 · ' + fmt(v) + '"></div>';
          } else {
            html += '<div class="ls-heat-cell ls-heat-zero" title="' + esc(r.label) + ' ' + String(h).padStart(2, '0') + ':00 · 无记录"></div>';
          }
        }
      }
      html += '<div class="ls-heat-hour-labels">';
      for (let h = 0; h < 24; h += 1) {
        html += '<span>' + (h % 6 === 0 ? h : '') + '</span>';
      }
      html += '</div></div>';
      el.innerHTML = html;
    };

    // 7 天 × 24h（本周 / 上周，固定完整星期）
    const renderWeek = (startTs) => {
      const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
      const rows = [];
      // 用本地日历日期递增，而不是固定 86400000ms：夏令时切换日不是 24 小时，固定增量会重复或跳过日期
      const day = new Date(startTs);
      for (let i = 0; i < 7; i += 1) {
        const ds = dayStrOf(day.getTime());
        const d = daily[ds];
        const hours = Array(24).fill(0);
        if (d && d.hours) for (let h = 0; h < 24; h += 1) hours[h] = d.hours[h] || 0;
        rows.push({ label: WEEK_LABELS[i], hours });
        day.setDate(day.getDate() + 1);
      }
      renderGrid(rows, true);
    };

    // 指定年份完整 12 月 × 24h
    const renderYear = (y) => {
      const rows = [];
      for (let m = 1; m <= 12; m += 1) {
        const prefix = y + '-' + String(m).padStart(2, '0');
        const hours = Array(24).fill(0);
        dates.forEach((k) => {
          if (!k.startsWith(prefix)) return;
          const d = daily[k];
          if (d && d.hours) for (let h = 0; h < 24; h += 1) hours[h] += d.hours[h] || 0;
        });
        rows.push({ label: m + '月', hours });
      }
      renderGrid(rows, true);
    };

    // 全部 → 有记录按月
    const renderAll = () => {
      const byMonth = {};
      dates.forEach((k) => {
        const m = k.slice(0, 7);
        if (!byMonth[m]) byMonth[m] = Array(24).fill(0);
        const d = daily[k];
        if (d && d.hours) for (let h = 0; h < 24; h += 1) byMonth[m][h] += d.hours[h] || 0;
      });
      const rows = Object.keys(byMonth).sort().map((m) => ({
        label: m.slice(2).replace('-', '/'),
        hours: byMonth[m],
      }));
      renderGrid(rows);
    };

    const now = new Date();
    if (id === 'week' || id === 'lastWeek') {
      renderWeek(rangeStart(period));
      return;
    }
    if (id === 'month') {
      renderCal([now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')]);
      return;
    }
    if (id === 'season') {
      renderCal(seasonBlocks(now.getFullYear(), currentSeasonKey()));
      return;
    }
    if (id === 'year') {
      renderYear(now.getFullYear());
      return;
    }
    if (id === 'custom') {
      const y = period.year || now.getFullYear();
      if (period.month) {
        renderCal([y + '-' + String(period.month).padStart(2, '0')]);
        return;
      }
      if (period.season) {
        renderCal(seasonBlocks(y, period.season));
        return;
      }
      renderYear(y);
      return;
    }
    renderAll();
  }

  function renderRecent(snap, el) {
    const recent = snap.agg.recent || [];
    const songs = snap.songs || {};
    if (!recent.length) {
      el.innerHTML = '<div class="ls-empty">还没有播放记录</div>';
      return;
    }
    const rows = recent.map((r) => {
      const info = songs[r.key] || {};
      const playable = sessionRefs.has(r.key);
      return '<div class="ls-recent-row' + (playable ? ' ls-playable' : '') + '" data-key="' + r.key + '">' +
        '<div class="ls-recent-main"><div class="ls-recent-name">' + esc(info.title || '未知歌曲') + '</div>' +
        '<div class="ls-recent-sub">' + esc(info.artist || '未知歌手') + (playable ? ' · 可播放' : ' · 本次启动前播放') + '</div></div>' +
        '<div class="ls-recent-tag ' + (r.complete ? 'ls-tag-ok' : 'ls-tag-skip') + '">' + (r.complete ? '完整' : '跳过') + '</div>' +
        '<div class="ls-recent-secs">' + fmt(r.secs) + '</div>' +
        '<div class="ls-recent-time">' + fmtDay(r.ts) + ' ' + fmtHm(r.ts) + '</div>' +
        '</div>';
    }).join('');
    el.innerHTML = rows;
    el.querySelectorAll('.ls-recent-row.ls-playable').forEach((row) => {
      row.addEventListener('click', () => {
        const dto = sessionRefs.get(row.dataset.key);
        if (!dto) return;
        folium.playback.playSong(dto).then((ok) => {
          if (ok === false) folium.ui.toast('无法播放这首歌曲', { type: 'error' });
        }).catch(() => {});
      });
    });
  }

  // 趣味统计：按时间范围聚合可时间化的项目（时长/深夜/工作日周末/连续打卡/会话数），歌曲类项目用区间精确聚合
  async function renderFun(snap, el, period) {
    const agg = snap.agg;
    const fun = agg.fun || {};
    const songs = agg.songs || {};
    const daily = agg.daily || {};
    const start = rangeStart(period);
    const end = rangeEnd(period);
    // 区间内的天：含起点、不含终点（避免把本周的天算进"上周"等过去时段）
    const days = Object.keys(daily).filter((k) => {
      const t = parseLocalDate(k).getTime();
      return t >= start && t < end;
    }).sort();
    let pSecs = 0, pNight = 0, pWork = 0, pWeekend = 0, pSessions = 0, pComplete = 0, pSkip = 0;
    const hours = Array(24).fill(0);
    for (const k of days) {
      const d = daily[k];
      pSecs += d.secs || 0;
      pSessions += d.sessions || 0;
      pComplete += d.complete || 0;
      pSkip += d.skip || 0;
      const dow = parseLocalDate(k).getDay();
      if (dow >= 1 && dow <= 5) pWork += d.secs || 0; else pWeekend += d.secs || 0;
      if (d.hours) {
        for (let h = 0; h < 24; h += 1) {
          const v = d.hours[h] || 0;
          hours[h] += v;
          if (h >= 23 || h < 5) pNight += v;
        }
      }
    }
    // 范围内连续打卡
    let streak = 0, maxStreak = 0, run = 0, prev = null;
    for (const k of days) {
      const t = parseLocalDate(k).getTime();
      if (prev !== null && t - prev === 86400000) run += 1; else run = 1;
      if (run > maxStreak) maxStreak = run;
      prev = t;
    }
    streak = run;
    // 范围内最活跃时段
    let bestHour = -1, bestVal = 0;
    hours.forEach((v, h) => { if (v > bestVal) { bestVal = v; bestHour = h; } });
    // 范围内最久一天
    let longDay = null;
    for (const k of days) {
      if (!longDay || daily[k].secs > daily[longDay].secs) longDay = k;
    }
    const skipRate = (pComplete + pSkip) > 0 ? Math.round((pSkip / (pComplete + pSkip)) * 100) : 0;
    // 循环王 / 最早最晚开始：全部用累计；其他时段优先用流水精确聚合，
    // 流水缺失时进行中的时段回退为"最后播放时间在区间内"的累计近似，过去时段显示空
    const isAll = isAllPeriod(period);
    let ra = null;
    if (!isAll) ra = await getRange(period);
    if (!alive()) return; // 面板已销毁或已被更新：不再写入 DOM
    // 仅当 now 落在区间内才是"进行中"时段；过去与未来时段（如 26 年冬季）都不回退累计值
    const nowTs = Date.now();
    const isCurrent = !isAll && ra !== null && rangeStart(period) <= nowTs && rangeEnd(period) > nowTs;
    let loop = null, earliest = null, latest = null;
    if (isAll) {
      loop = Object.entries(songs).sort((a, b) => b[1].plays - a[1].plays)[0];
      earliest = fun.earliest || null;
      latest = fun.latest || null;
    } else if (ra && !ra.empty) {
      loop = Object.entries(ra.songs || {}).sort((a, b) => b[1].plays - a[1].plays)[0];
      earliest = ra.earliest || null;
      latest = ra.latest || null;
    } else if (isCurrent) {
      const sStart = rangeStart(period);
      loop = Object.entries(songs).filter(([k, s]) => s.lastTs >= sStart).sort((a, b) => b[1].plays - a[1].plays)[0];
      earliest = fun.earliest || null;
      latest = fun.latest || null;
    }
    const items = [
      ['连续打卡', String(streak || 0) + ' 天'],
      ['最长连续', String(maxStreak || 0) + ' 天'],
      ['深夜听歌', fmt(pNight)],
      ['最活跃时段', bestHour >= 0 ? String(bestHour).padStart(2, '0') + ':00' : '—'],
      ['切歌跳过率', skipRate + '%'],
      ['工作日时长', fmt(pWork)],
      ['周末时长', fmt(pWeekend)],
      ['循环王', loop ? esc(snap.songs[loop[0]]?.title || '未知歌曲') + ' · ' + loop[1].plays + ' 次' : '—'],
      ['最早开始', earliest || '—'],
      ['最晚开始', latest || '—'],
      ['最久一天', longDay ? fmtDay(new Date(longDay).getTime()) + ' · ' + fmt(daily[longDay].secs) : '—'],
      ['播放会话总数', String(pSessions)],
    ];
    el.innerHTML = items.map(([label, value]) =>
      '<div class="ls-fun-card"><div class="ls-fun-label">' + label + '</div><div class="ls-fun-value">' + value + '</div></div>'
    ).join('');
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS_TEXT = `
@keyframes lsFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ls-root{color:var(--folium-primary,#e8e8ec);font-family:var(--folium-font,system-ui);min-width:0;overflow-x:hidden;animation:lsFade .2s ease;}
.ls-wrap{padding:16px 18px 28px;display:flex;flex-direction:column;gap:16px;max-height:88vh;overflow:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none;}
.ls-wrap::-webkit-scrollbar{display:none;width:0;height:0;}
.ls-header{display:flex;align-items:center;gap:10px;}
.ls-logo{flex:none;filter:drop-shadow(0 0 6px rgba(139,92,246,.5));}
.ls-title-wrap{flex:1;min-width:0;}
.ls-title{font-size:16px;font-weight:700;letter-spacing:.02em;}
.ls-sub{font-size:11px;opacity:.5;margin-top:1px;}
.ls-refresh{flex:none;border:1px solid rgba(139,92,246,.45);background:rgba(139,92,246,.16);color:inherit;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;}
.ls-refresh:hover{background:rgba(139,92,246,.3);}
.ls-overview{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}
.ls-card{background:rgba(128,128,128,.09);border:1px solid rgba(128,128,128,.16);border-radius:12px;padding:10px 12px;min-width:0;}
.ls-card-label{font-size:11px;opacity:.6;letter-spacing:.04em;font-weight:600;white-space:nowrap;}
.ls-card-value{font-size:16px;font-weight:700;margin-top:4px;white-space:nowrap;line-height:1.25;}
.ls-nav{display:flex;gap:6px;}
.ls-nav-btn{flex:1;border:1px solid rgba(128,128,128,.28);background:transparent;color:inherit;border-radius:8px;padding:6px 4px;font-size:12px;cursor:pointer;text-align:center;white-space:nowrap;}
.ls-nav-btn.is-on{background:var(--folium-accent,rgba(139,92,246,.85));border-color:transparent;color:#fff;font-weight:600;}
.ls-views{display:flex;flex-direction:column;gap:16px;}
.ls-view{display:flex;flex-direction:column;gap:10px;overflow-x:hidden;min-width:0;}
.ls-view[hidden]{display:none;}
.ls-sec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.ls-sec-title{font-size:14px;font-weight:700;}
.ls-ranktabs{display:flex;gap:4px;}
.ls-rank-tab{border:0;background:transparent;color:inherit;opacity:.55;font-size:12px;padding:4px 8px;cursor:pointer;border-radius:6px;}
.ls-rank-tab.is-on{opacity:1;background:rgba(139,92,246,.18);font-weight:600;}
.ls-picker{display:flex;flex-direction:column;gap:6px;}
.ls-picker-select{background:rgba(128,128,128,.1);color:inherit;border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:5px 8px;font-size:12px;cursor:pointer;min-width:0;width:100%;}
.ls-picker-select:focus,.ls-picker-mini:focus{outline:none;box-shadow:none;border-color:rgba(128,128,128,.28);}
.ls-picker-select option{background:#16161c;color:inherit;}
.ls-picker-sub{display:flex;gap:6px;flex-wrap:wrap;}
.ls-picker-sub[hidden]{display:none;}
.ls-picker-mini{flex:1;min-width:64px;background:rgba(128,128,128,.1);color:inherit;border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:4px 6px;font-size:11px;cursor:pointer;}
.ls-picker-mini option{background:#16161c;color:inherit;}
.ls-rank-body{max-height:52vh;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none;}
.ls-rank-body::-webkit-scrollbar{display:none;width:0;height:0;}
.ls-rank-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:rgba(128,128,128,.06);margin-bottom:6px;}
.ls-rank-no{flex:none;width:22px;text-align:center;font-size:14px;font-weight:700;color:var(--folium-accent,rgba(139,92,246,.9));}
.ls-rank-main{flex:1;min-width:0;}
.ls-rank-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;}
.ls-rank-artist{font-size:11px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;margin-top:1px;}
.ls-rank-bar{height:5px;background:rgba(128,128,128,.15);border-radius:3px;margin-top:5px;overflow:hidden;}
.ls-rank-bar i{display:block;height:100%;background:linear-gradient(90deg,rgba(139,92,246,.7),rgba(139,92,246,.95));border-radius:3px;}
.ls-rank-meta{flex:none;text-align:right;}
.ls-rank-secs{font-size:13px;font-weight:600;}
.ls-rank-plays{display:block;font-size:10px;opacity:.5;}
.ls-heat{max-height:52vh;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none;}
.ls-heat::-webkit-scrollbar{display:none;width:0;height:0;}
.ls-heat-grid{display:grid;grid-template-columns:34px repeat(24,1fr);gap:2px;}
.ls-heat-dow{font-size:8px;opacity:.6;display:flex;align-items:center;justify-content:flex-end;padding-right:2px;white-space:nowrap;}
.ls-cal{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;}
.ls-cal:last-child{margin-bottom:0;}
.ls-cal-head{font-size:12px;font-weight:700;opacity:.8;}
.ls-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}
.ls-cal-dow{font-size:9px;opacity:.55;text-align:center;padding:2px 0;}
.ls-cal-cell{aspect-ratio:1;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;min-width:0;}
.ls-cal-empty{background:transparent;}
.ls-cal-none{color:rgba(200,200,210,.28);}
.ls-heat-cell{aspect-ratio:1;border-radius:2px;min-width:6px;background:rgba(128,128,128,.07);border:1px solid rgba(128,128,128,.09);}
.ls-heat-zero{background:rgba(128,128,128,.07);}
.ls-heat-hour-labels{grid-column:2/26;display:flex;justify-content:space-between;font-size:8px;opacity:.45;margin-top:2px;overflow:hidden;}
.ls-heat-hour-labels span{width:0;overflow:visible;}
.ls-recent{max-height:52vh;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none;display:flex;flex-direction:column;gap:6px;}
.ls-recent::-webkit-scrollbar{display:none;width:0;height:0;}
.ls-recent-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:rgba(128,128,128,.06);}
.ls-recent-row.ls-playable{cursor:pointer;}
.ls-recent-row.ls-playable:hover{background:rgba(139,92,246,.14);}
.ls-recent-main{flex:1;min-width:0;}
.ls-recent-name{font-size:13px;font-weight:600;word-break:break-word;line-height:1.3;}
.ls-recent-sub{font-size:11px;opacity:.55;word-break:break-word;line-height:1.3;}
.ls-recent-tag{flex:none;font-size:10px;padding:2px 8px;border-radius:999px;font-weight:600;}
.ls-tag-ok{background:rgba(34,197,94,.18);color:#4ade80;}
.ls-tag-skip{background:rgba(245,158,11,.16);color:#fbbf24;}
.ls-recent-secs{flex:none;font-size:12px;font-weight:600;opacity:.8;}
.ls-recent-time{flex:none;font-size:10px;opacity:.5;}
.ls-fun{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}
.ls-fun-card{background:rgba(128,128,128,.07);border:1px solid rgba(128,128,128,.13);border-radius:10px;padding:8px 10px;min-width:0;}
.ls-fun-label{font-size:11px;opacity:.6;white-space:nowrap;}
.ls-fun-value{font-size:13px;font-weight:600;margin-top:3px;word-break:break-word;line-height:1.3;}
.ls-mgr{display:flex;gap:8px;flex-wrap:wrap;}
.ls-mgr-btn{border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;}
.ls-mgr-btn:hover{background:rgba(128,128,128,.12);}
.ls-mgr-btn.ls-danger{border-color:rgba(239,68,68,.75);color:#f87171;}
.ls-mgr-btn:not(.ls-danger){border-color:rgba(255,255,255,.72);}
.ls-empty{font-size:12px;opacity:.5;padding:14px 0;text-align:center;}
`;
