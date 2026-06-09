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
      pad2(d.getMinutes());
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
        '<button class="modal-btn modal-btn-secondary" id="modalCancelBtn">取消</button>' +
        '<button class="modal-btn modal-btn-primary" id="modalConfirmBtn">确定</button>';
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
    writeEndRecord();
  }

  function doReset() {
    stopTimer();
    isRunning = false;
    clearAutoEndTimeout();
    // 如果有正在计时或暂停的计时，结束并写入记录
    if (state === 'running' || state === 'paused') {
      writeEndRecord();
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
        // 标签为空时询问是否命名
        var currentTag = tagText.textContent;
        if (currentTag === '输入标签' || currentTag === '') {
          var shouldName = await showConfirm('是否为当前任务命名？', '🏷️');
          if (shouldName) return;
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
    var confirmed = await showConfirm('确定要结束计时吗？', '⏱️');
    if (!confirmed) return;
    doEnd();
  });

  btnReset.addEventListener('click', async function () {
    if (state === 'idle') return;
    var confirmed = await showConfirm('确定要重置计时吗？', '🔄');
    if (!confirmed) return;
    doReset();
  });

  /* ========== 标签编辑 ========== */
  tag.addEventListener('click', function () {
    // 计时进行中或暂停时不允许编辑标签
    if (state === 'running' || state === 'paused') return;
    if (tag.querySelector('input')) return;

    var currentText = tagText.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = currentText === '输入标签' ? '' : currentText;
    input.placeholder = '输入标签名称';
    input.maxLength = 20;

    tagText.style.display = 'none';
    tag.appendChild(input);

    Object.assign(input.style, {
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontSize: 'inherit',
      fontFamily: 'inherit',
      color: '#334155',
      width: '120px',
      letterSpacing: '0.06em',
      padding: '0'
    });

    // 关键：编辑期间临时移除卡片 drag 属性，让鼠标事件能正常到达渲染进程
    card.style.setProperty('-webkit-app-region', 'no-drag');

    input.focus();
    input.select();

    var finished = false;

    function finishEditing() {
      if (finished) return;
      finished = true;
      // 恢复卡片拖拽
      card.style.setProperty('-webkit-app-region', 'drag');
      var value = input.value.trim();
      tagText.textContent = value || '无标签';
      tagText.style.display = '';
      if (input.parentNode) input.remove();
      document.removeEventListener('click', handleOutsideClick);
    }

    function handleOutsideClick(e) {
      if (!tag.contains(e.target)) {
        finishEditing();
      }
    }

    input.addEventListener('blur', finishEditing);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        finishEditing();
      } else if (e.key === 'Escape') {
        input.value = currentText;
        finishEditing();
      }
    });

    setTimeout(function () {
      document.addEventListener('click', handleOutsideClick);
    }, 0);
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
    var confirmed = await showConfirm(
      '当前任务「' + tag + '」尚未结束。\n退出将自动结束该任务并保存记录。\n\n确定退出吗？',
      '⚠️'
    );
    if (!confirmed) {
      api.cancelQuit();
      return;
    }
    // 结束任务并写入记录
    if (state === 'running' || state === 'paused') {
      stopTimer();
      isRunning = false;
      state = 'ended';
        btnStart.textContent = '开 始';
      timeLabel.textContent = '已结束';
      clearAutoEndTimeout();
      await writeEndRecord();
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
