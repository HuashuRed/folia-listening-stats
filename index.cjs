'use strict';
// listening-stats/index.cjs — main 入口（Node 进程）
// 职责：接收 client 的播放会话记录，用 Node fs 持久化到独立数据目录
//   Electron app userData/mod-data/listening-stats (legacy %APPDATA% path migrated when safe)
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
const { shell, app, dialog } = require('electron');

const APP = 'Folia';
const SUB = 'listening-stats';
const RECENT_LIMIT = 150;
const DEFAULT_COMPLETE_PERCENT = 50;
let completePercent = DEFAULT_COMPLETE_PERCENT;

function legacyDataRoot() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP, SUB);
}

function locationConfigPath() {
  try { if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'mod-data', SUB + '-location.json'); } catch (e) {}
  return null;
}


function customIconDir() {
  try {
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'mod-data', SUB + '-icon');
  } catch (_) {}
  return null;
}

function readIconData() {
  const dir = customIconDir();
  let file = null;
  if (dir && fs.existsSync(dir)) {
    // 候选项排序保证选择稳定；只接受普通文件，拒绝符号链接（与迁移代码的标准一致，避免读取图标目录外的文件）
    const found = fs.readdirSync(dir)
      .filter((name) => /^custom-icon\.(png|jpe?g|webp|gif)$/i.test(name))
      .sort()
      .find((name) => {
        try {
          const st = fs.lstatSync(path.join(dir, name));
          return st.isFile() && !st.isSymbolicLink();
        } catch (e) { return false; }
      });
    if (found) file = path.join(dir, found);
  }
  if (!file) file = path.join(__dirname, 'preview.png');
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
  const bytes = fs.readFileSync(file);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('图标文件不能超过 2 MB');
  return 'data:' + mime + ';base64,' + bytes.toString('base64');
}

function validateImageBytes(ext, b) {
  if (ext === '.png') return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (ext === '.jpg' || ext === '.jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === '.gif') return b.length >= 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a');
  if (ext === '.webp') return b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function dataRoot() {
  const configPath = locationConfigPath();
  if (configPath) {
    try { const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); if (cfg && typeof cfg.path === 'string' && path.isAbsolute(cfg.path)) return path.resolve(cfg.path); } catch (e) {}
  }
  // Folium 2 may reject filesystem.data before the module starts. Do not access
  // api.storage.paths.data here: use Electron's supported per-user app data path
  // and isolate this module's files in its own subdirectory.
  let userData;
  try {
    userData = app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
  } catch (e) {
    userData = null;
  }
  if (typeof userData === 'string' && userData.trim()) {
    return path.join(userData, 'mod-data', SUB);
  }
  // Last-resort compatibility fallback for environments without Electron app paths.
  return legacyDataRoot();
}

function copyTreeSafe(source, destination) {
  const st = fs.lstatSync(source);
  if (st.isSymbolicLink()) throw new Error('refusing to migrate symbolic link: ' + source);
  if (st.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyTreeSafe(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!st.isFile()) throw new Error('unsupported file in legacy data: ' + source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function validateLegacyData(directory) {
  let foundData = false;
  for (const name of ['songs.json', 'agg.json', 'session.json']) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    foundData = true;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid ' + name);
    if (name === 'songs.json' && Object.values(value).some((v) => !v || typeof v !== 'object' || Array.isArray(v))) {
      throw new Error('invalid song entries in songs.json');
    }
    if (name === 'agg.json' && value.totals != null && (typeof value.totals !== 'object' || Array.isArray(value.totals))) {
      throw new Error('invalid totals in agg.json');
    }
    if (name === 'session.json' && value.song != null && (typeof value.song !== 'object' || Array.isArray(value.song))) {
      throw new Error('invalid song in session.json');
    }
  }
  const events = path.join(directory, 'events');
  if (fs.existsSync(events)) {
    const st = fs.lstatSync(events);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('invalid events directory');
    for (const name of fs.readdirSync(events).filter((f) => f.endsWith('.ndjson'))) {
      const file = path.join(events, name);
      if (!fs.lstatSync(file).isFile()) throw new Error('invalid event file: ' + name);
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new Error('invalid event in ' + name);
      }
      foundData = true;
    }
  }
  if (!foundData) throw new Error('no recognized listening data found');
}

function migrateLegacyData() {
  const target = path.resolve(dataRoot()), legacy = path.resolve(legacyDataRoot());
  if (target === legacy || !fs.existsSync(legacy)) return;
  try {
    // Never merge into or overwrite a populated destination.
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) return;
    validateLegacyData(legacy);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const staging = target + '.migration-' + process.pid + '-' + Date.now();
    fs.rmSync(staging, { recursive: true, force: true });
    copyTreeSafe(legacy, staging);
    validateLegacyData(staging);

    // Swap a fully validated staging directory into place. If the host has
    // already created an empty data directory, temporarily move it aside.
    let emptyTarget = null;
    if (fs.existsSync(target)) {
      if (fs.readdirSync(target).length > 0) {
        fs.rmSync(staging, { recursive: true, force: true });
        return;
      }
      emptyTarget = target + '.empty-' + process.pid + '-' + Date.now();
      fs.renameSync(target, emptyTarget);
    }
    try {
      fs.renameSync(staging, target);
      if (emptyTarget) fs.rmSync(emptyTarget, { recursive: true, force: true });
    } catch (e) {
      if (emptyTarget && !fs.existsSync(target) && fs.existsSync(emptyTarget)) fs.renameSync(emptyTarget, target);
      throw e;
    }
    if (api && api.log) api.log.info('listening-stats: legacy data validated and migrated');
  } catch (e) {
    try { if (api) api.log.warn('listening-stats legacy migration failed; original data kept and migration can be retried', String(e)); } catch (_) {}
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

function loadSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataRoot(), 'settings.json'), 'utf8'));
    const n = Number(value && value.completePercent);
    completePercent = Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : DEFAULT_COMPLETE_PERCENT;
  } catch (_) { completePercent = DEFAULT_COMPLETE_PERCENT; }
}
function saveSettings() {
  const root = ensureDirs();
  const target = path.join(root, 'settings.json');
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify({ completePercent }, null, 2));
  fs.renameSync(tmp, target);
}
function isComplete(rec) {
  const dur = Number(rec.dur) || 0;
  const secs = Number(rec.secs) || 0;
  if (dur > 0) return secs >= dur * completePercent / 100;
  return secs >= 30;
}

// ---------- 状态 ----------

let api = null;
let state = null; // { songs, agg, session }
let saveTimer = null;
let clearingStats = false;
const finalizedSessions = new Set();
function sessionIdentity(song, startedAt) { return String(Number(startedAt) || 0) + ':' + songKey(song); }
function rememberFinalized(id) { finalizedSessions.add(id); if (finalizedSessions.size > 1000) finalizedSessions.delete(finalizedSessions.values().next().value); }

function load() {
  const root = dataRoot();
  let songs = {};
  let agg = null;
  try { songs = JSON.parse(fs.readFileSync(path.join(root, 'songs.json'), 'utf8')); } catch (e) { songs = {}; }
  try { agg = JSON.parse(fs.readFileSync(path.join(root, 'agg.json'), 'utf8')); } catch (e) { agg = emptyAgg(); }
  if (!agg.totals) agg = emptyAgg();
  if (!agg.hourly || agg.hourly.length !== 7) agg.hourly = emptyHourly();

  loadSettings();
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

let writeChain = Promise.resolve();
let tempFileCounter = 0;
function atomicWriteSync(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + (++tempFileCounter);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function atomicWriteAsync(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + (++tempFileCounter);
  return fs.promises.writeFile(tmp, content, 'utf8')
    .then(() => fs.promises.rename(tmp, file))
    .catch(async (e) => { await fs.promises.unlink(tmp).catch(() => {}); throw e; });
}

function enqueueWrite(task) {
  const operation = writeChain.then(task);
  // Keep the queue usable after a failed write, but return the original promise
  // so callers such as clear/finalize can report failure accurately.
  writeChain = operation.catch((e) => {
    try { if (api) api.log.warn('stats persistence failed', String(e)); } catch (_) {}
  });
  return operation;
}

function saveSessionNow() {
  if (!state) return Promise.resolve();
  const sessionText = state.session ? JSON.stringify(state.session) : null;
  const root = dataRoot();
  return enqueueWrite(async () => {
    await fs.promises.mkdir(root, { recursive: true });
    const file = path.join(root, 'session.json');
    if (sessionText !== null) await atomicWriteAsync(file, sessionText);
    else await fs.promises.unlink(file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  });
}

function saveNow() {
  if (!state) return Promise.resolve();
  const root = dataRoot();
  // Snapshot at scheduling time; all file writes, including session writes,
  // go through the same queue to avoid temporary-file races and stale ordering.
  const aggText = JSON.stringify(state.agg), songsText = JSON.stringify(state.songs);
  const sessionText = state.session ? JSON.stringify(state.session) : null;
  return enqueueWrite(async () => {
    await fs.promises.mkdir(root, { recursive: true });
    await atomicWriteAsync(path.join(root, 'agg.json'), aggText);
    await atomicWriteAsync(path.join(root, 'songs.json'), songsText);
    const sessionFile = path.join(root, 'session.json');
    if (sessionText !== null) await atomicWriteAsync(sessionFile, sessionText);
    else await fs.promises.unlink(sessionFile).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  });
}

function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveNow().catch(() => {}); }, 1500);
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
// 区间聚合的按月解析缓存：key=YYYY-MM.ndjson，value={ mtimeMs, rows }。
// 事件追加后文件 mtime 变化，缓存按 mtime 自动失效；带数量上限，避免长期运行内存膨胀。
const monthEventCache = new Map();
const MONTH_CACHE_MAX = 120;
function readMonthEvents(evDir, f) {
  const file = path.join(evDir, f);
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch (e) { return null; }
  const hit = monthEventCache.get(f);
  if (hit && hit.mtimeMs === mtimeMs) return hit.rows;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch (e) { /* 单行损坏不影响其余 */ }
  }
  monthEventCache.set(f, { mtimeMs, rows });
  if (monthEventCache.size > MONTH_CACHE_MAX) {
    const oldest = monthEventCache.keys().next().value;
    monthEventCache.delete(oldest);
  }
  return rows;
}

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
    const fm = f.slice(0, 7); // 月份前缀 'YYYY-MM'；直接用文件名比较会把当月文件（带 .ndjson 后缀）误判为大于前缀而跳过
    if (fm < sPref) continue;
    if (ePref && fm > ePref) continue;
    const events = readMonthEvents(evDir, f); // 按月缓存解析结果，避免每次重复读取/解析同一文件
    if (!events) continue;
    for (const ev of events) {
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
  api.rpc.handle('getCustomIcon', () => {
    try { return { ok: true, dataUrl: readIconData() }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  api.rpc.handle('chooseCustomIcon', async () => {
    try {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') return { ok: false, error: '当前宿主不支持文件选择' };
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: '选择模组面板图标',
        filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
      const source = result.filePaths[0];
      const ext = path.extname(source).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return { ok: false, error: '仅支持 PNG、JPG、WEBP 或 GIF 图片' };
      const bytes = await fs.promises.readFile(source);
      if (bytes.length < 1 || bytes.length > 2 * 1024 * 1024) return { ok: false, error: '图标文件必须小于等于 2 MB' };
      if (!validateImageBytes(ext, bytes)) return { ok: false, error: '文件内容与图片格式不匹配或文件已损坏' };
      const dir = customIconDir();
      if (!dir) return { ok: false, error: '无法确定模组设置目录' };
      await fs.promises.mkdir(dir, { recursive: true });
      const target = path.join(dir, 'custom-icon' + ext);
      const token = process.pid + '-' + Date.now() + '-' + (++tempFileCounter);
      const temp = target + '.tmp-' + token;
      const previous = target + '.previous-' + token;
      await fs.promises.writeFile(temp, bytes, { flag: 'wx' });
      let movedPrevious = false;
      try {
        // Keep the previous icon recoverable until the new file is in place.
        try { await fs.promises.rename(target, previous); movedPrevious = true; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        await fs.promises.rename(temp, target);
      } catch (e) {
        await fs.promises.unlink(temp).catch(() => {});
        if (movedPrevious) await fs.promises.rename(previous, target).catch(() => {});
        throw e;
      }
      // The replacement is now committed; only now remove old extensions and backup.
      for (const name of await fs.promises.readdir(dir)) {
        if (/^custom-icon\.(png|jpe?g|webp|gif)$/i.test(name) && name !== path.basename(target)) {
          await fs.promises.unlink(path.join(dir, name)).catch(() => {});
        }
      }
      if (movedPrevious) await fs.promises.unlink(previous).catch(() => {});
      return { ok: true, dataUrl: readIconData() };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  api.rpc.handle('resetCustomIcon', async () => {
    try {
      const dir = customIconDir();
      if (dir && fs.existsSync(dir)) {
        for (const name of await fs.promises.readdir(dir)) {
          if (/^custom-icon\.(png|jpe?g|webp|gif)$/i.test(name)) await fs.promises.unlink(path.join(dir, name));
        }
      }
      return { ok: true, dataUrl: readIconData() };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  api.rpc.handle('getCompletePercent', () => ({ ok: true, percent: completePercent }));
  api.rpc.handle('setCompletePercent', (payload) => {
    const n = Number(payload && payload.percent);
    if (!Number.isFinite(n) || n < 1 || n > 100) return { ok: false, error: '比例必须是 1 到 100 的整数' };
    completePercent = Math.round(n);
    saveSettings();
    return { ok: true, percent: completePercent };
  });

  api.rpc.handle('heartbeat', async (payload) => {
    if (!state || clearingStats) return { ok: false, error: 'statistics are being cleared' };
    const p = payload || {};
    const song = p.song && typeof p.song === 'object' ? p.song : null;
    const prev = state.session;
    const secs = Math.max(0, Math.floor(Number(p.secs) || 0));
    if (!song) return { ok: false, error: 'invalid session' };
    const startedAt = Number(p.startedAt) || (prev && prev.song && songKey(prev.song) === songKey(song) ? prev.startedAt : Date.now());
    if (finalizedSessions.has(sessionIdentity(song, startedAt))) return { ok: true, ignored: true };
    state.session = { song, secs, liked: !!p.liked, dur: Math.floor(Number(p.dur) || 0), startedAt };
    await saveSessionNow();
    return { ok: true };
  });

  api.rpc.handle('finalize', async (payload) => {
    if (!state || clearingStats) return { ok: false, error: 'statistics are being cleared' };
    const p = payload || {};
    const song = p.song && typeof p.song === 'object' ? p.song : null;
    const startedAt = Number(p.startedAt) || Date.now();
    const id = sessionIdentity(song, startedAt);
    if (finalizedSessions.has(id)) return { ok: true, duplicate: true };
    rememberFinalized(id);
    state.session = null;
    recordSession({ song, secs: Number(p.secs) || 0, liked: !!p.liked, dur: Number(p.dur) || 0, ts: startedAt });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    // Persist the finalized aggregates and removal of session.json in one queued task.
    await saveNow();
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

  api.rpc.handle('clear', async (payload) => {
    if (!state) return { ok: true };
    if (clearingStats) return { ok: false, error: 'clear already in progress' };
    clearingStats = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      state.agg = emptyAgg();
      state.songs = {};
      state.session = null;
      finalizedSessions.clear();
      // Await persistence before removing the event history; never report success early.
      await saveNow();
      const root = dataRoot();
      const eventDir = path.join(root, 'events');
      for (const f of fs.readdirSync(eventDir, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith('.ndjson')) await fs.promises.unlink(path.join(eventDir, f.name));
      }
      if (payload && payload.includeBackups === true) {
        const backupDir = path.join(root, 'backups');
        for (const f of fs.readdirSync(backupDir, { withFileTypes: true })) {
          // Only remove generated JSON backup files; preserve unexpected folders/files.
          if (f.isFile() && f.name.endsWith('.json')) await fs.promises.unlink(path.join(backupDir, f.name));
        }
      }
      return { ok: true };
    } catch (e) {
      try { if (api) api.log.warn('stats clear incomplete', String(e)); } catch (_) {}
      return { ok: false, error: String(e) };
    } finally {
      clearingStats = false;
    }
  });

  api.rpc.handle('openDir', () => {
    const root = ensureDirs();
    return shell.openPath(root).then((message) => ({ ok: !message, error: message || undefined }))
      .catch((e) => ({ ok: false, error: String(e) }));
  });

  api.rpc.handle('chooseDataDir', async () => {
    try {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') return { ok: false, error: '当前宿主不支持目录选择' };
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择听歌统计数据保存目录' });
      if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
      const chosen = path.resolve(result.filePaths[0]);
      const current = path.resolve(dataRoot());
      if (chosen === current) return { ok: true, path: current, unchanged: true };
      await writeChain;
      await saveNow();
      await writeChain;
      fs.mkdirSync(path.dirname(chosen), { recursive: true });
      const targetExists = fs.existsSync(chosen);
      if (targetExists && fs.readdirSync(chosen).length) {
        // Existing destinations must already be valid listening-stats data; never merge arbitrary files.
        validateLegacyData(chosen);
      } else {
        // Build and validate a complete sibling staging directory first. Swapping directory names
        // on the same volume avoids exposing a half-copied destination after a crash.
        const parent = path.dirname(chosen);
        const base = path.basename(chosen);
        const token = process.pid + '-' + Date.now();
        const staging = path.join(parent, '.' + base + '.listening-stats-staging-' + token);
        const emptyHold = path.join(parent, '.' + base + '.listening-stats-empty-' + token);
        let heldEmptyTarget = false;
        fs.mkdirSync(staging, { recursive: false });
        try {
          for (const name of fs.readdirSync(current)) copyTreeSafe(path.join(current, name), path.join(staging, name));
          validateLegacyData(staging);
          if (targetExists) {
            fs.renameSync(chosen, emptyHold);
            heldEmptyTarget = true;
          }
          try {
            fs.renameSync(staging, chosen);
          } catch (swapError) {
            if (heldEmptyTarget && !fs.existsSync(chosen) && fs.existsSync(emptyHold)) fs.renameSync(emptyHold, chosen);
            throw swapError;
          }
          if (heldEmptyTarget) await fs.promises.rm(emptyHold, { recursive: true, force: true });
        } finally {
          await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
        }
      }
      const cfgPath = locationConfigPath();
      if (!cfgPath) return { ok: false, error: '无法保存目录配置' };
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      const tmp = cfgPath + '.tmp-' + process.pid + '-' + Date.now();
      const oldCfg = cfgPath + '.previous-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify({ path: chosen }, null, 2), { flag: 'wx' });
      let hadOldCfg = false;
      try {
        try { await fs.promises.rename(cfgPath, oldCfg); hadOldCfg = true; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        await fs.promises.rename(tmp, cfgPath);
      } catch (cfgError) {
        await fs.promises.unlink(tmp).catch(() => {});
        if (hadOldCfg) await fs.promises.rename(oldCfg, cfgPath).catch(() => {});
        throw cfgError;
      }
      if (hadOldCfg) await fs.promises.unlink(oldCfg).catch(() => {});
      load();
      ensureDirs();
      return { ok: true, path: chosen };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
}

// ---------- 入口 ----------

module.exports = function activate(mainApi) {
  api = mainApi;
  migrateLegacyData();
  ensureDirs();
  load();
  registerRpc();
  api.log.info('listening-stats loaded, data dir: ' + dataRoot());
  return async () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    // Drain pending writes and make a final consistent snapshot before deactivation.
    await writeChain;
    await saveNow();
    await writeChain;
  };
};
