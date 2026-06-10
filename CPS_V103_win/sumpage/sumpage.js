(function () {
  /* ========== DOM 引用 ========== */
  var tagSummary   = document.getElementById('tagSummary');
  var hourlyChart  = document.getElementById('hourlyChart');
  var periodTabs   = document.getElementById('periodTabs');
  var periodLabel  = document.getElementById('periodLabel');
  var periodPrev   = document.getElementById('periodPrev');
  var periodNext   = document.getElementById('periodNext');
  var viewTabs     = document.getElementById('viewTabs');
  var viewSummary  = document.getElementById('viewSummary');
  var viewTag      = document.getElementById('viewTag');
  var viewActive   = document.getElementById('viewActive');
  var viewChart    = document.getElementById('viewChart');
  var viewHistory  = document.getElementById('viewHistory');
  var historyList  = document.getElementById('historyList');
  var currentView  = 'summary'; // 'summary' | 'tag' | 'active' | 'chart' | 'history'

  // 动态标签引用
  var summaryViewTab     = document.getElementById('summaryViewTab');
  var summaryTimeLabel   = document.getElementById('summaryTimeLabel');
  var summaryCountLabel  = document.getElementById('summaryCountLabel');
  var summaryCompareLabel = document.getElementById('summaryCompareLabel');
  var historyViewTab     = document.getElementById('historyViewTab');
  var chartViewTab       = document.getElementById('chartViewTab');
  var activeViewTab      = document.getElementById('activeViewTab');
  var activeChart        = document.getElementById('activeChart');

  /* ========== 周期文本映射 ========== */
  var PERIOD_LABELS = {
    day:   { viewTab: '今日汇总', time: '今日专注总时长', count: '今日任务数', compare: '较昨日', chartTab: '活跃时段', activeTab: '' },
    week:  { viewTab: '本周汇总', time: '本周专注总时长', count: '本周任务数', compare: '较上周', chartTab: '活跃时段', activeTab: '活跃日段' },
    month: { viewTab: '本月汇总', time: '本月专注总时长', count: '本月任务数', compare: '较上月', chartTab: '活跃时段', activeTab: '活跃日段' },
    year:  { viewTab: '本年汇总', time: '本年专注总时长', count: '本年任务数', compare: '较去年', chartTab: '活跃时段', activeTab: '活跃月段' }
  };

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  // 活跃时段 Y 轴最大值（分钟）— 根据当前周期的实际天数动态计算
  function getPeriodYMax() {
    switch (period) {
      case 'day':
        return 60;                    // 1 天 × 60 min
      case 'week':
        return 420;                   // 7 天 × 60 min
      case 'month': {
        var daysInMonth = new Date(cursorDate.getFullYear(), cursorDate.getMonth() + 1, 0).getDate();
        return daysInMonth * 60;      // 28~31 天 × 60 min
      }
      case 'year': {
        var daysInYear = isLeapYear(cursorDate.getFullYear()) ? 366 : 365;
        return daysInYear * 60;       // 365/366 天 × 60 min
      }
    }
    return 60;
  }

  // 活跃日段/月段 Y 轴最大值（分钟）
  var ACTIVE_YMAX = {
    week:  1440,   // 24h 每天
    month: 1440,   // 24h 每天
    year:  44640   // 744h 每月 (31天×24h)
  };

  function updateSummaryLabels() {
    var labels = PERIOD_LABELS[period];
    if (!labels) return;
    if (summaryViewTab) summaryViewTab.textContent = labels.viewTab;
    if (summaryTimeLabel) summaryTimeLabel.textContent = labels.time;
    if (summaryCountLabel) summaryCountLabel.textContent = labels.count;
    if (summaryCompareLabel) summaryCompareLabel.textContent = labels.compare;
    if (chartViewTab) chartViewTab.textContent = labels.chartTab;
    // 活跃日段/月段标签：仅周/月/年显示
    if (activeViewTab) {
      activeViewTab.textContent = labels.activeTab;
      activeViewTab.style.display = period === 'day' ? 'none' : '';
    }
    // 历史记录标签：仅日视图显示
    if (historyViewTab) {
      historyViewTab.style.display = period === 'day' ? '' : 'none';
    }
    // 日视图时如果当前选中的是活跃日段或历史记录，切回汇总
    if (period === 'day' && currentView === 'active') {
      switchToView('summary');
    }
    if (period !== 'day' && currentView === 'history') {
      switchToView('summary');
    }
  }

  /* ========== 日期工具 ========== */
  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  function dateStr(y, m, d) {
    return y + '-' + pad2(m) + '-' + pad2(d);
  }

  // 获取某天所在的周一日期
  function getMonday(d) {
    var c = new Date(d);
    var day = c.getDay(); // 0=Sun
    var diff = day === 0 ? -6 : 1 - day;
    c.setDate(c.getDate() + diff);
    c.setHours(0, 0, 0, 0);
    return c;
  }

  // 获取某天所在的周日日期
  function getSunday(monday) {
    var c = new Date(monday);
    c.setDate(c.getDate() + 6);
    return c;
  }

  // 月初
  function getMonthStart(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  // 月末
  function getMonthEnd(d) {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }

  // 年初
  function getYearStart(d) {
    return new Date(d.getFullYear(), 0, 1);
  }

  // 年末
  function getYearEnd(d) {
    return new Date(d.getFullYear(), 11, 31);
  }

  // 判断日期是否在范围内 [start, end]
  function inRange(dateStr, start, end) {
    return dateStr >= start && dateStr <= end;
  }

  /* ========== 导航边界 ========== */
  var MIN_DATE = new Date(2026, 0, 1);   // 2026-01-01
  var MAX_DATE = new Date(2032, 11, 31);  // 2032-12-31

  /* ========== 周期状态 ========== */
  var period = 'day';       // 'day' | 'week' | 'month' | 'year'
  var cursorDate = new Date(); // 当前参考日期
  cursorDate.setHours(0, 0, 0, 0);

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  // 根据 period 和 cursorDate 计算 [rangeStart, rangeEnd] 的日期字符串
  function getRange() {
    var start, end;
    switch (period) {
      case 'day':
        start = cursorDate;
        end = cursorDate;
        break;
      case 'week':
        start = getMonday(cursorDate);
        end = getSunday(start);
        break;
      case 'month':
        start = getMonthStart(cursorDate);
        end = getMonthEnd(cursorDate);
        break;
      case 'year':
        start = getYearStart(cursorDate);
        end = getYearEnd(cursorDate);
        break;
    }
    return {
      startStr: dateStr(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      endStr: dateStr(end.getFullYear(), end.getMonth() + 1, end.getDate())
    };
  }

  // 获取上一周期的日期范围（用于对比）
  function getPrevPeriodRange() {
    var start, end;
    switch (period) {
      case 'day': {
        var prev = new Date(cursorDate);
        prev.setDate(prev.getDate() - 1);
        start = prev;
        end = prev;
        break;
      }
      case 'week': {
        var mon = getMonday(cursorDate);
        var prevMon = new Date(mon);
        prevMon.setDate(prevMon.getDate() - 7);
        var prevSun = getSunday(prevMon);
        start = prevMon;
        end = prevSun;
        break;
      }
      case 'month': {
        var ms = getMonthStart(cursorDate);
        start = new Date(ms.getFullYear(), ms.getMonth() - 1, 1);
        end = new Date(ms.getFullYear(), ms.getMonth(), 0);
        break;
      }
      case 'year': {
        start = new Date(cursorDate.getFullYear() - 1, 0, 1);
        end = new Date(cursorDate.getFullYear() - 1, 11, 31);
        break;
      }
    }
    return {
      startStr: dateStr(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      endStr: dateStr(end.getFullYear(), end.getMonth() + 1, end.getDate())
    };
  }

  // 是否可以向后（未来方向）导航
  function canGoNext() {
    switch (period) {
      case 'day': {
        var next = new Date(cursorDate);
        next.setDate(next.getDate() + 1);
        return next <= MAX_DATE;
      }
      case 'week': {
        var mon = getMonday(cursorDate);
        var nextMon = new Date(mon);
        nextMon.setDate(nextMon.getDate() + 7);
        return nextMon <= MAX_DATE;
      }
      case 'month': {
        var ms = getMonthStart(cursorDate);
        var nextMonth = new Date(ms.getFullYear(), ms.getMonth() + 1, 1);
        return nextMonth <= MAX_DATE;
      }
      case 'year':
        return cursorDate.getFullYear() < 2032;
    }
    return false;
  }

  // 是否可以向前（过去方向）导航
  function canGoPrev() {
    switch (period) {
      case 'day': {
        var prev = new Date(cursorDate);
        prev.setDate(prev.getDate() - 1);
        return prev >= MIN_DATE;
      }
      case 'week': {
        var mon = getMonday(cursorDate);
        var prevMon = new Date(mon);
        prevMon.setDate(prevMon.getDate() - 7);
        return prevMon >= MIN_DATE;
      }
      case 'month': {
        var ms = getMonthStart(cursorDate);
        var prevMonth = new Date(ms.getFullYear(), ms.getMonth() - 1, 1);
        return prevMonth >= MIN_DATE;
      }
      case 'year':
        return cursorDate.getFullYear() > 2026;
    }
    return false;
  }

  // 格式化周期标签
  function formatPeriodLabel() {
    switch (period) {
      case 'day': {
        var y = cursorDate.getFullYear();
        var m = cursorDate.getMonth() + 1;
        var d = cursorDate.getDate();
        var w = WEEKDAYS[cursorDate.getDay()];
        return y + '年' + m + '月' + d + '日 周' + w;
      }
      case 'week': {
        var mon = getMonday(cursorDate);
        var sun = getSunday(mon);
        return mon.getMonth() + 1 + '/' + mon.getDate() + ' - ' + (sun.getMonth() + 1) + '/' + sun.getDate();
      }
      case 'month': {
        return cursorDate.getFullYear() + '年' + (cursorDate.getMonth() + 1) + '月';
      }
      case 'year': {
        return cursorDate.getFullYear() + '年';
      }
    }
    return '';
  }

  function updateNavButtons() {
    periodPrev.classList.toggle('disabled', !canGoPrev());
    periodNext.classList.toggle('disabled', !canGoNext());
  }

  function updateLabel() {
    periodLabel.textContent = formatPeriodLabel();
  }

  function navigatePrev() {
    if (!canGoPrev()) return;
    switch (period) {
      case 'day':
        cursorDate.setDate(cursorDate.getDate() - 1);
        break;
      case 'week':
        cursorDate.setDate(cursorDate.getDate() - 7);
        break;
      case 'month':
        cursorDate.setMonth(cursorDate.getMonth() - 1);
        break;
      case 'year':
        cursorDate.setFullYear(cursorDate.getFullYear() - 1);
        break;
    }
    updateLabel();
    updateNavButtons();
    renderAll();
  }

  function navigateNext() {
    if (!canGoNext()) return;
    switch (period) {
      case 'day':
        cursorDate.setDate(cursorDate.getDate() + 1);
        break;
      case 'week':
        cursorDate.setDate(cursorDate.getDate() + 7);
        break;
      case 'month':
        cursorDate.setMonth(cursorDate.getMonth() + 1);
        break;
      case 'year':
        cursorDate.setFullYear(cursorDate.getFullYear() + 1);
        break;
    }
    updateLabel();
    updateNavButtons();
    renderAll();
  }

  // 切换周期时重置 cursorDate 到今天
  function switchPeriod(newPeriod) {
    if (period === newPeriod) return;
    period = newPeriod;
    cursorDate = new Date(today);
    updateLabel();
    updateNavButtons();
    updateSummaryLabels();
    renderAll();
  }

  /* ========== 数据存储（Electron IPC） ========== */
  var api = window.electronAPI;

  async function readRecordsFromFile() {
    return await api.readRecords();
  }

  /* ========== 数据分析 ========== */

  function parseDuration(dur) {
    if (!dur) return 0;
    var parts = String(dur).split(':');
    if (parts.length !== 3) return 0;
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  }

  // 将一条记录的时长按分钟比例拆分到跨过的每一天
  // 返回 { dateStr: seconds } 映射
  function splitRecordByDay(record) {
    var result = {};
    var durSec = parseDuration(record.duration);

    if (!record.startTime || !record.endTime) {
      var ts = record.startTime || record.endTime;
      if (ts) result[ts.substring(0, 10)] = durSec;
      return result;
    }

    var sDate = record.startTime.substring(0, 10);
    var eDate = record.endTime.substring(0, 10);

    if (sDate === eDate) {
      result[sDate] = durSec;
      return result;
    }

    var sTime = record.startTime.substring(11, 16);
    var eTime = record.endTime.substring(11, 16);
    var sH = parseInt(sTime.substring(0, 2), 10);
    var sM = parseInt(sTime.substring(3, 5), 10);
    var eH = parseInt(eTime.substring(0, 2), 10);
    var eM = parseInt(eTime.substring(3, 5), 10);

    var sParts = sDate.split('-');
    var eParts = eDate.split('-');
    var sDateObj = new Date(parseInt(sParts[0], 10), parseInt(sParts[1], 10) - 1, parseInt(sParts[2], 10));
    var eDateObj = new Date(parseInt(eParts[0], 10), parseInt(eParts[1], 10) - 1, parseInt(eParts[2], 10));
    var totalMin = (eDateObj - sDateObj) / 60000 + (eH * 60 + eM) - (sH * 60 + sM);

    if (totalMin <= 0) {
      result[sDate] = durSec;
      return result;
    }

    var assigned = 0;
    var dates = [];

    // 开始日
    dates.push({ d: sDate, m: 24 * 60 - (sH * 60 + sM) });

    // 中间完整天
    var cursor = new Date(sDateObj);
    cursor.setDate(cursor.getDate() + 1);
    while (cursor < eDateObj) {
      var ds = dateStr(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate());
      dates.push({ d: ds, m: 24 * 60 });
      cursor.setDate(cursor.getDate() + 1);
    }

    // 结束日
    var endMin = eH * 60 + eM;
    if (endMin > 0) {
      dates.push({ d: eDate, m: endMin });
    }

    for (var i = 0; i < dates.length; i++) {
      var sec;
      if (i === dates.length - 1) {
        sec = durSec - assigned;
      } else {
        sec = Math.round(durSec * dates[i].m / totalMin);
        assigned += sec;
      }
      if (sec > 0) {
        result[dates[i].d] = (result[dates[i].d] || 0) + sec;
      }
    }

    return result;
  }

  // 计算一条记录在指定日期范围内的时长（秒），跨天按比例拆分
  function getRecordSecondsInRange(record, startStr, endStr) {
    var splits = splitRecordByDay(record);
    var total = 0;
    for (var dateKey in splits) {
      if (splits.hasOwnProperty(dateKey) && inRange(dateKey, startStr, endStr)) {
        total += splits[dateKey];
      }
    }
    return total;
  }

  // 判断一条记录的时间范围是否与 [startStr, endStr] 有交集
  function recordOverlapsRange(record, startStr, endStr) {
    var sDate = record.startTime ? record.startTime.substring(0, 10) : null;
    var eDate = record.endTime ? record.endTime.substring(0, 10) : null;
    if (!sDate && !eDate) return false;
    if (!sDate) sDate = eDate;
    if (!eDate) eDate = sDate;
    return sDate <= endStr && eDate >= startStr;
  }

  // 筛选当前周期内有交集的记录（含跨天）
  function filterByPeriod(records) {
    var range = getRange();
    var filtered = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (recordOverlapsRange(r, range.startStr, range.endStr)) {
        filtered.push(r);
      }
    }
    return filtered;
  }

  // 按标签聚合
  function aggregateByTag(records, startStr, endStr) {
    var map = {};
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var tag = r.tag || '无标签';
      var sec = getRecordSecondsInRange(r, startStr, endStr);
      if (sec <= 0) continue;
      if (!map[tag]) {
        map[tag] = { count: 0, totalSeconds: 0 };
      }
      map[tag].count += 1;
      map[tag].totalSeconds += sec;
    }
    return map;
  }

  /* ========== 24小时分布计算 ========== */

  // 合并同一天内重叠的时间区间，避免同一小时被多条记录重复累加
  function mergeDayIntervals(intervals) {
    if (intervals.length === 0) return [];
    // 按开始时间排序（转为分钟数比较）
    intervals.sort(function (a, b) {
      var as = a.sh * 60 + a.sm;
      var bs = b.sh * 60 + b.sm;
      return as - bs;
    });

    var merged = [];
    var cur = { sh: intervals[0].sh, sm: intervals[0].sm, eh: intervals[0].eh, em: intervals[0].em };

    for (var i = 1; i < intervals.length; i++) {
      var next = intervals[i];
      var curEnd = cur.eh * 60 + cur.em;
      var nextStart = next.sh * 60 + next.sm;
      var nextEnd = next.eh * 60 + next.em;

      if (nextStart <= curEnd) {
        // 区间重叠或相邻，合并
        if (nextEnd > curEnd) {
          cur.eh = next.eh;
          cur.em = next.em;
        }
      } else {
        merged.push(cur);
        cur = { sh: next.sh, sm: next.sm, eh: next.eh, em: next.em };
      }
    }
    merged.push(cur);
    return merged;
  }

  function calcHourlyDistribution(records) {
    var slots = new Array(24);
    for (var i = 0; i < 24; i++) { slots[i] = 0; }

    var range = getRange();
    var dayIntervals = {}; // dateStr -> [{sh, sm, eh, em}]

    for (var j = 0; j < records.length; j++) {
      var r = records[j];
      if (!r.startTime || !r.endTime) continue;

      var sParts = r.startTime.split(' ');
      var eParts = r.endTime.split(' ');
      if (sParts.length < 2 || eParts.length < 2) continue;

      var sDate = sParts[0];
      var sTime = sParts[1];
      var eDate = eParts[0];
      var eTime = eParts[1];

      var sH = parseInt(sTime.substring(0, 2), 10);
      var sM = parseInt(sTime.substring(3, 5), 10);
      var eH = parseInt(eTime.substring(0, 2), 10);
      var eM = parseInt(eTime.substring(3, 5), 10);

      if (sDate === eDate) {
        if (!dayIntervals[sDate]) dayIntervals[sDate] = [];
        dayIntervals[sDate].push({ sh: sH, sm: sM, eh: eH, em: eM });
      } else {
        // 跨天记录：拆到各自日期，避免次日时段错误累加到当天
        if (!dayIntervals[sDate]) dayIntervals[sDate] = [];
        dayIntervals[sDate].push({ sh: sH, sm: sM, eh: 24, em: 0 });

        if (!dayIntervals[eDate]) dayIntervals[eDate] = [];
        dayIntervals[eDate].push({ sh: 0, sm: 0, eh: eH, em: eM });
      }
    }

    // 只处理当前周期内的日期，合并重叠区间后分配到小时槽
    for (var dateKey in dayIntervals) {
      if (!dayIntervals.hasOwnProperty(dateKey)) continue;
      if (dateKey < range.startStr || dateKey > range.endStr) continue;

      var intervals = dayIntervals[dateKey];
      var merged = mergeDayIntervals(intervals);

      for (var k = 0; k < merged.length; k++) {
        var m = merged[k];
        if (m.sh === m.eh) {
          if (m.eh < 24) slots[m.sh] += m.em - m.sm;
        } else {
          if (m.sh < 24) slots[m.sh] += 60 - m.sm;
          var endH = m.eh > 23 ? 24 : m.eh;
          for (var h = m.sh + 1; h < endH; h++) {
            slots[h] += 60;
          }
          if (m.eh < 24) slots[m.eh] += m.em;
        }
      }
    }

    return slots; // 单位：分钟
  }

  // 活跃日段/月段：按天或按月聚合（单位：分钟），合并重叠区间后统计
  function calcActiveDistribution(records) {
    // 按日期分组，合并重叠区间，计算每天的实际专注分钟数
    var dayMinutes = {}; // "YYYY-MM-DD" -> total minutes after merge
    var range = getRange();

    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!r.startTime || !r.endTime) continue;

      var sParts = r.startTime.split(' ');
      var eParts = r.endTime.split(' ');
      if (sParts.length < 2 || eParts.length < 2) continue;

      var sDate = sParts[0];
      var sTime = sParts[1];
      var eDate = eParts[0];
      var eTime = eParts[1];

      var sH = parseInt(sTime.substring(0, 2), 10);
      var sM = parseInt(sTime.substring(3, 5), 10);
      var eH = parseInt(eTime.substring(0, 2), 10);
      var eM = parseInt(eTime.substring(3, 5), 10);

      if (sDate === eDate) {
        if (!dayMinutes[sDate]) dayMinutes[sDate] = [];
        dayMinutes[sDate].push({ sh: sH, sm: sM, eh: eH, em: eM });
      } else {
        // 跨天拆分
        if (!dayMinutes[sDate]) dayMinutes[sDate] = [];
        dayMinutes[sDate].push({ sh: sH, sm: sM, eh: 24, em: 0 });

        if (!dayMinutes[eDate]) dayMinutes[eDate] = [];
        dayMinutes[eDate].push({ sh: 0, sm: 0, eh: eH, em: eM });
      }
    }

    // 每天合并区间后计算总分钟数
    var mergedDayMinutes = {};
    for (var dateKey in dayMinutes) {
      if (!dayMinutes.hasOwnProperty(dateKey)) continue;
      if (dateKey < range.startStr || dateKey > range.endStr) continue;

      var merged = mergeDayIntervals(dayMinutes[dateKey]);
      var totalMin = 0;
      for (var k = 0; k < merged.length; k++) {
        var m = merged[k];
        var dur;
        if (m.sh === m.eh) {
          dur = m.em - m.sm;
        } else {
          dur = (60 - m.sm) + (m.eh - m.sh - 1) * 60 + m.em;
        }
        if (dur > 0) totalMin += dur;
      }
      mergedDayMinutes[dateKey] = totalMin;
    }

    var bars, labels;
    switch (period) {
      case 'week': {
        bars = [0, 0, 0, 0, 0, 0, 0]; // Mon-Sun
        var mon = getMonday(cursorDate);
        for (var dk in mergedDayMinutes) {
          if (!mergedDayMinutes.hasOwnProperty(dk)) continue;
          var parts = dk.split('-');
          var recDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          var diffDays = Math.floor((recDate - mon) / (1000 * 60 * 60 * 24));
          if (diffDays >= 0 && diffDays < 7) {
            bars[diffDays] += mergedDayMinutes[dk];
          }
        }
        labels = ['一', '二', '三', '四', '五', '六', '日'];
        break;
      }
      case 'month': {
        var daysInMonth = new Date(cursorDate.getFullYear(), cursorDate.getMonth() + 1, 0).getDate();
        bars = new Array(daysInMonth);
        for (var d = 0; d < daysInMonth; d++) { bars[d] = 0; }
        for (var dk2 in mergedDayMinutes) {
          if (!mergedDayMinutes.hasOwnProperty(dk2)) continue;
          var day = parseInt(dk2.substring(8, 10), 10);
          if (day >= 1 && day <= daysInMonth) {
            bars[day - 1] += mergedDayMinutes[dk2];
          }
        }
        labels = [];
        for (var d2 = 1; d2 <= daysInMonth; d2++) {
          labels.push(String(d2));
        }
        break;
      }
      case 'year': {
        bars = new Array(12);
        for (var m2 = 0; m2 < 12; m2++) { bars[m2] = 0; }
        for (var dk3 in mergedDayMinutes) {
          if (!mergedDayMinutes.hasOwnProperty(dk3)) continue;
          var month = parseInt(dk3.substring(5, 7), 10);
          if (month >= 1 && month <= 12) {
            bars[month - 1] += mergedDayMinutes[dk3];
          }
        }
        labels = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
        break;
      }
    }
    return { bars: bars, labels: labels };
  }

  /* ========== 渲染 ========== */

  var TAG_COLORS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];

  function renderTagSummary(tagMap, totalHours) {
    tagSummary.innerHTML = '';

    var entries = [];
    for (var key in tagMap) {
      if (tagMap.hasOwnProperty(key)) {
        entries.push({
          tag: key,
          count: tagMap[key].count,
          hours: tagMap[key].totalSeconds / 3600
        });
      }
    }

    // 不足 8 条用占位补齐
    while (entries.length < 8) {
      entries.push({ tag: '待统计', count: 0, hours: 0, placeholder: true });
    }

    entries.sort(function (a, b) {
      // 占位始终排最后
      if (a.placeholder !== b.placeholder) return a.placeholder ? 1 : -1;
      return b.hours - a.hours;
    });

    var maxH = entries[0].hours;

    // 创建自定义 tooltip（如果还不存在）
    if (!document.getElementById('tagTooltip')) {
      var tagTip = document.createElement('div');
      tagTip.className = 'tag-tooltip';
      tagTip.id = 'tagTooltip';
      document.body.appendChild(tagTip);
    }

    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      var pct = totalHours > 0 ? (entry.hours / totalHours * 100) : 0;
      var barPct = maxH > 0 ? (entry.hours / maxH * 100) : 0;
      var colorClass = entry.placeholder ? 'c-placeholder' : TAG_COLORS[j % TAG_COLORS.length];

      // tooltip HTML：标签名高亮 + 时长
      var ttHTML = entry.placeholder
        ? '暂无数据'
        : ('<span class="tt-tag">' + entry.tag + '</span><br><span class="tt-time">' + entry.hours.toFixed(1) + ' 小时</span>');

      var row = document.createElement('div');
      row.className = 'tag-row';

      var name = document.createElement('span');
      name.className = 'tag-row-name';
      name.textContent = entry.tag;
      name.dataset.tip = ttHTML;
      name.addEventListener('mouseenter', showTagTooltip);
      name.addEventListener('mouseleave', hideTagTooltip);

      var track = document.createElement('div');
      track.className = 'tag-row-track';
      track.dataset.tip = ttHTML;
      track.addEventListener('mouseenter', showTagTooltip);
      track.addEventListener('mouseleave', hideTagTooltip);

      var fill = document.createElement('div');
      fill.className = 'tag-row-fill ' + colorClass;
      fill.style.width = Math.max(barPct, 2) + '%';

      var hoursText = document.createElement('span');
      hoursText.className = 'tag-row-hours';
      hoursText.textContent = entry.hours.toFixed(1) + 'h';

      var pctText = document.createElement('span');
      pctText.className = 'tag-row-pct';
      pctText.textContent = entry.placeholder ? '-' : pct.toFixed(1) + '%';

      // 时长文字放在 row 层级（track 之后），彻底避免进度条窄时截断
      track.appendChild(fill);
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(hoursText);
      row.appendChild(pctText);
      tagSummary.appendChild(row);
    }
  }

  function renderHourlyChart(slots, yMax) {
    hourlyChart.innerHTML = '';

    // 创建 tooltip（如果还不存在）
    if (!document.getElementById('hourlyTooltip')) {
      var tip = document.createElement('div');
      tip.className = 'hourly-tooltip';
      tip.id = 'hourlyTooltip';
      document.body.appendChild(tip);
    }

    var ySteps = 4;
    var yStepVal = yMax / ySteps;

    // Y 轴标签
    var yLabels = document.createElement('div');
    yLabels.className = 'hourly-y-labels';
    for (var yi = ySteps; yi >= 0; yi--) {
      var label = document.createElement('span');
      label.className = 'hourly-y-label';
      var val = yi * yStepVal;
      if (val >= 60) {
        var hVal = val / 60;
        label.textContent = (hVal === Math.floor(hVal) ? hVal : hVal.toFixed(1)) + 'h';
      } else {
        label.textContent = val + 'm';
      }
      yLabels.appendChild(label);
    }
    hourlyChart.appendChild(yLabels);

    // 水平网格线 (与 Y 轴刻度对齐：45m / 30m / 15m)
    var gridWrap = document.createElement('div');
    gridWrap.className = 'hourly-grid-wrap';
    for (var gi = 0; gi < 5; gi++) {
      var gridLine = document.createElement('div');
      gridLine.className = 'hourly-grid-line';
      // 隐藏顶部(60m)和底部(0m)的网格线
      if (gi === 0 || gi === 4) {
        gridLine.style.borderTop = 'none';
      }
      gridWrap.appendChild(gridLine);
    }
    hourlyChart.appendChild(gridWrap);

    // 柱子
    for (var h = 0; h < 24; h++) {
      var col = document.createElement('div');
      col.className = 'hourly-col';

      var bar = document.createElement('div');
      bar.className = 'hourly-bar';
      var heightPct = yMax > 0 ? (slots[h] / yMax * 100) : 0;
      bar.style.height = Math.min(Math.max(heightPct, slots[h] > 0 ? 2 : 0), 100) + '%';
      bar.dataset.hour = h;
      bar.dataset.minutes = slots[h];
      bar.addEventListener('mouseenter', showHourlyTooltip);
      bar.addEventListener('mouseleave', hideHourlyTooltip);

      var colLabel = document.createElement('span');
      colLabel.className = 'hourly-col-label';
      colLabel.textContent = h;

      col.appendChild(bar);
      col.appendChild(colLabel);
      hourlyChart.appendChild(col);
    }
  }

  // 活跃日段/月段柱状图（可变柱子数）
  function renderActiveDayChart(bars, yMax, labels) {
    activeChart.innerHTML = '';

    // 创建 tooltip（如果还不存在）
    if (!document.getElementById('hourlyTooltip')) {
      var tip = document.createElement('div');
      tip.className = 'hourly-tooltip';
      tip.id = 'hourlyTooltip';
      document.body.appendChild(tip);
    }

    var ySteps = 4;
    var yStepVal = yMax / ySteps;

    // Y 轴标签
    var yLabels = document.createElement('div');
    yLabels.className = 'hourly-y-labels';
    for (var yi = ySteps; yi >= 0; yi--) {
      var label = document.createElement('span');
      label.className = 'hourly-y-label';
      var val = yi * yStepVal;
      if (val >= 60) {
        var hVal = val / 60;
        label.textContent = (hVal === Math.floor(hVal) ? hVal : hVal.toFixed(1)) + 'h';
      } else {
        label.textContent = val + 'm';
      }
      yLabels.appendChild(label);
    }
    activeChart.appendChild(yLabels);

    // 水平网格线
    var gridWrap = document.createElement('div');
    gridWrap.className = 'hourly-grid-wrap';
    for (var gi = 0; gi < 5; gi++) {
      var gridLine = document.createElement('div');
      gridLine.className = 'hourly-grid-line';
      if (gi === 0 || gi === 4) {
        gridLine.style.borderTop = 'none';
      }
      gridWrap.appendChild(gridLine);
    }
    activeChart.appendChild(gridWrap);

    // 柱子
    for (var i = 0; i < bars.length; i++) {
      var col = document.createElement('div');
      col.className = 'hourly-col';

      var bar = document.createElement('div');
      bar.className = 'hourly-bar';
      var heightPct = yMax > 0 ? (bars[i] / yMax * 100) : 0;
      bar.style.height = Math.min(Math.max(heightPct, bars[i] > 0 ? 2 : 0), 100) + '%';
      bar.dataset.label = labels[i];
      bar.dataset.minutes = bars[i];
      bar.addEventListener('mouseenter', showActiveTooltip);
      bar.addEventListener('mouseleave', hideActiveTooltip);

      var colLabel = document.createElement('span');
      colLabel.className = 'hourly-col-label';
      colLabel.textContent = labels[i];

      col.appendChild(bar);
      col.appendChild(colLabel);
      activeChart.appendChild(col);
    }
  }

  function showActiveTooltip(e) {
    var bar = e.target;
    var label = bar.dataset.label || '';
    var minutes = parseInt(bar.dataset.minutes, 10);
    var tip = document.getElementById('hourlyTooltip');
    if (!tip) return;

    var title = label;
    if (period === 'week') title = '周' + label;
    else if (period === 'month') title = (cursorDate.getMonth() + 1) + '月' + label + '日';
    else if (period === 'year') title = label;
    tip.innerHTML = title + '<br>' + formatTooltipTime(minutes);
    tip.className = 'hourly-tooltip visible';

    var rect = bar.getBoundingClientRect();
    var tipW = tip.offsetWidth;
    var tipH = tip.offsetHeight;
    var left = rect.left + rect.width / 2 - tipW / 2;
    var top = rect.top - tipH - 6;
    if (left < 4) left = 4;
    if (left + tipW > window.innerWidth - 4) left = window.innerWidth - tipW - 4;
    if (top < 4) top = rect.bottom + 6;

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideActiveTooltip() {
    var tip = document.getElementById('hourlyTooltip');
    if (tip) tip.className = 'hourly-tooltip';
  }

  function formatTooltipTime(minutes) {
    if (minutes <= 0) return '0 分钟';
    if (minutes < 60) return minutes + ' 分钟';
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return h + '小时' + (m > 0 ? m + '分钟' : '');
  }

  // ===== 任务汇总悬浮 tooltip =====
  function showTagTooltip(e) {
    var el = e.target.closest('[data-tip]');
    if (!el) return;
    var tip = document.getElementById('tagTooltip');
    if (!tip) return;
    tip.innerHTML = el.dataset.tip;
    tip.className = 'tag-tooltip visible';

    var rect = el.getBoundingClientRect();
    var tipW = tip.offsetWidth;
    var tipH = tip.offsetHeight;
    var left = rect.left + rect.width / 2 - tipW / 2;
    var top = rect.top - tipH - 8;
    if (left < 6) left = 6;
    if (left + tipW > window.innerWidth - 6) left = window.innerWidth - tipW - 6;
    if (top < 6) top = rect.bottom + 8;

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTagTooltip(e) {
    var tip = document.getElementById('tagTooltip');
    if (tip) tip.className = 'tag-tooltip';
  }

  function showHourlyTooltip(e) {
    var bar = e.target;
    var hour = parseInt(bar.dataset.hour, 10);
    var minutes = parseInt(bar.dataset.minutes, 10);
    var tip = document.getElementById('hourlyTooltip');
    if (!tip) return;

    var startH = String(hour).padStart(2, '0');
    var endH = String((hour + 1) % 24).padStart(2, '0');
    tip.innerHTML = startH + ':00 - ' + endH + ':00<br>' + formatTooltipTime(minutes);
    tip.className = 'hourly-tooltip visible';

    var rect = bar.getBoundingClientRect();
    var tipW = tip.offsetWidth;
    var tipH = tip.offsetHeight;
    var left = rect.left + rect.width / 2 - tipW / 2;
    var top = rect.top - tipH - 6;
    if (left < 4) left = 4;
    if (left + tipW > window.innerWidth - 4) left = window.innerWidth - tipW - 4;
    if (top < 4) top = rect.bottom + 6;

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideHourlyTooltip() {
    var tip = document.getElementById('hourlyTooltip');
    if (tip) tip.className = 'hourly-tooltip';
  }

  function formatSummaryTime(totalSeconds) {
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    var parts = [];
    if (h > 0) parts.push(h + 'h');
    if (m > 0) parts.push(m + 'm');
    if (s > 0 || parts.length === 0) parts.push(s + 's');
    return parts.join(' ');
  }

  function renderSummary(totalSeconds, tagCount, topTag, topTagSeconds, prevPeriodSeconds) {
    var timeEl = document.getElementById('summaryTotalTime');
    var countEl = document.getElementById('summaryTagCount');
    var topTagEl = document.getElementById('summaryTopTag');
    var topTagLabelEl = document.getElementById('summaryTopTagLabel');
    var compareEl = document.getElementById('summaryCompare');
    var compareCard = document.getElementById('summaryCompareCard');
    var compareIcon = document.getElementById('summaryCompareIcon');

    if (timeEl) timeEl.textContent = formatSummaryTime(totalSeconds);
    if (countEl) countEl.textContent = String(tagCount);

    // 最长专注标签
    if (topTagEl && topTagLabelEl) {
      if (topTag && topTagSeconds > 0) {
        topTagEl.textContent = topTag;
        topTagLabelEl.textContent = '最长任务 · ' + formatSummaryTime(topTagSeconds);
      } else {
        topTagEl.textContent = '-';
        topTagLabelEl.textContent = '最长任务';
      }
    }

    // 较上一周期对比
    if (compareEl && compareCard) {
      // 重置类名
      compareCard.className = 'summary-card card-compare';
      compareEl.className = 'summary-card-value';

      if (prevPeriodSeconds >= 0) {
        var diff = totalSeconds - prevPeriodSeconds;
        if (diff > 0) {
          compareEl.textContent = '↑ ' + formatSummaryTime(diff);
          compareCard.classList.add('compare-up');
          if (compareIcon) compareIcon.textContent = '🚀';
        } else if (diff < 0) {
          compareEl.textContent = '↓ ' + formatSummaryTime(-diff);
          compareCard.classList.add('compare-down');
          if (compareIcon) compareIcon.textContent = '📉';
        } else {
          compareEl.textContent = '持平';
          compareCard.classList.add('compare-flat');
          if (compareIcon) compareIcon.textContent = '➡';
        }
      } else {
        compareEl.textContent = '-';
        if (compareIcon) compareIcon.textContent = '📊';
      }
    }
  }

  function renderAll() {
    readRecordsFromFile().then(function (records) {
      if (!records || records.length === 0) {
        setEmpty();
        return;
      }

      // 历史记录使用全部数据（如果当前是历史视图）
      if (currentView === 'history') {
        renderHistory(records);
      }

      // 按当前周期筛选
      var filtered = filterByPeriod(records);

      // 即使筛选结果为空也要更新标签和导航
      updateLabel();
      updateNavButtons();

      if (filtered.length === 0) {
        // 如果当前是历史视图，不要覆盖已渲染的历史记录
        if (currentView !== 'history') {
          setEmpty();
        }
        return;
      }

      // 计算总时长（跨天按比例拆分）
      var range = getRange();
      var totalSeconds = 0;
      for (var i = 0; i < filtered.length; i++) {
        totalSeconds += getRecordSecondsInRange(filtered[i], range.startStr, range.endStr);
      }

      // 标签聚合（跨天按比例拆分）
      var tagMap = aggregateByTag(filtered, range.startStr, range.endStr);
      var uniqueTagCount = 0;
      var topTag = null;
      var topTagSeconds = 0;
      for (var k in tagMap) {
        if (tagMap.hasOwnProperty(k)) {
          uniqueTagCount++;
          if (tagMap[k].totalSeconds > topTagSeconds) {
            topTagSeconds = tagMap[k].totalSeconds;
            topTag = k;
          }
        }
      }

      // 上一周期数据对比（跨天按比例拆分）
      var prevRange = getPrevPeriodRange();
      var prevPeriodSeconds = -1; // -1 表示无数据
      if (records && records.length > 0) {
        prevPeriodSeconds = 0;
        for (var j = 0; j < records.length; j++) {
          prevPeriodSeconds += getRecordSecondsInRange(records[j], prevRange.startStr, prevRange.endStr);
        }
      }

      renderSummary(totalSeconds, uniqueTagCount, topTag, topTagSeconds, prevPeriodSeconds);

      // 标签汇总
      renderTagSummary(tagMap, totalSeconds / 3600);

      // 时段分布柱状图
      var hourSlots = calcHourlyDistribution(filtered);
      renderHourlyChart(hourSlots, getPeriodYMax());

      // 活跃日段/月段（周/月/年）
      if (period !== 'day') {
        var active = calcActiveDistribution(filtered);
        renderActiveDayChart(active.bars, ACTIVE_YMAX[period] || 1440, active.labels);
      }
    }).catch(function () {
      tagSummary.innerHTML = '<div class="chart-loading">读取数据失败</div>';
    });
  }

  /* ========== 历史记录 ========== */

  // 已渲染年份缓存 — 同年内切换日期无需重新渲染历史
  var historyYearCache = null;

  // 格式化日期时间： "2026-06-07 14:30:00" → "2026年6月7日14：30：00"
  function formatDateTime(dt) {
    if (!dt) return '';
    var parts = dt.split(' ');
    var datePart = parts[0];
    var timePart = parts[1] || '00:00';
    var dateParts = datePart.split('-');
    var y = parseInt(dateParts[0], 10);
    var m = parseInt(dateParts[1], 10);
    var d = parseInt(dateParts[2], 10);
    var timeParts = timePart.split(':');
    var h = timeParts[0];
    var min = timeParts[1];
    var s = timeParts[2] || '00';
    return y + '年' + m + '月' + d + '日' + h + '：' + min + '：' + s;
  }

  // 格式化时长为中文： "01:15:00" → "1小时15分0秒"
  function formatDurationChinese(dur) {
    if (!dur) return '0秒';
    var parts = String(dur).split(':');
    if (parts.length !== 3) return dur;
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var s = parseInt(parts[2], 10);
    var result = '';
    if (h > 0) result += h + '小时';
    if (m > 0) result += m + '分';
    result += s + '秒';
    return result;
  }

  // 估算文本显示宽度（全角字符 ≈ 1.0，半角 ≈ 0.55），用于快速计算字号
  function estTextWidth(str) {
    var w = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      // CJK 统一表意文字、全角标点、全角字母数字
      if ((c >= 0x4E00 && c <= 0x9FFF) ||
          (c >= 0x3000 && c <= 0x303F) ||
          (c >= 0xFF00 && c <= 0xFFEF) ||
          (c >= 0x2000 && c <= 0x206F) ||
          (c >= 0x2F00 && c <= 0x2FDF) ||
          (c >= 0x2FF0 && c <= 0x2FFF) ||
          c > 0x7E) {
        w += 1.0;
      } else {
        w += 0.55;
      }
    }
    return w;
  }

  // 根据内容长度计算合适的字号（避免 DOM 重排）
  // containerWidth: 可用像素宽度, 返回 px 值
  function calcItemFontSize(plainText, containerWidth) {
    if (containerWidth <= 0) return 12;
    var estW = estTextWidth(plainText);
    if (estW <= 0) return 12;
    var size = Math.round((containerWidth / estW) * 10) / 10;
    return Math.max(9, Math.min(13, size));
  }

  function escapeHTML(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ========== 自定义弹窗 ========== */
  function showConfirm(message, icon) {
    return new Promise(function (resolve) {
      var overlay = document.getElementById('modalOverlay');
      var modalIcon = document.getElementById('modalIcon');
      var modalMessage = document.getElementById('modalMessage');
      var modalButtons = document.getElementById('modalButtons');

      modalIcon.textContent = icon || '💡';
      modalMessage.textContent = message;
      modalButtons.innerHTML =
        '<button class="modal-btn modal-btn-primary" id="modalConfirmBtn">确定</button>' +
        '<button class="modal-btn modal-btn-secondary" id="modalCancelBtn">取消</button>';
      overlay.classList.add('active');

      var confirmBtn = document.getElementById('modalConfirmBtn');
      var cancelBtn = document.getElementById('modalCancelBtn');

      function cleanup() {
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
      }

      function onConfirm() {
        overlay.classList.remove('active');
        cleanup();
        resolve(true);
      }

      function onCancel() {
        overlay.classList.remove('active');
        cleanup();
        resolve(false);
      }

      function onKey(e) {
        if (e.key === 'Enter') {
          e.stopPropagation();
          onConfirm();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      confirmBtn.focus();
    });
  }

  /* ========== 删除记录 ========== */
  async function deleteRecordByStartTime(startTime) {
    var records = await readRecordsFromFile();
    var deleted = false;
    for (var i = 0; i < records.length; i++) {
      if (records[i].startTime === startTime) {
        records.splice(i, 1);
        deleted = true;
        break;
      }
    }
    if (deleted) {
      await api.writeRecords(records);
      // 失效历史缓存，下次渲染时重建
      historyYearCache = null;
      renderAll();
    }
  }

  function renderHistory(allRecords) {
    // 年份缓存：同年内切换日期不重复渲染
    var year = cursorDate.getFullYear();
    if (year === historyYearCache && historyList.children.length > 0) {
      return;
    }

    historyList.innerHTML = '';

    if (!allRecords || allRecords.length === 0) {
      historyList.innerHTML = '<div class="history-empty">暂无数据</div>';
      historyYearCache = null;
      return;
    }

    // 筛选本年的记录
    var yearPrefix = String(year) + '-';
    var yearRecords = [];
    for (var i = 0; i < allRecords.length; i++) {
      var r = allRecords[i];
      var timeStr = r.startTime || r.endTime;
      if (timeStr && timeStr.indexOf(yearPrefix) === 0) {
        yearRecords.push(r);
      }
    }

    if (yearRecords.length === 0) {
      historyList.innerHTML = '<div class="history-empty">' + year + '年暂无记录</div>';
      historyYearCache = year;
      return;
    }

    // 按 startTime 倒序（最新的在前）
    yearRecords.sort(function (a, b) {
      var t1 = a.startTime || a.endTime || '';
      var t2 = b.startTime || b.endTime || '';
      if (t1 > t2) return -1;
      if (t1 < t2) return 1;
      return 0;
    });

    // 估算容器可用宽度（卡片 600px - 左右 padding 56*2 - 滚动条 ~8px - 内边距 ~20px）
    var containerWidth = historyList.clientWidth;
    if (containerWidth <= 0) containerWidth = 480;

    // 一次性拼接全部 HTML，只触发一次 DOM 操作
    var htmlParts = [];
    for (var k = 0; k < yearRecords.length; k++) {
      var rec = yearRecords[k];
      var tag = rec.tag || '无标签';
      var startFormatted = formatDateTime(rec.startTime);
      var isIncomplete = (rec.isComplete === '否' || !rec.endTime);

      if (isIncomplete) {
        // 判断是否异常残留：该未完成记录之后出现了新的正常记录
        // 记录按 startTime 降序排列（最新在前），检查是否有位置更靠前（startTime 更新）的正常记录
        var isAbnormal = false;
        for (var j = 0; j < k; j++) {
          if (yearRecords[j].isComplete !== '否' && yearRecords[j].endTime) {
            isAbnormal = true;
            break;
          }
        }
        var statusHTML, statusClass;
        if (isAbnormal) {
          statusHTML = '⚠ 异常未完成';
          statusClass = 'hc-status-abnormal';
        } else {
          statusHTML = '进行中...';
          statusClass = 'hc-status-ongoing';
        }

        htmlParts.push(
          '<div class="history-card">' +
          '<div class="hc-header">' +
          '<span class="hc-tag">' + escapeHTML(tag) + '</span>' +
          '<button class="hc-delete" data-starttime="' + escapeHTML(rec.startTime || '') + '">×</button>' +
          '</div>' +
          '<div class="hc-duration ' + statusClass + '">' + statusHTML + '</div>' +
          '<div class="hc-times">' +
          '<div class="hc-time-row">▶ ' + startFormatted + '</div>' +
          '</div>' +
          '</div>'
        );
      } else {
        var endFormatted = formatDateTime(rec.endTime);
        var durChinese = formatDurationChinese(rec.duration);

        htmlParts.push(
          '<div class="history-card">' +
          '<div class="hc-header">' +
          '<span class="hc-tag">' + escapeHTML(tag) + '</span>' +
          '<button class="hc-delete" data-starttime="' + escapeHTML(rec.startTime || '') + '">×</button>' +
          '</div>' +
          '<div class="hc-duration">⏱ ' + durChinese + '</div>' +
          '<div class="hc-times">' +
          '<div class="hc-time-row">▶ ' + startFormatted + '</div>' +
          '<div class="hc-time-row">■ ' + endFormatted + '</div>' +
          '</div>' +
          '</div>'
        );
      }
    }

    historyList.innerHTML = htmlParts.join('');
    historyYearCache = year;
  }

  function setEmpty() {
    renderSummary(0, 0, null, 0, -1);
    tagSummary.innerHTML = '<div class="chart-loading">暂无数据</div>';
    hourlyChart.innerHTML = '<div class="chart-loading">暂无数据</div>';
    if (activeChart) activeChart.innerHTML = '<div class="chart-loading">暂无数据</div>';
    if (historyList) historyList.innerHTML = '<div class="history-empty">暂无数据</div>';
    historyYearCache = null;
  }

  function switchToView(newView) {
    if (newView === currentView) return;
    currentView = newView;

    // 更新视图标签 active
    var tabs = viewTabs.querySelectorAll('.period-tab');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      t.classList.toggle('active', t.dataset.view === newView);
    }

    viewSummary.style.display = newView === 'summary' ? '' : 'none';
    viewTag.style.display = newView === 'tag' ? '' : 'none';
    viewActive.style.display = newView === 'active' ? '' : 'none';
    viewChart.style.display = newView === 'chart' ? '' : 'none';
    viewHistory.style.display = newView === 'history' ? '' : 'none';

    // 切换到历史记录时重新渲染
    if (newView === 'history') {
      renderAll();
    }
  }

  /* ========== 事件绑定 ========== */

  // 周期标签点击
  periodTabs.addEventListener('click', function (e) {
    var tab = e.target.closest('.period-tab');
    if (!tab) return;
    var newPeriod = tab.dataset.period;
    if (!newPeriod || newPeriod === period) return;

    // 更新 active
    var tabs = periodTabs.querySelectorAll('.period-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.remove('active');
    }
    tab.classList.add('active');

    switchPeriod(newPeriod);
  });

  // 视图标签点击
  viewTabs.addEventListener('click', function (e) {
    var tab = e.target.closest('.period-tab');
    if (!tab) return;
    var newView = tab.dataset.view;
    if (!newView) return;
    switchToView(newView);
  });

  // 导航按钮
  periodPrev.addEventListener('click', navigatePrev);
  periodNext.addEventListener('click', navigateNext);

  // 历史记录删除按钮（事件委托）
  historyList.addEventListener('click', async function (e) {
    var btn = e.target.closest('.hc-delete');
    if (!btn) return;
    e.stopPropagation();
    var startTime = btn.dataset.starttime;
    if (!startTime) return;
    var confirmed = await showConfirm('确定要删除这条计时记录吗？\n\n此操作不可撤销。', '🗑️');
    if (confirmed) {
      await deleteRecordByStartTime(startTime);
    }
  });

  /* ========== 初始化 ========== */
  // 初始标签和按钮状态
  updateLabel();
  updateNavButtons();
  updateSummaryLabels();

  var lastRawText = null;
  var isRefreshing = false;

  async function refreshIfChanged() {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      var raw = await api.readFileRaw();
      if (raw !== lastRawText) {
        lastRawText = raw;
        renderAll();
      }
    } catch (e) {
      // 静默忽略刷新错误
    }
    isRefreshing = false;
  }

  (async function init() {
    var filePath = await api.getFilePath();
    if (filePath) {
      // 首次加载时缓存原始文本
      var raw = await api.readFileRaw();
      if (raw !== null) lastRawText = raw;
      renderAll();
    }
    // 每 5 秒检查数据文件是否变化
    setInterval(refreshIfChanged, 5000);
  })();

  // ========== Navigation via Electron IPC ==========
  var backBtn = document.querySelector('.back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', function (e) {
      e.preventDefault();
      api.goTo('mainpage');
    });
  }

})();
