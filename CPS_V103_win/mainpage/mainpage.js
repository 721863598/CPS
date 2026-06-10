(function () {
  /* ========== DOM 引用 ========== */
  var timeDisplay = document.querySelector('.time');
  var timeLabel   = document.querySelector('.time-label');
  var progress24h = document.getElementById('progress24h');
  var progress1h  = document.getElementById('progress1h');
  var progress1m  = document.getElementById('progress1m');
  var btnStart    = document.querySelector('.btn-start');
  var btnEnd      = document.querySelector('.btn-end');
  var btnReset    = document.querySelector('.btn-reset');
  var tag         = document.querySelector('.tag');
  var tagText     = document.querySelector('.tag-text');
  var card        = document.querySelector('.card');

  /* ========== 常量 ========== */
  var MAX_SECONDS = 23 * 3600 + 59 * 60 + 59; // 86399

  // 各环 SVG 圆周长
  var C24H = 2 * Math.PI * 185;   // ≈ 1162.39
  var C1H  = 2 * Math.PI * 165;   // ≈ 1036.73
  var C1M  = 2 * Math.PI * 145;   // ≈ 911.06

  /* ========== 状态 ========== */
  var totalSeconds = 0;
  var timerInterval = null;
  var isRunning = false;
  var state = 'idle'; // idle | running | paused | ended
  var autoEndTimeout = null; // 暂停超过30分钟自动结束的定时器
  var currentSessionStartTime = null; // 当前会话的开始时间，用于匹配结束记录

  /* ========== 工具函数 ========== */
  function formatTime(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    return (
      String(h).padStart(2, '0') + ':' +
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0')
    );
  }

  function setProgress(circle, circumference, filled, total) {
    var len = (filled / total) * circumference;
    circle.setAttribute('stroke-dasharray', len + ' ' + circumference);
  }

  function updateRings(seconds) {
    // 内环 1min：当前秒数（0-59）
    var s = seconds % 60;
    setProgress(progress1m, C1M, s, 60);

    // 中环 1h：当前分钟数（0-59）
    var m = Math.floor((seconds % 3600) / 60);
    setProgress(progress1h, C1H, m, 60);

    // 外环 24h：当前小时数（0-23）
    var h = Math.floor(seconds / 3600);
    setProgress(progress24h, C24H, h, 24);
  }

  /* ========== 数据存储（Electron IPC） ========== */
  var api = window.electronAPI;

  async function readRecordsFromFile() {
    return await api.readRecords();
  }

  async function writeRecordsToFile(records) {
    await api.writeRecords(records);
  }

  var pad2 = function (n) { return String(n).padStart(2, '0'); };

  // 格式化日期时间：年月日 时分（不含秒，用于开始/结束记录）
  function formatDateTimeShort(d) {
    return d.getFullYear() + '-' +
      pad2(d.getMonth() + 1) + '-' +
      pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' +
      pad2(d.getMinutes()) + ':' +
      pad2(d.getSeconds());
  }

  // 格式化时长：HH:MM:SS
  function formatDuration(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  function getTagValue() {
    var val = tagText.textContent;
    if (val === '输入标签') val = '';
    return val || '无标签';
  }

  // 必填字段列表
  var REQUIRED_FIELDS = ['isComplete', 'tag', 'startTime', 'endTime', 'duration'];

  // 校验单条记录五个字段是否齐全
  function isRecordComplete(record) {
    for (var i = 0; i < REQUIRED_FIELDS.length; i++) {
      var key = REQUIRED_FIELDS[i];
      if (record[key] === undefined || record[key] === null || record[key] === '') {
        return false;
      }
    }
    return true;
  }

  // 校验并修正所有记录的 isComplete 字段
  async function validateRecords() {
    var records = await readRecordsFromFile();
    var changed = false;
    for (var i = 0; i < records.length; i++) {
      var shouldBe = isRecordComplete(records[i]) ? '是' : '否';
      if (records[i].isComplete !== shouldBe) {
        records[i].isComplete = shouldBe;
        changed = true;
      }
    }
    if (changed) {
      await writeRecordsToFile(records);
    }
  }

  // 写入开始记录：{ isComplete, tag, startTime }
  async function writeStartRecord() {
    currentSessionStartTime = formatDateTimeShort(new Date());
    var record = {
      isComplete: '否',
      tag: getTagValue(),
      startTime: currentSessionStartTime
    };
    var records = await readRecordsFromFile();
    records.unshift(record);
    await writeRecordsToFile(records);
  }

  // 合并结束信息到对应的开始记录（通过 startTime 精确匹配）
  async function writeEndRecord() {
    var records = await readRecordsFromFile();
    var endTime = formatDateTimeShort(new Date());
    var dur = formatDuration(totalSeconds);

    // 通过 currentSessionStartTime 精确匹配
    if (currentSessionStartTime) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].startTime === currentSessionStartTime) {
          records[i].endTime = endTime;
          records[i].duration = dur;
          records[i].isComplete = isRecordComplete(records[i]) ? '是' : '否';
          await writeRecordsToFile(records);
          currentSessionStartTime = null;
          return;
        }
      }
    }

    // 兜底：通过未结束标记查找
    for (var j = 0; j < records.length; j++) {
      if (records[j].startTime && !records[j].endTime) {
        records[j].endTime = endTime;
        records[j].duration = dur;
        records[j].isComplete = isRecordComplete(records[j]) ? '是' : '否';
        await writeRecordsToFile(records);
        return;
      }
    }

    // 最后兜底：创建独立结束记录
    var fallback = {
      isComplete: '否',
      tag: getTagValue(),
      endTime: endTime,
      duration: dur
    };
    fallback.isComplete = isRecordComplete(fallback) ? '是' : '否';
    records.unshift(fallback);
    await writeRecordsToFile(records);
  }

  function clearAutoEndTimeout() {
    if (autoEndTimeout) {
      clearTimeout(autoEndTimeout);
      autoEndTimeout = null;
    }
  }

  /* ========== 自定义弹窗 ========== */
  function showAlert(message, icon) {
    return new Promise(function (resolve) {
      var overlay = document.getElementById('modalOverlay');
      var modalIcon = document.getElementById('modalIcon');
      var modalMessage = document.getElementById('modalMessage');
      var modalButtons = document.getElementById('modalButtons');

      modalIcon.textContent = icon || '💡';
      modalMessage.textContent = message;
      modalButtons.innerHTML = '<button class="modal-btn modal-btn-primary" id="modalOkBtn">知道了</button>';
      overlay.classList.add('active');

      var okBtn = document.getElementById('modalOkBtn');

      function dismiss() {
        overlay.classList.remove('active');
        cleanup();
        resolve();
      }

      function cleanup() {
        okBtn.removeEventListener('click', dismiss);
        document.removeEventListener('keydown', onKey);
      }

      function onKey(e) {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.stopPropagation();
          dismiss();
        }
      }

      okBtn.addEventListener('click', dismiss);
      document.addEventListener('keydown', onKey);
      okBtn.focus();
    });
  }

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

  // 页面加载时自动连接数据文件
  (async function init() {
    var filePath = await api.getFilePath();
    if (filePath) {
      await validateRecords();
    }
    // 尝试恢复导航前的计时器状态
    await restoreTimerState();
  })();

  async function restoreTimerState() {
    var saved = await api.getTimerState();
    if (!saved) return;

    // 恢复标签
    if (saved.tag && saved.tag !== '无标签') {
      tagText.textContent = saved.tag;
    }

    // 恢复 currentSessionStartTime
    currentSessionStartTime = saved.currentSessionStartTime || null;

    if (saved.state === 'running') {
      // 计算离开期间经过的时间
      var elapsed = Math.floor((Date.now() - (saved.saveTimestamp || Date.now())) / 1000);
      totalSeconds = Math.min(saved.totalSeconds + elapsed, MAX_SECONDS);
      timeDisplay.textContent = formatTime(totalSeconds);
      updateRings(totalSeconds);
      state = 'running';
        isRunning = true;
      btnStart.textContent = '暂 停';
      timeLabel.textContent = '计时中';
      startTimer();
      if (totalSeconds >= MAX_SECONDS) {
        doEnd();
      }
    } else if (saved.state === 'paused') {
      totalSeconds = saved.totalSeconds;
      timeDisplay.textContent = formatTime(totalSeconds);
      updateRings(totalSeconds);
      state = 'paused';
        isRunning = false;
      btnStart.textContent = '开 始';
      timeLabel.textContent = '已暂停';
      // 检查暂停是否超过 30 分钟
      var pausedMs = Date.now() - (saved.saveTimestamp || Date.now());
      var remainingMs = Math.max(0, 30 * 60 * 1000 - pausedMs);
      if (remainingMs <= 0) {
        doEnd();
      } else {
        autoEndTimeout = setTimeout(function () {
          doEnd();
        }, remainingMs);
      }
    } else if (saved.state === 'ended') {
      totalSeconds = saved.totalSeconds;
      timeDisplay.textContent = formatTime(totalSeconds);
      updateRings(totalSeconds);
      state = 'ended';
        isRunning = false;
      btnStart.textContent = '开 始';
      timeLabel.textContent = '已结束';
    }
    // idle 状态无需恢复
  }

  /* ========== 计时逻辑 ========== */
  function startTimer() {
    timerInterval = setInterval(function () {
      if (totalSeconds < MAX_SECONDS) {
        totalSeconds++;
        timeDisplay.textContent = formatTime(totalSeconds);
        updateRings(totalSeconds);
      } else {
        doEnd();
      }
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  function doEnd() {
    stopTimer();
    isRunning = false;
    state = 'ended';
    btnStart.textContent = '开 始';
    timeLabel.textContent = '已结束';
    clearAutoEndTimeout();
    // 小于10秒的专注不记录
    if (totalSeconds >= 10) {
      writeEndRecord();
    } else {
      deleteStartRecord();
    }
  }

  // 结束但不写入记录（用于 <10s 的场景）
  function doEndWithoutRecord() {
    stopTimer();
    isRunning = false;
    state = 'ended';
    btnStart.textContent = '开 始';
    timeLabel.textContent = '已结束';
    clearAutoEndTimeout();
  }

  // 删除当前会话的开始记录（用于 <10s 的场景）
  async function deleteStartRecord() {
    if (currentSessionStartTime) {
      var records = await readRecordsFromFile();
      for (var i = 0; i < records.length; i++) {
        if (records[i].startTime === currentSessionStartTime && !records[i].endTime) {
          records.splice(i, 1);
          await writeRecordsToFile(records);
          break;
        }
      }
    }
    currentSessionStartTime = null;
  }

  function doReset() {
    stopTimer();
    isRunning = false;
    clearAutoEndTimeout();
    // 如果有正在计时或暂停的计时，>=10s 则写入记录，<10s 则删除开始记录
    if (state === 'running' || state === 'paused') {
      if (totalSeconds >= 10) {
        writeEndRecord();
      } else {
        deleteStartRecord();
      }
    }
    state = 'idle';
    totalSeconds = 0;
    timeDisplay.textContent = '00:00:00';
    updateRings(0);
    btnStart.textContent = '开 始';
    timeLabel.textContent = '';
    currentSessionStartTime = null;
  }

  /* ========== 按钮事件 ========== */
  btnStart.addEventListener('click', async function () {
    if (state === 'ended') {
      // 结束后点开始 → 从零重新计时
      doReset();
    }

    if (isRunning) {
      // 暂停
      stopTimer();
      isRunning = false;
      state = 'paused';
        btnStart.textContent = '开 始';
      timeLabel.textContent = '已暂停';
      // 设置30分钟自动结束定时器
      autoEndTimeout = setTimeout(function () {
        doEnd();
      }, 30 * 60 * 1000);
      showAlert('暂停超过 30 分钟，计时将自动结束', '⏰');
    } else {
      // 开始 / 继续
      clearAutoEndTimeout();
      if (state === 'idle' || state === 'ended') {
        // 标签为空时询问是否以默认名称开始
        var currentTag = tagText.textContent;
        if (currentTag === '输入标签' || currentTag === '') {
          var confirmed = await showConfirm('当前未输入任务名\n是否以「未命名任务」开始计时？', '🏷️');
          if (confirmed) {
            tagText.textContent = '未命名任务';
          } else {
            return;
          }
        }
        writeStartRecord();
      }
      startTimer();
      isRunning = true;
      state = 'running';
        btnStart.textContent = '暂 停';
      timeLabel.textContent = '计时中';
    }
  });

  btnEnd.addEventListener('click', async function () {
    if (state === 'idle' || state === 'ended') return;
    // 小于10秒的专注不记录
    if (totalSeconds < 10) {
      var confirmed = await showConfirm('专注时长不足10秒，不会被记录。\n确定要结束吗？', '⏱️');
      if (!confirmed) return;
      await deleteStartRecord();
      doEndWithoutRecord();
      return;
    }
    var confirmed = await showConfirm('确定要结束计时吗？', '⏱️');
    if (!confirmed) return;
    doEnd();
  });

  btnReset.addEventListener('click', async function () {
    if (state === 'idle') return;
    // 小于10秒的专注不记录
    if (totalSeconds < 10 && (state === 'running' || state === 'paused')) {
      var confirmed = await showConfirm('专注时长不足10秒，不会被记录。\n确定要重置吗？', '🔄');
      if (!confirmed) return;
      await deleteStartRecord();
      doReset();
      return;
    }
    var confirmed = await showConfirm('确定要重置计时吗？', '🔄');
    if (!confirmed) return;
    doReset();
  });

  /* ========== 标签选择器 ========== */

  // DOM 引用（延迟获取，因为浮层在 HTML 中已定义）
  function getTpOverlay() { return document.getElementById('tpOverlay'); }
  function getTpInput()   { return document.getElementById('tpInput'); }
  function getTpRecent()  { return document.getElementById('tpRecent'); }
  function getTpAll()     { return document.getElementById('tpAll'); }
  function getTpHot()     { return document.getElementById('tpHot'); }
  function getTpRecentSection() { return document.getElementById('tpRecentSection'); }

  // 打开标签选择器浮层
  async function openTagPicker() {
    var records = await readRecordsFromFile();

    // 当前时间
    var now = new Date();
    var nowStr = now.getFullYear() + '-' +
      pad2(now.getMonth() + 1) + '-' +
      pad2(now.getDate()) + ' ' +
      pad2(now.getHours()) + ':' +
      pad2(now.getMinutes()) + ':' +
      pad2(now.getSeconds());

    // 取当前时间之前、有 startTime 的记录，按 startTime 降序排列
    var pastRecords = [];
    for (var i = 0; i < records.length; i++) {
      if (records[i].startTime && records[i].startTime <= nowStr) {
        pastRecords.push(records[i]);
      }
    }
    pastRecords.sort(function (a, b) {
      if (a.startTime > b.startTime) return -1;
      if (a.startTime < b.startTime) return 1;
      return 0;
    });

    // 构建 tag -> lastUsed 映射（用于热门标签次数相同时的二次排序）
    var tagLastUsed = {};
    for (var j = 0; j < pastRecords.length; j++) {
      var tn = pastRecords[j].tag || '无标签';
      if (!tagLastUsed[tn]) {
        tagLastUsed[tn] = pastRecords[j].startTime;
      }
    }

    // 1. 最近使用：取唯一标签前 10 个（优先级最高）
    var recentSet = {};
    var recentTags = [];
    for (var k = 0; k < pastRecords.length; k++) {
      var t1 = pastRecords[k].tag || '无标签';
      if (!recentSet[t1]) {
        recentSet[t1] = true;
        recentTags.push({ tag: t1, lastUsed: pastRecords[k].startTime });
        if (recentTags.length >= 10) break;
      }
    }

    // 2. 全部任务：排除最近使用中的标签，按最近使用排序
    var allTags = [];
    var allSet = {};
    for (var a = 0; a < pastRecords.length; a++) {
      var t2 = pastRecords[a].tag || '无标签';
      if (!recentSet[t2] && !allSet[t2]) {
        allSet[t2] = true;
        allTags.push({ tag: t2, lastUsed: pastRecords[a].startTime });
      }
    }

    // 3. 热门任务：统计当前时间之前记录的使用次数
    var countMap = {};
    for (var c = 0; c < records.length; c++) {
      var t3 = records[c].tag || '无标签';
      if (records[c].startTime && records[c].startTime <= nowStr) {
        countMap[t3] = (countMap[t3] || 0) + 1;
      }
    }
    var hotTags = [];
    for (var tagName in countMap) {
      if (countMap.hasOwnProperty(tagName) && !recentSet[tagName]) {
        hotTags.push({ tag: tagName, count: countMap[tagName] });
      }
    }
    hotTags.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      var aLast = tagLastUsed[a.tag] || '';
      var bLast = tagLastUsed[b.tag] || '';
      if (aLast > bLast) return -1;
      if (aLast < bLast) return 1;
      return 0;
    });

    // 渲染
    var recentEl = getTpRecent();
    var recentSection = getTpRecentSection();
    if (recentTags.length > 0) {
      recentSection.style.display = '';
      renderTagChips(recentEl, recentTags, 'recent');
    } else {
      recentSection.style.display = 'none';
    }
    renderTagChips(getTpAll(), allTags, 'all');
    renderTagChips(getTpHot(), hotTags, 'hot');

    // 显示浮层
    var overlay = getTpOverlay();
    overlay.classList.add('active');
    card.style.setProperty('-webkit-app-region', 'no-drag');

    // 重置输入行状态
    var input = getTpInput();
    input.value = '';
    input.classList.remove('has-value');
    input.focus();
    var clearBtn = document.getElementById('tpInputClear');
    var confirmBtn = document.getElementById('tpInputConfirm');
    if (clearBtn) clearBtn.classList.remove('visible');
    if (confirmBtn) confirmBtn.classList.remove('visible');

    // 清除过滤和高亮
    clearChipHighlight();
    filterTagChips('');
  }

  // 关闭标签选择器浮层
  function closeTagPicker() {
    var overlay = getTpOverlay();
    if (overlay) overlay.classList.remove('active');
    card.style.setProperty('-webkit-app-region', 'drag');
    // 重置输入行状态
    var input = getTpInput();
    if (input) {
      input.value = '';
      input.classList.remove('has-value');
    }
    var clearBtn = document.getElementById('tpInputClear');
    var confirmBtn = document.getElementById('tpInputConfirm');
    if (clearBtn) clearBtn.classList.remove('visible');
    if (confirmBtn) confirmBtn.classList.remove('visible');
    // 清除所有 chip 高亮
    clearChipHighlight();
  }

  // 选中标签（chip 点击：填入输入框预览）
  function previewTag(tagName) {
    var input = getTpInput();
    if (!input) return;
    input.value = tagName;
    input.classList.add('has-value');
    input.focus();

    // 显示清除和确认按钮
    var clearBtn = document.getElementById('tpInputClear');
    var confirmBtn = document.getElementById('tpInputConfirm');
    if (clearBtn) clearBtn.classList.add('visible');
    if (confirmBtn) confirmBtn.classList.add('visible');

    // 高亮对应 chip，清除其他高亮
    highlightChipByTag(tagName);

    // 显示所有 chip（取消过滤）
    filterTagChips('');
  }

  // 确认选择
  function confirmTag() {
    var input = getTpInput();
    var value = (input ? input.value.trim() : '');
    if (value) {
      tagText.textContent = value;
    }
    closeTagPicker();
  }

  // 清除 chip 高亮
  function clearChipHighlight() {
    var containers = [getTpRecent(), getTpAll(), getTpHot()];
    for (var c = 0; c < containers.length; c++) {
      var chips = (containers[c] || {}).querySelectorAll ? containers[c].querySelectorAll('.tp-chip') : [];
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.remove('selected');
      }
    }
  }

  // 高亮指定 tag 的 chip
  function highlightChipByTag(tagName) {
    clearChipHighlight();
    var containers = [getTpRecent(), getTpAll(), getTpHot()];
    for (var c = 0; c < containers.length; c++) {
      var chips = (containers[c] || {}).querySelectorAll ? containers[c].querySelectorAll('.tp-chip') : [];
      for (var i = 0; i < chips.length; i++) {
        if (chips[i].dataset.tag === tagName) {
          chips[i].classList.add('selected');
          return;
        }
      }
    }
  }

  // 渲染 chip 列表
  // type: 'recent' | 'all' | 'hot'
  function renderTagChips(container, tags, type) {
    if (!container) return;
    container.innerHTML = '';

    var currentTag = tagText.textContent;
    if (currentTag === '输入标签') currentTag = '';

    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      var chip = document.createElement('span');
      chip.className = 'tp-chip';
      chip.dataset.tag = t.tag;
      if (t.tag === currentTag) {
        chip.classList.add('selected');
      }

      var textSpan = document.createElement('span');
      textSpan.className = 'tp-chip-text';
      textSpan.textContent = t.tag;
      chip.appendChild(textSpan);

      if (type === 'hot') {
        var countSpan = document.createElement('span');
        countSpan.className = 'tp-chip-count';
        countSpan.textContent = t.count;
        chip.appendChild(countSpan);
      }

      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        previewTag(this.dataset.tag);
      });

      chip.addEventListener('mouseenter', function (e) {
        showTpTooltip(e, this.dataset.tag);
      });

      chip.addEventListener('mouseleave', function () {
        hideTpTooltip();
      });

      container.appendChild(chip);
    }
  }

  // 根据输入过滤 chip
  function filterTagChips(query) {
    var q = (query || '').trim().toLowerCase();
    var containers = [getTpRecent(), getTpAll(), getTpHot()];
    for (var c = 0; c < containers.length; c++) {
      var container = containers[c];
      if (!container) continue;
      var chips = container.querySelectorAll('.tp-chip');
      for (var i = 0; i < chips.length; i++) {
        var chip = chips[i];
        var tagName = (chip.dataset.tag || '').toLowerCase();
        if (q === '' || tagName.indexOf(q) !== -1) {
          chip.classList.remove('hidden');
        } else {
          chip.classList.add('hidden');
        }
      }
    }
  }

  // 转义 HTML
  function escapeHTML(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Tooltip
  function ensureTpTooltip() {
    var tip = document.getElementById('tpTooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tp-tooltip';
      tip.id = 'tpTooltip';
      document.body.appendChild(tip);
    }
    return tip;
  }

  function showTpTooltip(e, tagName) {
    var tip = ensureTpTooltip();
    tip.textContent = tagName;
    tip.className = 'tp-tooltip visible';

    var rect = e.currentTarget.getBoundingClientRect();
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

  function hideTpTooltip() {
    var tip = document.getElementById('tpTooltip');
    if (tip) tip.className = 'tp-tooltip';
  }

  // 点击标签打开选择器
  tag.addEventListener('click', function () {
    // 计时进行中或暂停时不允许编辑标签
    if (state === 'running' || state === 'paused') return;
    openTagPicker();
  });

  // 浮层背景点击关闭
  document.addEventListener('click', function (e) {
    var overlay = getTpOverlay();
    if (!overlay || !overlay.classList.contains('active')) return;
    // 点击浮层背景（非卡片区域）关闭
    if (e.target === overlay) {
      closeTagPicker();
    }
  });

  // 全局键盘事件：Escape 关闭浮层
  document.addEventListener('keydown', function (e) {
    var overlay = getTpOverlay();
    if (!overlay || !overlay.classList.contains('active')) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeTagPicker();
    }
  });

  // 输入框实时过滤 + 输入时取消 chip 选中
  document.addEventListener('input', function (e) {
    var input = getTpInput();
    if (!input || e.target !== input) return;
    // 手动输入时取消 chip 高亮
    clearChipHighlight();
    input.classList.remove('has-value');
    var clearBtn = document.getElementById('tpInputClear');
    var confirmBtn = document.getElementById('tpInputConfirm');
    if (clearBtn) clearBtn.classList.remove('visible');
    if (confirmBtn) confirmBtn.classList.remove('visible');
    filterTagChips(input.value);
  });

  // 输入框 Enter → 确认
  document.addEventListener('keydown', function (e) {
    var input = getTpInput();
    if (!input) return;
    var overlay = getTpOverlay();
    if (!overlay || !overlay.classList.contains('active')) return;
    if (e.target === input && e.key === 'Enter') {
      e.stopPropagation();
      e.preventDefault();
      var value = input.value.trim();
      if (value) {
        confirmTag();
      }
    }
  });

  // 清除按钮
  document.addEventListener('click', function (e) {
    var clearBtn = document.getElementById('tpInputClear');
    if (!clearBtn || e.target !== clearBtn) return;
    var input = getTpInput();
    if (input) {
      input.value = '';
      input.classList.remove('has-value');
      input.focus();
    }
    clearBtn.classList.remove('visible');
    var confirmBtn = document.getElementById('tpInputConfirm');
    if (confirmBtn) confirmBtn.classList.remove('visible');
    clearChipHighlight();
    filterTagChips('');
  });

  // 确认按钮
  document.addEventListener('click', function (e) {
    var confirmBtn = document.getElementById('tpInputConfirm');
    if (!confirmBtn || e.target !== confirmBtn) return;
    e.stopPropagation();
    confirmTag();
  });

  // ========== Quit Protection ==========
  // 主进程在退出容灾中要求退出 mini 模式
  api.onExitMiniMode(function () {
    if (isMiniMode) {
      isMiniMode = false;
      document.documentElement.classList.remove('mini-mode');
      document.body.classList.remove('mini-mode');
    }
  });

  // 主进程退出前查询计时状态
  api.onRequestTimerState(function () {
    var isActive = (state === 'running' || state === 'paused');
    api.reportTimerState({
      isActive: isActive,
      tag: isActive ? getTagValue() : null
    });
  });

  // 主进程通知有活跃任务，显示自定义退出确认弹窗
  api.onShowQuitConfirm(async function (tag) {
    var msg;
    if (totalSeconds < 10) {
      msg = '当前任务「' + tag + '」尚未结束。\n专注时长不足10秒\n退出后不会保存记录？';
    } else {
      msg = '当前任务「' + tag + '」尚未结束。\n退出将自动结束该任务并保存记录。';
    }
    var confirmed = await showConfirm(msg, '⚠️');
    if (!confirmed) {
      api.cancelQuit();
      return;
    }
    // 结束任务并写入记录（<10s 则删除记录）
    if (state === 'running' || state === 'paused') {
      stopTimer();
      isRunning = false;
      state = 'ended';
        btnStart.textContent = '开 始';
      timeLabel.textContent = '已结束';
      clearAutoEndTimeout();
      if (totalSeconds >= 10) {
        await writeEndRecord();
      } else {
        await deleteStartRecord();
      }
    }
    api.quitNow();
  });

  // ========== Minimize to tray ==========
  var minimizeBtn = document.querySelector('.minimize-btn');
  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', function () {
      if (isMiniMode) return;
      isMiniMode = true;
      document.documentElement.classList.add('mini-mode');
      document.body.classList.add('mini-mode');
      api.flashToMini();
    });
  }

  // ========== Navigation via Electron IPC ==========
  // Replace <a href> navigation with Electron in-app routing.
  // 保存计时器状态后跳转，避免切换页面后计时清零。
  var floatBtns = document.querySelectorAll('.float-btn');
  if (floatBtns.length >= 2) {
    floatBtns[0].addEventListener('click', async function (e) {
      e.preventDefault();
      await api.saveTimerState({
        totalSeconds: totalSeconds,
        state: state,
        tag: getTagValue(),
        currentSessionStartTime: currentSessionStartTime,
        saveTimestamp: Date.now()
      });
      api.goTo('sumpage');
    });
    floatBtns[1].addEventListener('click', async function (e) {
      e.preventDefault();
      await api.saveTimerState({
        totalSeconds: totalSeconds,
        state: state,
        tag: getTagValue(),
        currentSessionStartTime: currentSessionStartTime,
        saveTimestamp: Date.now()
      });
      api.goTo('hotmappage');
    });
  }

  // ========== Mini Mode: 双击表盘缩小/恢复 ==========
  var isMiniMode = false;

  function enterMiniMode() {
    if (isMiniMode) return;
    isMiniMode = true;
    document.documentElement.classList.add('mini-mode');
    document.body.classList.add('mini-mode');
    return api.setMiniMode(true);
  }

  function exitMiniMode() {
    if (!isMiniMode) return;
    isMiniMode = false;
    document.documentElement.classList.remove('mini-mode');
    document.body.classList.remove('mini-mode');
    api.setMiniMode(false);
  }

  // 双击表盘进入迷你模式（clock-inner 有 no-drag + pointer-events:auto）
  var clockInnerEl = document.querySelector('.clock-inner');
  clockInnerEl.addEventListener('dblclick', function (e) {
    if (document.querySelector('.tag input')) return;
    e.stopPropagation();
    if (!isMiniMode) {
      enterMiniMode();
    } else {
      exitMiniMode();
    }
  });

  // ========== JS 手动拖拽（迷你模式下整个窗口 no-drag，由 JS 接管移动） ==========
  var dragInfo = null;
  var pendingDX = 0;
  var pendingDY = 0;
  var dragRAF = null;

  document.body.addEventListener('mousedown', function (e) {
    if (!isMiniMode) return;
    if (e.target.closest('.modal-overlay')) return;
    dragInfo = { lastX: e.screenX, lastY: e.screenY };
    pendingDX = 0;
    pendingDY = 0;
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragInfo) return;
    // 同步捕获屏幕坐标，累积增量
    var sx = e.screenX;
    var sy = e.screenY;
    pendingDX += sx - dragInfo.lastX;
    pendingDY += sy - dragInfo.lastY;
    dragInfo.lastX = sx;
    dragInfo.lastY = sy;

    if (!dragRAF) {
      dragRAF = requestAnimationFrame(function () {
        dragRAF = null;
        if (!dragInfo) return;
        var dx = pendingDX;
        var dy = pendingDY;
        pendingDX = 0;
        pendingDY = 0;
        if (dx !== 0 || dy !== 0) {
          api.moveWindowBy(Math.round(dx), Math.round(dy));
        }
      });
    }
  });

  document.addEventListener('mouseup', function () {
    dragInfo = null;
    pendingDX = 0;
    pendingDY = 0;
    if (dragRAF) {
      cancelAnimationFrame(dragRAF);
      dragRAF = null;
    }
  });

})();
