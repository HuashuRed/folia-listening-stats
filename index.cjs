'use strict';
// listening-stats/index.cjs — main 入口（Node 进程）
// 职责：接收 client 的播放会话记录，用 Node fs 持久化到独立数据目录
//   %APPDATA%\Folia\listening-stats\
// 结构：
//   songs.json          歌曲信息字典（key -> {title, artist, album, source}）
//   agg.json            全量聚合（歌曲/歌手/专辑/每日/时段/音源/最近播放/趣味统计）
//   events/YYYY-MM.ndjson  全量播放流水（追加，每行一条会话）
//   session.json        进行中会话心跳（强退时恢复，最多丢 20 秒）
//   backups/*.json      导出备份
// 该目录独立于模组本体，卸载/更新模组不影响数据。

const fs = require('fs');
const path = require('path');
const os = require('os');

const APP = 'Folia';
const SUB = 'listening-stats';
const RECENT_LIMIT = 150;

// 数据目录：优先用 Folia 为模组分配的数据目录（api.storage.paths.data，更新时保留）；
// 仅当宿主 API 不可用（如独立调试）时回退到旧约定目录。
function dataRoot() {
  if (api && api.storage && api.storage.paths && api.storage.paths.data) return api.storage.paths.data;
  return legacyDataRoot();
}

function legacyDataRoot() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP, SUB);
}

// 首次启动迁移：旧目录（%APPDATA%\Folia\listening-stats\）里已有的数据复制到模组数据目录。
// 只在目标目录为空（全新安装）时执行一次；不删除旧目录，避免任何丢失风险。
function migrateLegacy() {
  if (!api || !api.storage || !api.storage.paths || !api.storage.paths.data) return;
  const target = api.storage.paths.data;
  const legacy = legacyDataRoot();
  if (!legacy || legacy === target) return;
  let targetHasData = false;
  try { targetHasData = fs.existsSync(target) && fs.readdirSync(target).length > 0; } catch (e) { targetHasData = false; }
  if (targetHasData) return;
  if (!fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const it of ['agg.json', 'songs.json', 'session.json', 'events', 'backups']) {
      const s = path.join(legacy, it);
      if (!fs.existsSync(s)) continue;
      const d = path.join(target, it);
      if (fs.statSync(s).isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        for (const f of fs.readdirSync(s)) fs.copyFileSync(path.join(s, f), path.join(d, f));
      } else {
        fs.copyFileSync(s, d);
      }
    }
    try { if (api) api.log.info('listening-stats: migrated data from ' + legacy); } catch (err) {}
  } catch (e) {
    try { if (api) api.log.warn('listening-stats migrate failed', String(e)); } catch (err) {}
  }
}

function ensureDirs() {
  const root = dataRoot();
  fs.mkdirSync(path.join(root, 'events'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
  return root;
}

// ---------- 工具 ----------

function songKey(song) {
  const s = song && typeof song === 'object' ? song : {};
  const raw = [s.source || '', s.id || '', s.title || '', s.artist || ''].join('\u0001');
  let h = 5381;
  for (let i = 0; i < raw.length; i += 1) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return 'k' + h.toString(36) + '_' + raw.length.toString(36);
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function dateStr(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function emptyHourly() {
  const h = [];
  for (let w = 0; w < 7; w += 1) { const row = new Array(24); row.fill(0); h.push(row); }
  return h;
}

function emptyAgg() {
  return {
    totals: { secs: 0, complete: 0, skip: 0, like: 0, sessions: 0 },
    songs: {},
    artists: {},
    albums: {},
    daily: {},
    hourly: emptyHourly(),
    sources: {},
    recent: [],
    fun: { streak: 0, maxStreak: 0, nightSecs: 0, earliest: null, latest: null, workSecs: 0, weekendSecs: 0 },
    firstTs: null,
  };
}

function isComplete(rec) {
  const dur = Number(rec.dur) || 0;
  const secs = Number(rec.secs) || 0;
  if (dur > 0) return secs >= Math.min(30, dur / 2);
  return secs >= 30;
}

// ---------- 状态 ----------

let api = null;
let state = null; // { songs, agg, session }
let saveTimer = null;

function load() {
  const root = dataRoot();
  let songs = {};
  let agg = null;
  try { songs = JSON.parse(fs.readFileSync(path.join(root, 'songs.json'), 'utf8')); } catch (e) { songs = {}; }
  try { agg = JSON.parse(fs.readFileSync(path.join(root, 'agg.json'), 'utf8')); } catch (e) { agg = emptyAgg(); }
  if (!agg.totals) agg = emptyAgg();
  if (!agg.hourly || agg.hourly.length !== 7) agg.hourly = emptyHourly();

  state = { songs, agg, session: null };

  // 回填：1.3 之前的旧数据没有按小时明细，从流水重建（只补 hours 缺失的天，幂等）
  backfillHours();

  // 上次强退留下的进行中会话：补记一条，最多丢最后一次心跳后的几秒
  let session = null;
  try { session = JSON.parse(fs.readFileSync(path.join(root, 'session.json'), 'utf8')); } catch (e) { session = null; }
  if (session && typeof session === 'object') {
    if (Number(session.secs) >= 3) {
      recordSession({
        song: session.song || null,
        secs: Number(session.secs),
        liked: !!session.liked,
        dur: Number(session.dur) || 0,
        ts: Number(session.startedAt) || Date.now(),
      });
    }
    try { fs.unlinkSync(path.join(root, 'session.json')); } catch (e) {}
  }
}

function backfillHours() {
  if (!state || !state.agg) return;
  const daily = state.agg.daily;
  const evDir = path.join(dataRoot(), 'events');
  if (!fs.existsSync(evDir)) return;
  const need = new Set();
  for (const k of Object.keys(daily)) if (!daily[k].hours) need.add(k);
  if (!need.size) return;
  let rebuilt = false;
  const files = [];
  try { files.push(...fs.readdirSync(evDir).filter((f) => f.endsWith('.ndjson')).sort()); } catch (e) { return; }
  for (const f of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(evDir, f), 'utf8').split('\n'); } catch (e) { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      const ts = Number(ev.ts);
      const secs = Math.floor(Number(ev.secs) || 0);
      if (!ts || secs <= 0) continue;
      const ds = dateStr(ts);
      if (!need.has(ds)) continue;
      const day = daily[ds];
      if (!day) continue;
      if (!day.hours) { day.hours = Array(24).fill(0); rebuilt = true; }
      day.hours[new Date(ts).getHours()] = (day.hours[new Date(ts).getHours()] || 0) + secs;
    }
  }
  if (rebuilt) saveNow().catch(() => {});
}

// 原子写入：先写临时文件再 rename，避免半写损坏
async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  await fs.promises.rename(tmp, file);
}

// 汇总文件落盘（异步原子）。只由播放结束（finalize）或防抖定时触发，
// 不在心跳里调用——心跳只写 session.json。
async function saveNow() {
  if (!state) return;
  const root = dataRoot();
  try {
    await writeJsonAtomic(path.join(root, 'agg.json'), state.agg);
    await writeJsonAtomic(path.join(root, 'songs.json'), state.songs);
    if (state.session) {
      await writeJsonAtomic(path.join(root, 'session.json'), state.session);
    } else {
      try { await fs.promises.unlink(path.join(root, 'session.json')); } catch (e) {}
    }
  } catch (e) {
    try { if (api) api.log.warn('stats save failed', String(e)); } catch (err) {}
  }
}

// 心跳只写进行中会话（轻量），不重写会持续增长的汇总文件
async function saveSessionNow() {
  if (!state) return;
  try {
    await writeJsonAtomic(path.join(dataRoot(), 'session.json'), state.session);
  } catch (e) {
    try { if (api) api.log.warn('session save failed', String(e)); } catch (err) {}
  }
}

function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, 30000);
}

function appendEvent(rec) {
  const root = dataRoot();
  const d = new Date(rec.ts);
  const file = path.join(root, 'events', d.getFullYear() + '-' + pad(d.getMonth() + 1) + '.ndjson');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (e) {
    try { if (api) api.log.warn('stats append failed', String(e)); } catch (err) {}
  }
}

// ---------- 记录一条完整会话 ----------

function recordSession(rec) {
  if (!state) return;
  const agg = state.agg;
  const songs = state.songs;
  const key = songKey(rec.song);
  const secs = Math.max(0, Math.floor(Number(rec.secs) || 0));
  if (secs < 3) return;
  const complete = isComplete(rec);
  const skip = !complete;
  const liked = !!rec.liked;
  const ts = Number(rec.ts) || Date.now();
  const d = new Date(ts);
  const ds = dateStr(ts);
  const wd = d.getDay();
  const hr = d.getHours();

  // 歌曲信息字典
  if (!songs[key]) {
    songs[key] = {
      title: (rec.song && rec.song.title) || '未知歌曲',
      artist: (rec.song && rec.song.artist) || '未知歌手',
      album: (rec.song && rec.song.album) || null,
      source: (rec.song && rec.song.source) || 'local',
    };
  }

  // 歌曲聚合
  const s = agg.songs[key] || { plays: 0, completePlays: 0, skips: 0, secs: 0, likes: 0, lastTs: 0, lastDur: 0 };
  s.plays += 1;
  if (complete) s.completePlays += 1; else s.skips += 1;
  s.secs += secs;
  if (liked) s.likes += 1;
  s.lastTs = ts;
  s.lastDur = secs;
  agg.songs[key] = s;

  // 歌手 / 专辑聚合
  const artist = songs[key].artist || '未知歌手';
  const album = songs[key].album || '未知专辑';
  const ar = agg.artists[artist] || { secs: 0, plays: 0, lastTs: 0 };
  ar.secs += secs; ar.plays += 1; ar.lastTs = ts; agg.artists[artist] = ar;
  const al = agg.albums[album] || { secs: 0, plays: 0, lastTs: 0 };
  al.secs += secs; al.plays += 1; al.lastTs = ts; agg.albums[album] = al;

  // 总计
  const t = agg.totals;
  t.secs += secs;
  if (complete) t.complete += 1; else t.skip += 1;
  if (liked) t.like += 1;
  t.sessions += 1;
  if (!agg.firstTs) agg.firstTs = ts;

  // 每日（含按小时明细，供热力图按时间范围聚合）
  const day = agg.daily[ds] || { secs: 0, complete: 0, skip: 0, like: 0, sessions: 0, hours: Array(24).fill(0) };
  if (!day.hours) day.hours = Array(24).fill(0);
  day.secs += secs;
  day.hours[hr] = (day.hours[hr] || 0) + secs;
  if (complete) day.complete += 1; else day.skip += 1;
  if (liked) day.like += 1;
  day.sessions += 1;
  agg.daily[ds] = day;

  // 时段（7x24）
  agg.hourly[wd][hr] = (agg.hourly[wd][hr] || 0) + secs;

  // 音源
  const src = songs[key].source || 'local';
  agg.sources[src] = (agg.sources[src] || 0) + secs;

  // 最近播放（上限 150）
  agg.recent.unshift({ key, ts, secs, complete, skip, liked });
  if (agg.recent.length > RECENT_LIMIT) agg.recent.length = RECENT_LIMIT;

  // 趣味统计
  const fun = agg.fun;
  const yesterday = dateStr(ts - 86400000);
  if (agg.daily[yesterday]) fun.streak += 1; else fun.streak = 1;
  if (fun.streak > fun.maxStreak) fun.maxStreak = fun.streak;
  if (hr >= 23 || hr < 5) fun.nightSecs += secs;
  if (wd >= 1 && wd <= 5) fun.workSecs += secs; else fun.weekendSecs += secs;
  const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (!fun.earliest || hhmm < fun.earliest) fun.earliest = hhmm;
  if (!fun.latest || hhmm > fun.latest) fun.latest = hhmm;

  // 流水追加
  appendEvent({ ts, key, secs, complete, skip, liked, dur: Math.floor(Number(rec.dur) || 0), source: src });
  saveSoon();
}

// 按播放流水（events ndjson）精确聚合 [start, end) 区间内的歌曲/歌手/专辑。
// 用于过去时段（上周/历史年月季）的 Top 榜单与趣味统计——不用累计值 + lastTs 过滤，
// 避免把最近播放的歌错误计入过去时段。
function rangeAgg(start, end) {
  const out = { songs: {}, artists: {}, albums: {}, empty: true, earliest: null, latest: null };
  if (!state) return out;
  const root = dataRoot();
  const evDir = path.join(root, 'events');
  if (!fs.existsSync(evDir)) return out;
  const files = fs.readdirSync(evDir).filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f)).sort();
  const sPref = dateStr(start).slice(0, 7);
  const ePref = end ? dateStr(end).slice(0, 7) : null;
  let minTs = 0, maxTs = 0;
  for (const f of files) {
    if (f < sPref) continue;
    if (ePref && f > ePref) continue;
    let text;
    try { text = fs.readFileSync(path.join(evDir, f), 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try { ev = JSON.parse(t); } catch (e) { continue; }
      const ts = Number(ev && ev.ts);
      if (!ts || ts < start) continue;
      if (end && ts >= end) continue;
      const secs = Math.max(0, Math.floor(Number(ev.secs) || 0));
      if (secs < 3) continue;
      out.empty = false;
      if (!minTs || ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
      const sk = ev.key;
      if (!sk) continue;
      const info = state.songs[sk] || {};
      const s = out.songs[sk] || { secs: 0, plays: 0, lastTs: 0 };
      s.secs += secs; s.plays += 1; if (ts > s.lastTs) s.lastTs = ts;
      out.songs[sk] = s;
      const artist = info.artist || '未知歌手';
      const ar = out.artists[artist] || { secs: 0, plays: 0, lastTs: 0 };
      ar.secs += secs; ar.plays += 1; if (ts > ar.lastTs) ar.lastTs = ts;
      out.artists[artist] = ar;
      const album = info.album || '';
      if (album) {
        const al = out.albums[album] || { secs: 0, plays: 0, lastTs: 0 };
        al.secs += secs; al.plays += 1; if (ts > al.lastTs) al.lastTs = ts;
        out.albums[album] = al;
      }
    }
  }
  if (minTs) {
    out.earliest = pad(new Date(minTs).getHours()) + ':' + pad(new Date(minTs).getMinutes());
    out.latest = pad(new Date(maxTs).getHours()) + ':' + pad(new Date(maxTs).getMinutes());
  }
  return out;
}

// ---------- RPC 处理器 ----------

function registerRpc() {
  api.rpc.handle('heartbeat', (payload) => {
    if (!state) return null;
    const p = payload || {};
    const song = p.song && typeof p.song === 'object' ? p.song : null;
    const prev = state.session;
    const secs = Math.max(0, Math.floor(Number(p.secs) || 0));
    if (!song || secs < 0) return null;
    state.session = {
      song,
      secs,
      liked: !!p.liked,
      dur: Math.floor(Number(p.dur) || 0),
      startedAt: prev && prev.song && songKey(prev.song) === songKey(song) ? prev.startedAt : Date.now(),
    };
    // 心跳只写轻量的 session.json，不重写汇总文件
    saveSessionNow();
    return { ok: true };
  });

  api.rpc.handle('finalize', (payload) => {
    if (!state) return { ok: true };
    const p = payload || {};
    state.session = null;
    recordSession({
      song: p.song && typeof p.song === 'object' ? p.song : null,
      secs: Number(p.secs) || 0,
      liked: !!p.liked,
      dur: Number(p.dur) || 0,
      ts: Number(p.startedAt) || Date.now(),
    });
    return { ok: true };
  });

  api.rpc.handle('snapshot', () => {
    if (!state) return null;
    return {
      meta: { firstTs: state.agg.firstTs },
      agg: state.agg,
      songs: state.songs,
    };
  });

  api.rpc.handle('aggRange', (payload) => {
    const start = Math.max(0, Math.floor(Number(payload && payload.start) || 0));
    const end = payload && payload.end ? Math.floor(Number(payload.end)) : null;
    return rangeAgg(start, end);
  });

  api.rpc.handle('export', () => {
    if (!state) return { outputPath: '' };
    const root = dataRoot();
    const d = new Date();
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const file = path.join(root, 'backups', 'listening-stats-' + stamp + '.json');
    const payload = { exportedAt: Date.now(), app: 'listening-stats', version: 1, agg: state.agg, songs: state.songs };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 1));
    return { outputPath: file };
  });

  api.rpc.handle('clear', (payload) => {
    if (!state) return { ok: true };
    const root = dataRoot();
    state.agg = emptyAgg();
    state.songs = {};
    state.session = null;
    saveNow().catch(() => {});
    try {
      for (const f of fs.readdirSync(path.join(root, 'events'))) {
        if (f.endsWith('.ndjson')) fs.unlinkSync(path.join(root, 'events', f));
      }
    } catch (e) {}
    // 可选：连导出备份一起清空（界面询问后传入）
    if (payload && payload.includeBackups) {
      try {
        const bk = path.join(root, 'backups');
        if (fs.existsSync(bk)) for (const f of fs.readdirSync(bk)) fs.unlinkSync(path.join(bk, f));
      } catch (e) {}
    }
    return { ok: true };
  });

  api.rpc.handle('openDir', () => {
    const root = dataRoot();
    ensureDirs();
    try {
      const { shell } = require('electron');
      shell.openPath(root);
      return { ok: true };
    } catch (e) {
      try { if (api) api.log.warn('open dir failed', String(e)); } catch (err) {}
      return { ok: false };
    }
  });
}

// ---------- 入口 ----------

module.exports = function activate(mainApi) {
  api = mainApi;
  migrateLegacy();
  ensureDirs();
  load();
  registerRpc();
  api.log.info('listening-stats loaded, data dir: ' + dataRoot());
  return () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveNow().catch(() => {});
  };
};
