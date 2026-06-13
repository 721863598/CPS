/**
 * db-service.js — SQLite 数据库服务模块（主进程）
 *
 * 基于 sql.js 的纯本地 SQLite 时间追踪数据库。
 * 负责：建表、记录 CRUD、聚合表重建、数据查询、磁盘读写。
 * 所有数据以 SQLite 为准，records.json 仅用于首次迁移。
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// ============================================================
//  模块内部状态
// ============================================================

let db = null;           // sql.js Database 实例
let dbPath = null;       // records.db 文件路径

// ============================================================
//  工具函数
// ============================================================

/** 解析灵活的日期时间格式（始终按本地时间处理） */
function parseDatetime(str) {
  const [date, time] = str.split(' ');
  const dateParts = date.split('-');
  const timeParts = time.split(':');
  return new Date(
    parseInt(dateParts[0]),
    parseInt(dateParts[1]) - 1,
    parseInt(dateParts[2]),
    parseInt(timeParts[0]) || 0,
    parseInt(timeParts[1]) || 0,
    parseInt(timeParts[2]) || 0
  );
}

/** 获取 Date 对象的本地日期字符串 "YYYY-MM-DD" */
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 将 "HH:MM:SS" 转为总秒数 */
function durationToSeconds(durStr) {
  const parts = durStr.split(':');
  return (parseInt(parts[0]) || 0) * 3600
       + (parseInt(parts[1]) || 0) * 60
       + (parseInt(parts[2]) || 0);
}

/** 将总秒数转为 "HH:MM:SS" */
function secondsToDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return String(h).padStart(2, '0') + ':' +
         String(m).padStart(2, '0') + ':' +
         String(s).padStart(2, '0');
}

/**
 * 通用跨周期拆分：将一条记录按秒分配到各个 period
 */
function splitByPeriod(startStr, endStr, durStr, periodEndFn, periodKeyFn) {
  const start = parseDatetime(startStr);
  const end = parseDatetime(endStr);
  const totalMs = end.getTime() - start.getTime();
  if (totalMs <= 0) return {};

  const totalSeconds = durationToSeconds(durStr);
  const splits = {};
  let cursor = new Date(start);

  while (cursor < end) {
    const key = periodKeyFn(cursor);
    const boundary = periodEndFn(cursor);
    const segEnd = boundary < end ? boundary : end;
    const segMs = segEnd.getTime() - cursor.getTime();
    const proportion = segMs / totalMs;
    const segSeconds = Math.round(totalSeconds * proportion);

    splits[key] = (splits[key] || 0) + segSeconds;
    cursor = new Date(boundary.getTime() + 1);
  }

  // 修正取整误差
  const sum = Object.values(splits).reduce((a, b) => a + b, 0);
  if (sum !== totalSeconds) {
    const keys = Object.keys(splits);
    if (keys.length > 0) splits[keys[keys.length - 1]] += totalSeconds - sum;
  }

  return splits;
}

/** 获取 dayStr ("YYYY-MM-DD") 的前一天 */
function yesterdayOf(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 1);
  return localDateKey(date);
}

/** 获取周一日期字符串的前一周周一日期 */
function previousWeekKey(mondayStr) {
  const [y, m, d] = mondayStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 7);
  return localDateKey(date);
}

/** 获取 "YYYY-MM" 的前一个月 */
function previousMonthKey(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 获取 "YYYY" 的前一年 */
function previousYearKey(yearStr) {
  return String(parseInt(yearStr) - 1);
}

// ---- 周期边界 / 标识函数 ----

function dayEnd(d) {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}
function dayKey(d) { return localDateKey(d); }

function monthEnd(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function weekEnd(d) {
  const dayOfWeek = d.getDay();
  const daysToSun = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  const e = new Date(d);
  e.setDate(e.getDate() + daysToSun);
  e.setHours(23, 59, 59, 999);
  return e;
}
function weekKey(d) {
  const dayOfWeek = d.getDay();
  const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const mon = new Date(d);
  mon.setDate(mon.getDate() - daysFromMon);
  return localDateKey(mon);
}

function yearEnd(d) {
  return new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999);
}
function yearKey(d) { return String(d.getFullYear()); }

function hourEnd(d) {
  const e = new Date(d);
  e.setMinutes(59, 59, 999);
  return e;
}
function hourKey(d) {
  return localDateKey(d) + '|' + String(d.getHours()).padStart(2, '0');
}

// ============================================================
//  预计算：一次遍历所有已完成记录，同时算出五种周期拆分
// ============================================================

function precomputeAllSplits(completedRows) {
  const data = {
    day:     {},
    week:    {},
    month:   {},
    dayTag:  {},
    weekTag: {},
    monthTag:{},
    yearTag: {},
    hour:    {},
  };

  if (completedRows.length === 0) return data;

  for (const row of completedRows) {
    const [startStr, endStr, durStr, tag] = row;

    const daySplits   = splitByPeriod(startStr, endStr, durStr, dayEnd,   dayKey);
    const weekSplits  = splitByPeriod(startStr, endStr, durStr, weekEnd,  weekKey);
    const monthSplits = splitByPeriod(startStr, endStr, durStr, monthEnd, monthKey);
    const yearSplits  = splitByPeriod(startStr, endStr, durStr, yearEnd,  yearKey);
    const hourSplits  = splitByPeriod(startStr, endStr, durStr, hourEnd,  hourKey);

    // 日聚合
    for (const [day, sec] of Object.entries(daySplits)) {
      if (!data.day[day]) data.day[day] = { seconds: 0, records: 0 };
      data.day[day].seconds += sec;
      data.day[day].records += 1;
      if (!data.dayTag[day]) data.dayTag[day] = {};
      data.dayTag[day][tag] = (data.dayTag[day][tag] || 0) + sec;
    }

    // 周聚合
    for (const [week, sec] of Object.entries(weekSplits)) {
      if (!data.week[week]) data.week[week] = { seconds: 0, records: 0 };
      data.week[week].seconds += sec;
      data.week[week].records += 1;
      if (!data.weekTag[week]) data.weekTag[week] = {};
      data.weekTag[week][tag] = (data.weekTag[week][tag] || 0) + sec;
    }

    // 月聚合
    for (const [month, sec] of Object.entries(monthSplits)) {
      if (!data.month[month]) data.month[month] = { seconds: 0, records: 0 };
      data.month[month].seconds += sec;
      data.month[month].records += 1;
      if (!data.monthTag[month]) data.monthTag[month] = {};
      data.monthTag[month][tag] = (data.monthTag[month][tag] || 0) + sec;
    }

    // 年聚合
    for (const [year, sec] of Object.entries(yearSplits)) {
      if (!data.yearTag[year]) data.yearTag[year] = {};
      data.yearTag[year][tag] = (data.yearTag[year][tag] || 0) + sec;
    }

    // 小时聚合
    for (const [key, sec] of Object.entries(hourSplits)) {
      const [day, h] = key.split('|');
      if (!data.hour[day]) data.hour[day] = {};
      data.hour[day][parseInt(h)] = (data.hour[day][parseInt(h)] || 0) + sec;
    }
  }

  return data;
}

// ---- 写表辅助函数 ----

function writePeriodTable(dbInst, tableName, map) {
  dbInst.run(`DROP TABLE IF EXISTS ${tableName}`);
  dbInst.run(`CREATE TABLE ${tableName} (
    period TEXT PRIMARY KEY, total_seconds INTEGER NOT NULL DEFAULT 0,
    complete_records INTEGER NOT NULL DEFAULT 0)`);
  const insert = dbInst.prepare(`INSERT INTO ${tableName} (period, total_seconds, complete_records) VALUES (:p, :s, :r)`);
  for (const [p, d] of Object.entries(map).sort()) {
    insert.run({ ':p': p, ':s': d.seconds, ':r': d.records });
  }
  insert.free();
}

function writeTagFocusTable(dbInst, tableName, periodCol, tagMap) {
  dbInst.run(`DROP TABLE IF EXISTS ${tableName}`);
  dbInst.run(`CREATE TABLE ${tableName} (
    ${periodCol} TEXT NOT NULL, tag TEXT NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (${periodCol}, tag))`);
  const insert = dbInst.prepare(`INSERT INTO ${tableName} (${periodCol}, tag, total_seconds) VALUES (:p, :t, :s)`);
  for (const [p, tm] of Object.entries(tagMap)) {
    for (const [t, s] of Object.entries(tm)) insert.run({ ':p': p, ':t': t, ':s': s });
  }
  insert.free();
}

function writeSummaryTable(dbInst, tableName, periodCol, tagMap, prevKeyFn) {
  dbInst.run(`DROP TABLE IF EXISTS ${tableName}`);
  dbInst.run(`CREATE TABLE ${tableName} (
    ${periodCol} TEXT PRIMARY KEY, total_seconds INTEGER NOT NULL DEFAULT 0,
    task_count INTEGER NOT NULL DEFAULT 0, top_tag TEXT, top_tag_seconds INTEGER NOT NULL DEFAULT 0,
    prev_seconds INTEGER, diff_seconds INTEGER)`);
  const insert = dbInst.prepare(`INSERT INTO ${tableName} (${periodCol}, total_seconds, task_count, top_tag, top_tag_seconds, prev_seconds, diff_seconds)
    VALUES (:p, :ts, :tc, :tt, :tts, :pv, :df)`);
  for (const p of Object.keys(tagMap).sort()) {
    const tm = tagMap[p];
    const ts = Object.values(tm).reduce((a, b) => a + b, 0);
    const tc = Object.keys(tm).length;
    let tt = null, tts = 0;
    for (const [t, s] of Object.entries(tm)) { if (s > tts) { tts = s; tt = t; } }
    const prev = prevKeyFn(p);
    const pv = tagMap[prev] ? Object.values(tagMap[prev]).reduce((a, b) => a + b, 0) : null;
    insert.run({ ':p': p, ':ts': ts, ':tc': tc, ':tt': tt, ':tts': tts, ':pv': pv, ':df': pv !== null ? ts - pv : null });
  }
  insert.free();
}

function writeHourlyFocus(dbInst, hourMap) {
  dbInst.run('DROP TABLE IF EXISTS hourly_focus');
  dbInst.run(`CREATE TABLE hourly_focus (
    day TEXT NOT NULL, hour INTEGER NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, hour))`);
  const insert = dbInst.prepare('INSERT INTO hourly_focus (day, hour, total_seconds) VALUES (:d, :h, :s)');
  for (const [day, hours] of Object.entries(hourMap)) {
    for (const [h, s] of Object.entries(hours)) insert.run({ ':d': day, ':h': parseInt(h), ':s': s });
  }
  insert.free();
}

// ---- 派生表（从已建表聚合） ----

function rebuildWeeklyHourlyFocus(dbInst) {
  dbInst.run('DROP TABLE IF EXISTS weekly_hourly_focus');
  dbInst.run(`CREATE TABLE weekly_hourly_focus (
    week TEXT NOT NULL, hour INTEGER NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (week, hour))`);
  const rows = dbInst.exec('SELECT day, hour, total_seconds FROM hourly_focus');
  const map = {};
  if (rows[0]) for (const r of rows[0].values) {
    const [day, hour, sec] = r;
    const [y, m, d] = day.split('-').map(Number);
    const week = weekKey(new Date(y, m - 1, d));
    if (!map[week]) map[week] = {};
    map[week][hour] = (map[week][hour] || 0) + sec;
  }
  const insert = dbInst.prepare('INSERT INTO weekly_hourly_focus (week, hour, total_seconds) VALUES (:w, :h, :s)');
  for (const [w, hrs] of Object.entries(map)) for (const [h, s] of Object.entries(hrs)) insert.run({ ':w': w, ':h': parseInt(h), ':s': s });
  insert.free();
}

function rebuildWeeklyDailyFocus(dbInst) {
  dbInst.run('DROP TABLE IF EXISTS weekly_daily_focus');
  dbInst.run(`CREATE TABLE weekly_daily_focus (
    week TEXT NOT NULL, day_of_week INTEGER NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (week, day_of_week))`);
  const rows = dbInst.exec('SELECT period, total_seconds FROM daily_focus');
  const map = {};
  if (rows[0]) for (const r of rows[0].values) {
    const [day, sec] = r;
    const [y, m, d] = day.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const week = weekKey(date);
    let dow = date.getDay(); dow = dow === 0 ? 7 : dow;
    if (!map[week]) map[week] = {};
    map[week][dow] = (map[week][dow] || 0) + sec;
  }
  const insert = dbInst.prepare('INSERT INTO weekly_daily_focus (week, day_of_week, total_seconds) VALUES (:w, :d, :s)');
  for (const [w, ds] of Object.entries(map)) for (const [d, s] of Object.entries(ds)) insert.run({ ':w': w, ':d': parseInt(d), ':s': s });
  insert.free();
}

function rebuildMonthlyHourlyFocus(dbInst) {
  dbInst.run('DROP TABLE IF EXISTS monthly_hourly_focus');
  dbInst.run(`CREATE TABLE monthly_hourly_focus (
    month TEXT NOT NULL, hour INTEGER NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (month, hour))`);
  const rows = dbInst.exec('SELECT day, hour, total_seconds FROM hourly_focus');
  const map = {};
  if (rows[0]) for (const r of rows[0].values) {
    const [day, hour, sec] = r;
    const month = day.slice(0, 7);
    if (!map[month]) map[month] = {};
    map[month][hour] = (map[month][hour] || 0) + sec;
  }
  const insert = dbInst.prepare('INSERT INTO monthly_hourly_focus (month, hour, total_seconds) VALUES (:m, :h, :s)');
  for (const [m, hrs] of Object.entries(map)) for (const [h, s] of Object.entries(hrs)) insert.run({ ':m': m, ':h': parseInt(h), ':s': s });
  insert.free();
}

function rebuildMonthlyDailyFocus(dbInst) {
  dbInst.run('DROP TABLE IF EXISTS monthly_daily_focus');
  dbInst.run(`CREATE TABLE monthly_daily_focus (
    month TEXT NOT NULL, day_of_month INTEGER NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (month, day_of_month))`);
  const rows = dbInst.exec('SELECT period, total_seconds FROM daily_focus');
  const map = {};
  if (rows[0]) for (const r of rows[0].values) {
    const [day, sec] = r;
    const month = day.slice(0, 7);
    const dom = parseInt(day.slice(8, 10));
    if (!map[month]) map[month] = {};
    map[month][dom] = (map[month][dom] || 0) + sec;
  }
  const insert = dbInst.prepare('INSERT INTO monthly_daily_focus (month, day_of_month, total_seconds) VALUES (:m, :d, :s)');
  for (const [m, ds] of Object.entries(map)) for (const [d, s] of Object.entries(ds)) insert.run({ ':m': m, ':d': parseInt(d), ':s': s });
  insert.free();
}

function rebuildYearlyHourlyFocus(dbInst) {
  dbInst.run('DROP TABLE IF EXISTS yearly_hourly_focus');
  dbInst.run(`CREATE TABLE yearly_hourly_focus (
    year TEXT NOT NULL, hour INTEGER NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (year, hour))`);
  const rows = dbInst.exec('SELECT day, hour, total_seconds FROM hourly_focus');
  const map = {};
  if (rows[0]) for (const r of rows[0].values) {
    const [day, hour, sec] = r;
    const year = day.slice(0, 4);
    if (!map[year]) map[year] = {};
    map[year][hour] = (map[year][hour] || 0) + sec;
  }
  const insert = dbInst.prepare('INSERT INTO yearly_hourly_focus (year, hour, total_seconds) VALUES (:y, :h, :s)');
  for (const [y, hrs] of Object.entries(map)) for (const [h, s] of Object.entries(hrs)) insert.run({ ':y': y, ':h': parseInt(h), ':s': s });
  insert.free();
}

function rebuildYearlyMonthlyFocus(dbInst) {
  dbInst.run('DROP TABLE IF EXISTS yearly_monthly_focus');
  dbInst.run(`CREATE TABLE yearly_monthly_focus (
    year TEXT NOT NULL, month_of_year INTEGER NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (year, month_of_year))`);
  const rows = dbInst.exec('SELECT period, total_seconds FROM monthly_focus');
  const map = {};
  if (rows[0]) for (const r of rows[0].values) {
    const [month, sec] = r;
    const year = month.slice(0, 4);
    const moy = parseInt(month.slice(5, 7));
    if (!map[year]) map[year] = {};
    map[year][moy] = (map[year][moy] || 0) + sec;
  }
  const insert = dbInst.prepare('INSERT INTO yearly_monthly_focus (year, month_of_year, total_seconds) VALUES (:y, :m, :s)');
  for (const [y, ms] of Object.entries(map)) for (const [m, s] of Object.entries(ms)) insert.run({ ':y': y, ':m': parseInt(m), ':s': s });
  insert.free();
}

/**
 * 重建 tag_stats 表：所有标签的去重聚合（总时长、记录数、最近使用时间）
 * 一张表同时满足：最近使用 / 全部去重 / 按时长排序
 */
function rebuildTagStats(dbInst) {
  dbInst.run('DROP TABLE IF EXISTS tag_stats');
  dbInst.run(`CREATE TABLE tag_stats (
    tag TEXT PRIMARY KEY,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    record_count INTEGER NOT NULL DEFAULT 0,
    last_used TEXT NOT NULL
  )`);
  dbInst.run(`
    INSERT INTO tag_stats (tag, total_seconds, record_count, last_used)
    SELECT
      tag,
      COALESCE(SUM(CASE WHEN is_complete = 1 AND duration IS NOT NULL
        THEN (CAST(substr(duration, 1, 2) AS INTEGER) * 3600
            + CAST(substr(duration, 4, 2) AS INTEGER) * 60
            + CAST(substr(duration, 7, 2) AS INTEGER))
        ELSE 0 END), 0) AS total_seconds,
      COUNT(*) AS record_count,
      MAX(start_time) AS last_used
    FROM records
    WHERE start_time IS NOT NULL
    GROUP BY tag
  `);
}

/**
 * 重建所有 20 张聚合表（在一笔事务内完成）
 */
function rebuildAllAggregates() {
  const completedRows = db.exec(`
    SELECT start_time, end_time, duration, tag
    FROM records
    WHERE is_complete = 1 AND end_time IS NOT NULL AND duration IS NOT NULL
  `);
  const rows = completedRows[0] ? completedRows[0].values : [];

  const pre = precomputeAllSplits(rows);

  db.run('BEGIN TRANSACTION');
  try {
    writePeriodTable(db, 'daily_focus',   pre.day);
    writePeriodTable(db, 'weekly_focus',  pre.week);
    writePeriodTable(db, 'monthly_focus', pre.month);
    writeSummaryTable(db, 'daily_summary',   'day',   pre.dayTag,   yesterdayOf);
    writeSummaryTable(db, 'weekly_summary',  'week',  pre.weekTag,  previousWeekKey);
    writeSummaryTable(db, 'monthly_summary', 'month', pre.monthTag, previousMonthKey);
    writeSummaryTable(db, 'yearly_summary',  'year',  pre.yearTag,  previousYearKey);
    writeTagFocusTable(db, 'daily_tag_focus',   'day',   pre.dayTag);
    writeTagFocusTable(db, 'weekly_tag_focus',  'week',  pre.weekTag);
    writeTagFocusTable(db, 'monthly_tag_focus', 'month', pre.monthTag);
    writeTagFocusTable(db, 'yearly_tag_focus',  'year',  pre.yearTag);
    writeHourlyFocus(db, pre.hour);
    rebuildWeeklyHourlyFocus(db);
    rebuildWeeklyDailyFocus(db);
    rebuildMonthlyHourlyFocus(db);
    rebuildMonthlyDailyFocus(db);
    rebuildYearlyHourlyFocus(db);
    rebuildYearlyMonthlyFocus(db);
    rebuildTagStats(db);
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

// ============================================================
//  字段名映射：DB (snake_case) ↔ API (camelCase)
// ============================================================

function rowToRecord(row) {
  // row: [id, is_complete, tag, start_time, end_time, duration, created_at]
  return {
    isComplete: row[1] === 1 ? '是' : '否',
    tag: row[2],
    startTime: row[3],
    endTime: row[4] || undefined,
    duration: row[5] || undefined
  };
}

// ============================================================
//  公开 API
// ============================================================

/**
 * 初始化数据库：加载 WASM，打开/创建 records.db，建表
 */
async function initDB(_dbPath, _jsonPath) {
  dbPath = _dbPath;
  // sql.js 在 Electron 主进程中默认 locateFile 即可工作
  //（Electron 的 fs 模块已透明支持 asar 内文件读取）
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  // 建原始表 + 唯一索引
  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      is_complete INTEGER NOT NULL DEFAULT 0,
      tag         TEXT    NOT NULL,
      start_time  TEXT    NOT NULL,
      end_time    TEXT,
      duration    TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_records_unique
    ON records(start_time, tag)
  `);

  // 一次性迁移：如果存在老 JSON 文件，导入数据后移动到 olddata/
  if (_jsonPath && fs.existsSync(_jsonPath)) {
    const raw = fs.readFileSync(_jsonPath, 'utf-8');
    try {
      const records = JSON.parse(raw);
      if (Array.isArray(records) && records.length > 0) {
        migrateFromJSON(records);
        console.log(`[db-service] 从 JSON 迁移 ${records.length} 条记录`);
      }
    } catch (e) {
      console.error('[db-service] JSON 解析失败:', e.message);
    }
    // 导入完成后将 JSON 移动到 olddata/ 归档
    try {
      const dataDir = path.dirname(_jsonPath);
      const oldDataDir = path.join(dataDir, 'olddata');
      if (!fs.existsSync(oldDataDir)) {
        fs.mkdirSync(oldDataDir, { recursive: true });
      }
      const destPath = path.join(oldDataDir, 'records.json');
      fs.renameSync(_jsonPath, destPath);
      console.log('[db-service] records.json 已归档到 olddata/，后续以数据库为准');
    } catch (e) {
      console.error('[db-service] 归档 JSON 失败:', e.message);
    }
    rebuildAllAggregates();
    saveToDisk();
  }

  // 数据完整性校验与自动修复（仅修复 duration，不动 start_time / end_time）
  const repairResult = validateAndRepair();
  if (repairResult.repaired > 0) {
    console.log(`[db-service] 完整性修复: 检查 ${repairResult.checked} 条, 修复 ${repairResult.repaired} 条`);
  }

  // 确保聚合表存在
  const hasAggregates = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_focus'");
  if (!hasAggregates[0] || hasAggregates[0].values.length === 0) {
    rebuildAllAggregates();
    saveToDisk();
  }
  // 确保 tag_stats 表存在
  const hasTagStats = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='tag_stats'");
  if (!hasTagStats[0] || hasTagStats[0].values.length === 0) {
    rebuildTagStats(db);
    saveToDisk();
  }

  return { success: true };
}

/**
 * 从 JSON 数组批量导入（UPSERT）
 */
/**
 * 纯 UPSERT：将记录数组写入 DB，不触发副作用（不重建聚合、不写盘、不同步 JSON）
 * 由调用方决定何时做聚合重建和持久化
 */
function migrateFromJSON(records) {
  const upsert = db.prepare(`
    INSERT INTO records (is_complete, tag, start_time, end_time, duration)
    VALUES (:is_complete, :tag, :start_time, :end_time, :duration)
    ON CONFLICT(start_time, tag) DO UPDATE SET
      is_complete = excluded.is_complete,
      end_time    = excluded.end_time,
      duration    = excluded.duration
  `);

  for (const r of records) {
    upsert.run({
      ':is_complete': r.isComplete === '是' ? 1 : 0,
      ':tag':         r.tag || '无标签',
      ':start_time':  r.startTime,
      ':end_time':    r.endTime || null,
      ':duration':    r.duration || null,
    });
  }
  upsert.free();
}

/**
 * 数据完整性校验与自动修复
 * 检查所有已完成记录：start_time + duration 是否等于 end_time
 * 不一致则根据 start_time 和 end_time 重新计算 duration
 * @returns {{ checked: number, repaired: number }}
 */
function validateAndRepair() {
  const rows = db.exec(`
    SELECT id, start_time, end_time, duration
    FROM records
    WHERE is_complete = 1 AND end_time IS NOT NULL AND duration IS NOT NULL
  `);

  if (!rows[0] || rows[0].values.length === 0) return { checked: 0, repaired: 0 };

  let repaired = 0;
  const updateStmt = db.prepare('UPDATE records SET duration = ? WHERE id = ?');

  for (const r of rows[0].values) {
    const [id, startTime, endTime, duration] = r;
    try {
      const start = parseDatetime(startTime);
      const end = parseDatetime(endTime);
      const actualSeconds = Math.round((end.getTime() - start.getTime()) / 1000);
      const recordedSeconds = durationToSeconds(duration);

      if (actualSeconds !== recordedSeconds) {
        const newDuration = secondsToDuration(Math.max(0, actualSeconds));
        updateStmt.run([newDuration, id]);
        repaired++;
        console.log(`[db-service] 修复记录 #${id}: duration ${duration} → ${newDuration}`);
      }
    } catch (e) {
      console.error(`[db-service] 校验记录 #${id} 失败:`, e.message);
    }
  }

  updateStmt.free();

  if (repaired > 0) {
    rebuildAllAggregates();
    saveToDisk();
    // syncToJSON removed: 数据以数据库为准
    console.log(`[db-service] 数据完整性修复完成: 共检查 ${rows[0].values.length} 条, 修复 ${repaired} 条`);
  }

  return { checked: rows[0].values.length, repaired };
}

// ---- CRUD ----

function insertRecord(record) {
  const isComplete = record.isComplete === '是' ? 1 : 0;
  db.run(`
    INSERT INTO records (is_complete, tag, start_time, end_time, duration)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(start_time, tag) DO UPDATE SET
      is_complete = excluded.is_complete,
      end_time    = excluded.end_time,
      duration    = excluded.duration
  `, [isComplete, record.tag || '无标签', record.startTime, record.endTime || null, record.duration || null]);

  rebuildAllAggregates();
  saveToDisk();
  // 数据以数据库为准，不再同步 JSON
  return { success: true };
}

function updateRecordEnd(startTime, endTime, duration) {
  // 精确匹配：通过 startTime 找到 is_complete=0 的记录
  let result = db.exec(
    'SELECT id FROM records WHERE start_time = ? AND is_complete = 0',
    [startTime]
  );

  if (!result[0] || result[0].values.length === 0) {
    // 兜底：找到任意一条 is_complete=0 的记录
    result = db.exec('SELECT id FROM records WHERE is_complete = 0 LIMIT 1');
    if (!result[0] || result[0].values.length === 0) {
      // 最后兜底：作为新记录插入
      return insertRecord({
        isComplete: '是',
        tag: '无标签',
        startTime: startTime || new Date().toISOString().slice(0, 19).replace('T', ' '),
        endTime: endTime,
        duration: duration
      });
    }
  }

  const id = result[0].values[0][0];
  db.run(
    'UPDATE records SET end_time = ?, duration = ?, is_complete = 1 WHERE id = ?',
    [endTime, duration, id]
  );

  rebuildAllAggregates();
  saveToDisk();
  // 数据以数据库为准，不再同步 JSON
  return { success: true };
}

function deleteRecord(startTime) {
  db.run('DELETE FROM records WHERE start_time = ?', [startTime]);

  rebuildAllAggregates();
  saveToDisk();
  // 数据以数据库为准，不再同步 JSON
  return { success: true };
}

// ---- 查询 ----

function getAllRecords() {
  const result = db.exec(`
    SELECT id, is_complete, tag, start_time, end_time, duration, created_at
    FROM records
    ORDER BY start_time DESC
  `);
  if (!result[0]) return [];
  return result[0].values.map(rowToRecord);
}

function getRecentTags(limit) {
  const result = db.exec(`
    SELECT tag, MAX(start_time) AS last_used
    FROM records
    WHERE start_time IS NOT NULL
    GROUP BY tag
    ORDER BY last_used DESC
    LIMIT ?
  `, [limit || 10]);
  if (!result[0]) return [];
  return result[0].values.map(r => ({ tag: r[0], lastUsed: r[1] }));
}

function getHotTags(limit) {
  const result = db.exec(`
    SELECT tag, COUNT(*) AS cnt, MAX(start_time) AS last_used
    FROM records
    WHERE start_time IS NOT NULL
    GROUP BY tag
    ORDER BY cnt DESC, last_used DESC
    LIMIT ?
  `, [limit || 10]);
  if (!result[0]) return [];
  return result[0].values.map(r => ({ tag: r[0], count: r[1] }));
}

/**
 * 获取标签统计表全部数据（一张表覆盖：最近使用 / 全部去重 / 按时长排序）
 * @returns {{ recentTags: [], hotTags: [], allTags: [] }}
 */
function getTagStats() {
  // 全部标签按时长降序
  const allRows = db.exec(`
    SELECT tag, total_seconds, record_count, last_used
    FROM tag_stats
    ORDER BY total_seconds DESC
  `);
  const allTags = allRows[0] ? allRows[0].values.map(r => ({
    tag: r[0],
    totalSeconds: r[1],
    recordCount: r[2],
    lastUsed: r[3]
  })) : [];

  // 最近使用 Top 10
  const recentRows = db.exec(`
    SELECT tag, total_seconds, record_count, last_used
    FROM tag_stats
    ORDER BY last_used DESC
    LIMIT 10
  `);
  const recentTags = recentRows[0] ? recentRows[0].values.map(r => ({
    tag: r[0],
    totalSeconds: r[1],
    recordCount: r[2],
    lastUsed: r[3]
  })) : [];

  // 热门 Top 10（按时长降序）
  const hotRows = db.exec(`
    SELECT tag, total_seconds, record_count, last_used
    FROM tag_stats
    ORDER BY total_seconds DESC
    LIMIT 10
  `);
  const hotTags = hotRows[0] ? hotRows[0].values.map(r => ({
    tag: r[0],
    totalSeconds: r[1],
    recordCount: r[2],
    lastUsed: r[3]
  })) : [];

  return { recentTags, hotTags, allTags };
}

// ---- 聚合数据查询（sumpage） ----

/**
 * 获取指定周期和日期的汇总数据
 * @param {'day'|'week'|'month'|'year'} period
 * @param {string} dateStr — 日期标识（日:YYYY-MM-DD, 周:周一日期, 月:YYYY-MM, 年:YYYY）
 * @returns {{ summary: {...}, tags: [...] }}
 */
function getSummaryData(period, dateStr) {
  let summaryTable, tagTable, periodCol;
  switch (period) {
    case 'day':
      summaryTable = 'daily_summary'; tagTable = 'daily_tag_focus'; periodCol = 'day'; break;
    case 'week':
      summaryTable = 'weekly_summary'; tagTable = 'weekly_tag_focus'; periodCol = 'week'; break;
    case 'month':
      summaryTable = 'monthly_summary'; tagTable = 'monthly_tag_focus'; periodCol = 'month'; break;
    case 'year':
      summaryTable = 'yearly_summary'; tagTable = 'yearly_tag_focus'; periodCol = 'year'; break;
    default:
      return null;
  }

  // 汇总数据
  const summaryRows = db.exec(
    `SELECT total_seconds, task_count, top_tag, top_tag_seconds, prev_seconds, diff_seconds
     FROM ${summaryTable} WHERE ${periodCol} = ?`,
    [dateStr]
  );

  let summary = null;
  if (summaryRows[0] && summaryRows[0].values.length > 0) {
    const r = summaryRows[0].values[0];
    summary = {
      total_seconds: r[0],
      task_count: r[1],
      top_tag: r[2],
      top_tag_seconds: r[3],
      prev_seconds: r[4],  // null if no previous period
      diff_seconds: r[5]
    };
  }

  // 标签数据
  const tagRows = db.exec(
    `SELECT tag, total_seconds FROM ${tagTable} WHERE ${periodCol} = ? ORDER BY total_seconds DESC`,
    [dateStr]
  );
  let tags = [];
  if (tagRows[0]) {
    tags = tagRows[0].values.map(r => ({ tag: r[0], total_seconds: r[1] }));
  }

  return { summary, tags };
}

/**
 * 获取24小时分布（单位：分钟）
 * @returns {number[]} 长度为 24 的数组
 */
function getHourlyDistribution(period, dateStr) {
  let table, keyCol, keyVal;
  switch (period) {
    case 'day':
      table = 'hourly_focus'; keyCol = 'day'; keyVal = dateStr; break;
    case 'week':
      table = 'weekly_hourly_focus'; keyCol = 'week'; keyVal = dateStr; break;
    case 'month':
      table = 'monthly_hourly_focus'; keyCol = 'month'; keyVal = dateStr; break;
    case 'year':
      table = 'yearly_hourly_focus'; keyCol = 'year'; keyVal = dateStr; break;
    default:
      return new Array(24).fill(0);
  }

  const rows = db.exec(
    `SELECT hour, total_seconds FROM ${table} WHERE ${keyCol} = ? ORDER BY hour`,
    [keyVal]
  );
  const slots = new Array(24).fill(0);
  if (rows[0]) {
    for (const r of rows[0].values) {
      const hour = r[0];
      const seconds = r[1];
      if (hour >= 0 && hour < 24) {
        slots[hour] = Math.round(seconds / 60); // 秒 → 分钟
      }
    }
  }
  return slots;
}

/**
 * 获取活跃时段分布（周/月/年）
 * @returns {{ bars: number[], labels: string[] }}
 */
function getActiveDistribution(period, dateStr) {
  if (period === 'day') return null;

  switch (period) {
    case 'week': {
      const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
      const bars = new Array(7).fill(0);
      const rows = db.exec(
        'SELECT day_of_week, total_seconds FROM weekly_daily_focus WHERE week = ? ORDER BY day_of_week',
        [dateStr]
      );
      if (rows[0]) {
        for (const r of rows[0].values) {
          const dow = r[0]; // 1=Mon ... 7=Sun
          if (dow >= 1 && dow <= 7) {
            bars[dow - 1] = Math.round(r[1] / 60); // 秒 → 分钟
          }
        }
      }
      return { bars, labels: DAY_LABELS };
    }
    case 'month': {
      const mParts = dateStr.split('-');
      const daysInMonth = new Date(parseInt(mParts[0]), parseInt(mParts[1]), 0).getDate();
      const bars = new Array(daysInMonth).fill(0);
      const rows = db.exec(
        'SELECT day_of_month, total_seconds FROM monthly_daily_focus WHERE month = ? ORDER BY day_of_month',
        [dateStr]
      );
      if (rows[0]) {
        for (const r of rows[0].values) {
          const dom = r[0];
          if (dom >= 1 && dom <= daysInMonth) {
            bars[dom - 1] = Math.round(r[1] / 60);
          }
        }
      }
      const labels = [];
      for (let d = 1; d <= daysInMonth; d++) labels.push(String(d));
      return { bars, labels };
    }
    case 'year': {
      const MONTH_LABELS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
      const bars = new Array(12).fill(0);
      const rows = db.exec(
        'SELECT month_of_year, total_seconds FROM yearly_monthly_focus WHERE year = ? ORDER BY month_of_year',
        [dateStr]
      );
      if (rows[0]) {
        for (const r of rows[0].values) {
          const moy = r[0];
          if (moy >= 1 && moy <= 12) {
            bars[moy - 1] = Math.round(r[1] / 60);
          }
        }
      }
      return { bars, labels: MONTH_LABELS };
    }
    default:
      return null;
  }
}

/**
 * 获取指定年份的所有记录（用于历史视图）
 */
function getRecordsForYear(year) {
  const result = db.exec(`
    SELECT id, is_complete, tag, start_time, end_time, duration, created_at
    FROM records
    WHERE start_time LIKE ?
    ORDER BY start_time DESC
  `, [String(year) + '-%']);
  if (!result[0]) return [];
  return result[0].values.map(rowToRecord);
}

/**
 * 获取所有日期的专注秒数映射（用于热力图）
 * @returns {Object<string, number>} { "YYYY-MM-DD": totalSeconds }
 */
function getAllDayMap() {
  const rows = db.exec('SELECT period, total_seconds FROM daily_focus');
  const map = {};
  if (rows[0]) {
    for (const r of rows[0].values) {
      map[r[0]] = r[1];
    }
  }
  return map;
}

// ---- 持久化 ----

function saveToDisk() {
  if (!db || !dbPath) return;
  const data = db.export();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function close() {
  if (db) {
    saveToDisk();
    db.close();
    db = null;
  }
}

// ============================================================
//  导出
// ============================================================

module.exports = {
  initDB,
  migrateFromJSON,
  validateAndRepair,
  insertRecord,
  updateRecordEnd,
  deleteRecord,
  getAllRecords,
  getRecentTags,
  getHotTags,
  getSummaryData,
  getHourlyDistribution,
  getActiveDistribution,
  getRecordsForYear,
  getAllDayMap,
  getTagStats,
  saveToDisk,
  close,
  // 工具函数也导出，方便测试
  _utils: {
    parseDatetime,
    durationToSeconds,
    secondsToDuration,
    dayKey,
    weekKey,
    monthKey,
    yearKey,
    hourKey
  }
};
