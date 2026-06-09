(function () {
  var container = document.getElementById('heatmapContainer');
  var yearLabel = document.getElementById('yearLabel');
  var yearPrev = document.getElementById('yearPrev');
  var yearNext = document.getElementById('yearNext');

  /* ========== 常量 ========== */
  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  var MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  var MIN_YEAR = 2026;
  var MAX_YEAR = 2032;

  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var TODAY_STR = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');

  var currentYear = today.getFullYear();

  /* ========== 数据缓存：加载一次，多次使用 ========== */
  var dataCache = {
    ready: false,           // 是否已就绪
    daySecondsMap: {},      // { dateStr -> totalSeconds }
    thresholds: [1800, 5400, 10800],  // 五档阈值（秒）
    dayLevels: {},          // { dateStr -> level 0-4 }
    // 按年份缓存排行榜和热力图数据，避免切换年份时重算
    yearCaches: {}          // { year: { yearData, monthRank, weekRank, dayRank } }
  };

  /* ========== 工具函数 ========== */
  function dateStr(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  // 优化版：用 charCode 直接解析 HH:MM:SS，避免 split+parseInt 开数组
  function parseDuration(dur) {
    if (!dur) return 0;
    var s = dur;
    if (typeof s !== 'string') s = String(s);
    // 格式固定 "HH:MM:SS"，长度 >= 8
    if (s.length < 8) return 0;
    var hh = (s.charCodeAt(0) - 48) * 10 + (s.charCodeAt(1) - 48);
    var mm = (s.charCodeAt(3) - 48) * 10 + (s.charCodeAt(4) - 48);
    var ss = (s.charCodeAt(6) - 48) * 10 + (s.charCodeAt(7) - 48);
    return hh * 3600 + mm * 60 + ss;
  }

  /* ========== 数据处理：records → daySecondsMap（单次 O(n)） ========== */
  function processRecords(records) {
    var map = {};
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var timeStr = r.startTime || r.endTime;
      if (!timeStr) continue;
      // 日期在字符串前10位 "YYYY-MM-DD"
      var dateKey = timeStr.substring(0, 10);
      var sec = parseDuration(r.duration);
      if (map[dateKey] === undefined) {
        map[dateKey] = sec;
      } else {
        map[dateKey] += sec;
      }
    }
    return map;
  }

  /* ========== 计算阈值（仅加载数据时调用一次） ========== */
  function calcThresholds(map) {
    var nonZero = [];
    for (var key in map) {
      if (map.hasOwnProperty(key)) {
        var v = map[key];
        if (v > 0) nonZero.push(v);
      }
    }
    if (nonZero.length < 4) {
      return [1800, 5400, 10800]; // 固定：30min, 90min, 3h
    }
    nonZero.sort(function (a, b) { return a - b; });
    var n = nonZero.length;
    return [
      nonZero[Math.floor(n * 0.25)],
      nonZero[Math.floor(n * 0.5)],
      nonZero[Math.floor(n * 0.75)]
    ];
  }

  function calcLevel(seconds, thresholds) {
    if (seconds <= 0) return 0;
    if (seconds <= thresholds[0]) return 1;
    if (seconds <= thresholds[1]) return 2;
    if (seconds <= thresholds[2]) return 3;
    return 4;
  }

  /* ========== 预计算某年份所有日期到 weekIndex 的映射 ========== */
  function buildYearMeta(year) {
    var yearStart = new Date(year, 0, 1);
    var yearEnd = new Date(year, 11, 31);

    var firstDay = new Date(yearStart);
    firstDay.setDate(firstDay.getDate() - firstDay.getDay());

    var endDate = new Date(yearEnd);
    endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));

    var yearTotal = Math.round((yearEnd - yearStart) / 86400000) + 1;

    // yearDateSet 用于判断 visible
    var yearDateSet = {};
    var c = new Date(yearStart);
    while (c <= yearEnd) {
      yearDateSet[dateStr(c.getFullYear(), c.getMonth(), c.getDate())] = true;
      c.setDate(c.getDate() + 1);
    }

    // 遍历网格，同时收集：weeks, monthPositions, 每日期对应的 weekIndex
    var days = [];
    var cursor = new Date(firstDay);
    while (cursor <= endDate) {
      var y = cursor.getFullYear();
      var m = cursor.getMonth();
      var d = cursor.getDate();
      var ds = dateStr(y, m, d);
      var visible = !!yearDateSet[ds];
      days.push({
        date: ds,
        level: visible ? (dataCache.dayLevels[ds] !== undefined ? dataCache.dayLevels[ds] : 0) : -1,
        dayOfWeek: cursor.getDay(),
        isToday: ds === TODAY_STR
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    var weeks = [];
    for (var i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7));
    }

    var monthPositions = [];
    for (var w = 0; w < weeks.length; w++) {
      var week = weeks[w];
      for (var dd = 0; dd < week.length; dd++) {
        var day = week[dd];
        if (day.level === -1) continue;
        var mIdx = parseInt(day.date.substring(5, 7), 10) - 1;
        var already = false;
        for (var mp = 0; mp < monthPositions.length; mp++) {
          if (monthPositions[mp].month === mIdx) { already = true; break; }
        }
        if (!already) {
          monthPositions.push({ month: mIdx, col: w });
        }
      }
    }

    return {
      yearTotal: yearTotal,
      weeks: weeks,
      monthPositions: monthPositions
    };
  }

  /* ========== 预计算某年份排行榜（仅加载数据时调用一次） ========== */

  // 月份排行
  function buildMonthRanking(year) {
    var months = [];
    for (var m = 0; m < 12; m++) {
      months.push({ name: MONTHS[m], hours: 0, hasData: false });
    }

    var map = dataCache.daySecondsMap;
    var yStr = String(year);

    for (var key in map) {
      if (!map.hasOwnProperty(key)) continue;
      if (key.substring(0, 4) !== yStr) continue;
      var mIdx = parseInt(key.substring(5, 7), 10) - 1;
      months[mIdx].hours += map[key];
      months[mIdx].hasData = true;
    }

    for (var i = 0; i < 12; i++) {
      months[i].hours = Math.round(months[i].hours / 36) / 100;
    }

    months.sort(function (a, b) {
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      return b.hours - a.hours;
    });

    return months;
  }

  // 周活跃：使用热力图周列分组，count 为显示条数
  function buildWeekRanking(year, weeks, count) {
    var map = dataCache.daySecondsMap;
    var list = [];
    for (var w = 0; w < weeks.length; w++) {
      var totalSec = 0;
      var week = weeks[w];
      for (var d = 0; d < week.length; d++) {
        var dateKey = week[d].date;
        if (map[dateKey]) totalSec += map[dateKey];
      }
      var hours = Math.round(totalSec / 36) / 100;
      list.push({ name: '第' + (w + 1) + '周', hours: hours, hasData: totalSec > 0 });
    }

    list.sort(function (a, b) {
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      return b.hours - a.hours;
    });

    var result = list.slice(0, count);
    while (result.length < count) {
      result.push({ name: '待统计', hours: 0, hasData: false });
    }
    return result;
  }

  // 日活跃：count 为显示条数
  function buildDayRanking(year, count) {
    var map = dataCache.daySecondsMap;
    var monthsInYear = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var list = [];

    for (var m = 0; m < 12; m++) {
      var mm = String(m + 1).padStart(2, '0');
      var daysInMonth = monthsInYear[m];
      for (var d = 1; d <= daysInMonth; d++) {
        var dd = String(d).padStart(2, '0');
        var key = year + '-' + mm + '-' + dd;
        var sec = map[key] || 0;
        var hours = Math.round(sec / 36) / 100;
        list.push({ name: (m + 1) + '/' + d, hours: hours, hasData: sec > 0 });
      }
    }

    var topN = partialTop(list, count, function (a, b) {
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      return b.hours - a.hours;
    });

    while (topN.length < count) {
      topN.push({ name: '待统计', hours: 0, hasData: false });
    }
    return topN;
  }

  // 动态确定排行条数：宽屏 12 条，窄屏（排行堆叠）6 条
  function getRankCount() {
    return window.innerWidth <= 480 ? 6 : 12;
  }

  // 部分排序：从数组中选出 top N 个元素（O(n*k)，k=12 远小于 n=366）
  function partialTop(arr, n, cmp) {
    // 前三轮完整排序选出前三个，后面用线性扫描
    // 对于 k=12, n=366，直接用原生的 sort 更快（引擎内部用 Timsort）
    var copy = arr.slice();
    copy.sort(cmp);
    return copy.slice(0, n);
  }

  /* ========== 桌面端固定热力图尺寸 ========== */
  function calcCellSize() {
    return {
      cellSize: 13,
      gap: 3,
      labelWidth: 28,
      monthFontSize: 11,
      weekdayFontSize: 10
    };
  }

  /* ========== 构建热力图 DOM ========== */
  function buildHeatmap(yearData, sizes) {
    var weeks = yearData.weeks;
    var monthPositions = yearData.monthPositions;
    var totalWeeks = weeks.length;
    var cs = sizes.cellSize;
    var gap = sizes.gap;
    var labelW = sizes.labelWidth;

    container.innerHTML = '';
    container.style.setProperty('--cell-size', cs + 'px');
    container.style.setProperty('--cell-gap', gap + 'px');
    container.style.setProperty('--label-width', labelW + 'px');
    container.style.setProperty('--month-font', sizes.monthFontSize + 'px');
    container.style.setProperty('--weekday-font', sizes.weekdayFontSize + 'px');

    var monthRow = document.createElement('div');
    monthRow.className = 'heatmap-month-row';
    monthRow.style.height = (sizes.monthFontSize + 4) + 'px';
    monthRow.style.width = (labelW + totalWeeks * (cs + gap)) + 'px';

    monthPositions.forEach(function (mp) {
      var label = document.createElement('span');
      label.className = 'heatmap-month-label';
      label.textContent = MONTHS[mp.month];
      label.style.left = (labelW + gap + mp.col * (cs + gap)) + 'px';
      monthRow.appendChild(label);
    });
    container.appendChild(monthRow);

    var body = document.createElement('div');
    body.className = 'heatmap-body';

    var dayCol = document.createElement('div');
    dayCol.className = 'heatmap-weekday-col';
    WEEKDAYS.forEach(function (label, idx) {
      var lbl = document.createElement('span');
      lbl.className = 'heatmap-weekday-label';
      lbl.textContent = idx % 2 === 1 ? label : '';
      dayCol.appendChild(lbl);
    });
    body.appendChild(dayCol);

    weeks.forEach(function (week) {
      var col = document.createElement('div');
      col.className = 'heatmap-week';
      week.forEach(function (day) {
        var cell = document.createElement('div');
        if (day.level >= 0) {
          var cls = 'heatmap-day level-' + day.level;
          if (day.isToday) cls += ' today';
          cell.className = cls;
          cell.dataset.date = day.date;
          cell.addEventListener('mouseenter', showTooltip);
          cell.addEventListener('mouseleave', hideTooltip);
        } else {
          cell.className = 'heatmap-day level-0';
          cell.style.visibility = 'hidden';
        }
        col.appendChild(cell);
      });
      body.appendChild(col);
    });
    container.appendChild(body);

    if (!document.getElementById('heatmapTooltip')) {
      var tip = document.createElement('div');
      tip.className = 'heatmap-tooltip';
      tip.id = 'heatmapTooltip';
      document.body.appendChild(tip);
    }
  }

  /* ========== Tooltip ========== */
  function formatDurationText(totalSeconds) {
    if (totalSeconds <= 0) return '暂无数据';
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    if (h > 0) return h + '小时' + m + '分钟';
    if (m > 0) return m + '分钟' + s + '秒';
    return s + '秒';
  }

  function showTooltip(e) {
    var cell = e.target;
    var date = cell.dataset.date;
    if (!date) return;

    var parts = date.split('-');
    var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    var weekday = '星期' + WEEKDAYS[d.getDay()];

    var sec = dataCache.daySecondsMap[date] || 0;
    var durationText = formatDurationText(sec);

    var tip = document.getElementById('heatmapTooltip');
    if (!tip) return;
    tip.innerHTML = date + '<br>' + weekday + '<br>' + durationText;
    tip.className = 'heatmap-tooltip visible';

    var rect = cell.getBoundingClientRect();
    var tipW = tip.offsetWidth;
    var tipH = tip.offsetHeight;

    var left = rect.left + rect.width / 2 - tipW / 2;
    var top = rect.bottom + 6;

    if (left < 4) left = 4;
    if (left + tipW > window.innerWidth - 4) left = window.innerWidth - tipW - 4;

    if (top + tipH > window.innerHeight - 4) {
      top = rect.top - tipH - 6;
    }

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTooltip() {
    var tip = document.getElementById('heatmapTooltip');
    if (tip) tip.className = 'heatmap-tooltip';
  }

  /* ========== 排行榜 DOM ========== */
  var rankMonth = document.getElementById('rankMonth');
  var rankWeek = document.getElementById('rankWeek');
  var rankDay = document.getElementById('rankDay');

  /* ========== 排行榜渲染 ========== */
  function renderRankSection(container, data, maxHours) {
    container.innerHTML = '';
    for (var i = 0; i < data.length; i++) {
      var item = data[i];
      var pct = maxHours > 0 ? (item.hours / maxHours * 100) : 0;

      var row = document.createElement('div');
      row.className = 'rank-item';

      var num = document.createElement('span');
      num.className = 'rank-num' + (i < 3 && item.hasData ? ' top3' : '');
      num.textContent = (i + 1);

      var name = document.createElement('span');
      name.className = 'rank-name';
      name.textContent = item.name;
      name.title = item.name;

      var track = document.createElement('div');
      track.className = 'rank-bar-track';

      var fill = document.createElement('div');
      fill.className = 'rank-bar-fill';
      fill.style.width = Math.max(pct, item.hasData ? 3 : 0) + '%';

      var val = document.createElement('span');
      val.className = 'rank-value';
      val.textContent = item.hasData ? (item.hours + 'h') : '0h';

      track.appendChild(fill);
      row.appendChild(num);
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(val);
      container.appendChild(row);
    }
  }

  function renderRankings(yearCache) {
    var monthData = yearCache.monthRank;
    var weekData = yearCache.weekRank;
    var dayData = yearCache.dayRank;

    var monthMax = 0, weekMax = 0, dayMax = 0;
    for (var i = 0; i < monthData.length; i++) {
      if (monthData[i].hours > monthMax) monthMax = monthData[i].hours;
    }
    for (var j = 0; j < weekData.length; j++) {
      if (weekData[j].hours > weekMax) weekMax = weekData[j].hours;
    }
    for (var k = 0; k < dayData.length; k++) {
      if (dayData[k].hours > dayMax) dayMax = dayData[k].hours;
    }

    renderRankSection(rankMonth, monthData, monthMax);
    renderRankSection(rankWeek, weekData, weekMax);
    renderRankSection(rankDay, dayData, dayMax);
  }

  /* ========== 确保某年份的缓存就绪 ========== */
  function ensureYearCache(year) {
    if (!dataCache.yearCaches[year]) {
      var yearData = buildYearMeta(year);
      var count = getRankCount();
      dataCache.yearCaches[year] = {
        yearData: yearData,
        monthRank: buildMonthRanking(year),
        weekRank: buildWeekRanking(year, yearData.weeks, count),
        dayRank: buildDayRanking(year, count)
      };
    }
    return dataCache.yearCaches[year];
  }

  /* ========== Electron IPC 数据存储 ========== */
  var api = window.electronAPI;

  async function readRecordsFromFile() {
    return await api.readRecords();
  }

  /* ========== 数据加载：一次处理，全部缓存 ========== */
  async function loadAndBuildCache() {
    var records = await readRecordsFromFile();

    // Step 1: 聚合每日秒数（一次 O(n) 遍历）
    var daySecondsMap = processRecords(records);

    // Step 2: 计算阈值
    var thresholds = calcThresholds(daySecondsMap);

    // Step 3: 预计算 dayLevels
    var dayLevels = {};
    for (var key in daySecondsMap) {
      if (daySecondsMap.hasOwnProperty(key)) {
        dayLevels[key] = calcLevel(daySecondsMap[key], thresholds);
      }
    }

    // Step 4: 写入全局缓存，清空年份缓存（数据已变）
    dataCache.daySecondsMap = daySecondsMap;
    dataCache.thresholds = thresholds;
    dataCache.dayLevels = dayLevels;
    dataCache.yearCaches = {};
    dataCache.ready = true;

    // Step 5: 预计算当前年份的缓存
    ensureYearCache(currentYear);

    // Step 6: 渲染
    render(currentYear);
  }

  /* ========== 渲染入口（仅重建 DOM，不重算数据） ========== */
  function render(year) {
    if (!dataCache.ready) {
      // 首次加载前数据未就绪，仍尝试渲染空状态
    }

    var cache = ensureYearCache(year);

    var sizes = calcCellSize();
    buildHeatmap(cache.yearData, sizes);
    yearLabel.textContent = year;

    yearPrev.classList.toggle('disabled', year <= MIN_YEAR);
    yearNext.classList.toggle('disabled', year >= MAX_YEAR);

    renderRankings(cache);
  }

  /* ========== 年份切换 ========== */
  yearPrev.addEventListener('click', function () {
    if (currentYear <= MIN_YEAR) return;
    currentYear--;
    render(currentYear);
  });

  yearNext.addEventListener('click', function () {
    if (currentYear >= MAX_YEAR) return;
    currentYear++;
    render(currentYear);
  });

  /* ========== 初始化 ========== */
  var lastRawText = null;
  var isRefreshing = false;

  async function refreshIfChanged() {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      var raw = await api.readFileRaw();
      if (raw !== lastRawText) {
        lastRawText = raw;
        await loadAndBuildCache();
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
      await loadAndBuildCache();
    } else {
      dataCache.ready = true;
      render(currentYear);
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
