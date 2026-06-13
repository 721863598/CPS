const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const dbService = require('./db-service');

let mainWindow = null;
let tray = null;
let currentFilePath = null;
let isQuitting = false;

function initDataFile() {
  // 开发模式：使用项目根目录下的 records/ 文件夹（打包时自动忽略）
  // 打包后 asar 只读，数据文件写入 exe 同级 records/ 目录
  let recordsDir;
  if (app.isPackaged) {
    const exeDir = path.dirname(process.execPath);
    recordsDir = path.join(exeDir, 'records');
  } else {
    recordsDir = path.join(__dirname, 'records');
  }

  // 创建 records 文件夹（如果不存在）
  if (!fs.existsSync(recordsDir)) {
    fs.mkdirSync(recordsDir, { recursive: true });
  }

  // 保留 JSON 路径用于迁移检查，但不主动创建空 JSON
  currentFilePath = path.join(recordsDir, 'records.json');
}

function createTray() {
  // 加载应用图标（timeclock.ico）
  const iconPath = path.join(__dirname, 'assets', 'timeclock.ico');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    // 托盘图标缩放到 32x32
    if (!icon.isEmpty()) {
      icon = icon.resize({ width: 32, height: 32 });
    }
  } else {
    // 兜底：绿色圆点 data URL
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABK0lEQVR4nO2X0RGDIAyGeXcLtnAERvCFZ0dwg67gCF2EIRzBNzegpZfecTaBhGi965W7/0XFfIQkBGP+Qzhs8J0NvrfBDzb4ETTAs+5Mw84GPz+NLTb4SGiBb9yRhtPK7pjBfCDv05xeazy5d6VWXAGIMHdsNT4VXM0FeGtqWXntpxKAyPYE7HnJ7VsmCcDKigkq4AgICcArMGvGHdP1rQCxmKKQw2cDzJTxrlJkjgJY0IoJwcf+kQIgosEI9fxbAAMGwMr9gwA+a4IUACBuSdJ5FIBoC5RCt0AUhEqhQchOQ6XwNDSCQqQUXoiMoBQrVe6WOIeRQuXDyDCOY4V4x7FprAkMyVozTksmkKwl23lCsx3tTWkGQbbltYBTt+U7kGsuJgjINVeznx0PBYOZTruC8qUAAAAASUVORK5CYII='
    );
  }

  tray = new Tray(icon);
  tray.setToolTip('CPS');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        if (!mainWindow) {
          isQuitting = true;
          app.quit();
          return;
        }

        // 向渲染进程查询计时状态，2 秒超时兜底
        let handled = false;
        const quitTimeout = setTimeout(() => {
          if (!handled) {
            handled = true;
            isQuitting = true;
            app.quit();
          }
        }, 2000);
        mainWindow._quitTimeout = quitTimeout;

        mainWindow.webContents.send('app:requestTimerState');
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // 点击托盘图标显示窗口
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 650,
    resizable: false,
    frame: false,
    transparent: true,
    title: 'CPS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'mainpage', 'mainpage.html'));

  // 任务栏图标
  const iconPath = path.join(__dirname, 'assets', 'timeclock.ico');
  if (fs.existsSync(iconPath)) {
    mainWindow.setIcon(iconPath);
  }

  // 确保窗口不会始终置顶
  mainWindow.setAlwaysOnTop(false);

  // 窗口失去焦点时取消置顶，确保点击外部后窗口正常下沉
  mainWindow.on('blur', () => {
    if (mainWindow) {
      mainWindow.setAlwaysOnTop(false);
    }
  });

  // 点击关闭按钮时隐藏到托盘而不是退出
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ========== IPC Handlers ==========

// Read file content
ipcMain.handle('fs:readFile', async (event, filePath) => {
  try {
    // 确保目录和文件存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf-8');
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    // 自动剥离 UTF-8 BOM，防止外部编辑 JSON 后解析失败
    return { content: content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content };
  } catch (err) {
    throw new Error('读取文件失败: ' + err.message);
  }
});

// Write file content
ipcMain.handle('fs:writeFile', async (event, filePath, content) => {
  try {
    // 确保目录存在（容灾：运行时目录被意外删除）
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    throw new Error('写入文件失败: ' + err.message);
  }
});

// Get current file path (for handle persistence across page navigations)
ipcMain.handle('fs:getCurrentPath', async () => {
  return currentFilePath;
});

// ========== Database IPC Handlers ==========

// 辅助函数：写操作后持久化并通知渲染进程
function afterWrite() {
  const recordsDir = path.dirname(currentFilePath);
  const dbPath = path.join(recordsDir, 'records.db');
  dbService.saveToDisk(dbPath);
  // 通知所有渲染进程数据已变更
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('db:dataChanged');
  }
}

// 插入/更新单条记录
ipcMain.handle('db:insertRecord', async (event, record) => {
  try {
    const result = dbService.insertRecord(record);
    afterWrite();
    return result;
  } catch (err) {
    throw new Error('插入记录失败: ' + err.message);
  }
});

// 更新记录结束信息
ipcMain.handle('db:updateRecordEnd', async (event, startTime, endTime, duration) => {
  try {
    const result = dbService.updateRecordEnd(startTime, endTime, duration);
    afterWrite();
    return result;
  } catch (err) {
    throw new Error('更新记录失败: ' + err.message);
  }
});

// 删除记录
ipcMain.handle('db:deleteRecord', async (event, startTime) => {
  try {
    const result = dbService.deleteRecord(startTime);
    afterWrite();
    return result;
  } catch (err) {
    throw new Error('删除记录失败: ' + err.message);
  }
});

// 获取全部记录
ipcMain.handle('db:getAllRecords', async () => {
  try {
    return dbService.getAllRecords();
  } catch (err) {
    return [];
  }
});

// 获取最近使用的标签
ipcMain.handle('db:getRecentTags', async (event, limit) => {
  try {
    return dbService.getRecentTags(limit || 10);
  } catch (err) {
    return [];
  }
});

// 获取热门标签
ipcMain.handle('db:getHotTags', async (event, limit) => {
  try {
    return dbService.getHotTags(limit || 10);
  } catch (err) {
    return [];
  }
});

// 获取周期汇总数据（sumpage）
ipcMain.handle('db:getSummaryData', async (event, period, dateStr) => {
  try {
    return dbService.getSummaryData(period, dateStr);
  } catch (err) {
    return null;
  }
});

// 获取24小时分布（sumpage）
ipcMain.handle('db:getHourlyDistribution', async (event, period, dateStr) => {
  try {
    return dbService.getHourlyDistribution(period, dateStr);
  } catch (err) {
    return new Array(24).fill(0);
  }
});

// 获取活跃时段分布（sumpage）
ipcMain.handle('db:getActiveDistribution', async (event, period, dateStr) => {
  try {
    return dbService.getActiveDistribution(period, dateStr);
  } catch (err) {
    return null;
  }
});

// 获取指定年份的记录（sumpage 历史视图）
ipcMain.handle('db:getRecordsForYear', async (event, year) => {
  try {
    return dbService.getRecordsForYear(year);
  } catch (err) {
    return [];
  }
});

// 获取全部日期的专注秒数映射（hotmappage）
ipcMain.handle('db:getAllDayMap', async () => {
  try {
    return dbService.getAllDayMap();
  } catch (err) {
    return {};
  }
});

// 获取标签统计（最近 / 热门 / 全部去重）
ipcMain.handle('db:getTagStats', async () => {
  try {
    return dbService.getTagStats();
  } catch (err) {
    return { recentTags: [], hotTags: [], allTags: [] };
  }
});

// ========== Window IPC Handlers ==========
ipcMain.handle('window:minimize', async () => {
  if (mainWindow) {
    mainWindow.hide();
  }
});

// Flash to mini: shrink → hide briefly → pop up mini circle on top
ipcMain.handle('window:flashToMini', async () => {
  if (!mainWindow) return;

  isMiniMode = true;
  mainWindow.setSkipTaskbar(true);

  // 1. Save original size and shrink to 104×104
  const bounds = mainWindow.getBounds();
  if (!miniOriginalSize) {
    miniOriginalSize = { width: bounds.width, height: bounds.height };
  }
  mainWindow.setMaximumSize(104, 104);
  mainWindow.setMinimumSize(104, 104);
  mainWindow.setSize(104, 104);
  mainWindow.center();

  // 2. Hide briefly
  mainWindow.hide();

  // 3. Show mini circle on top after a short delay
  setTimeout(() => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.restore();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.center();
    // Drop alwaysOnTop after a moment
    setTimeout(() => {
      if (mainWindow) mainWindow.setAlwaysOnTop(false);
    }, 800);
  }, 120);
});

// Toggle mini mode (200×100 compact time-only view)
let miniOriginalSize = null;
let isMiniMode = false;
ipcMain.handle('window:setMiniMode', async (event, isMini) => {
  if (!mainWindow) return;
  isMiniMode = isMini;
  if (isMini) {
    // Save current size before shrinking
    const bounds = mainWindow.getBounds();
    miniOriginalSize = { width: bounds.width, height: bounds.height };
    mainWindow.setMaximumSize(104, 104);
    mainWindow.setMinimumSize(104, 104);
    mainWindow.setSize(104, 104);
    mainWindow.center();
    mainWindow.setSkipTaskbar(true);
  } else {
    const orig = miniOriginalSize || { width: 500, height: 650 };
    mainWindow.setMaximumSize(orig.width, orig.height);
    mainWindow.setMinimumSize(orig.width, orig.height);
    mainWindow.setSize(orig.width, orig.height);
    mainWindow.center();
    mainWindow.setSkipTaskbar(false);
  }
});

// Move window by delta (for JS-based dragging in mini mode)
// Hardcode mini size to prevent any size drift during drag
var MINI_W = 104;
var MINI_H = 104;
ipcMain.handle('window:moveBy', async (event, dx, dy) => {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds({
    x: bounds.x + Math.round(dx),
    y: bounds.y + Math.round(dy),
    width: MINI_W,
    height: MINI_H
  });
});

// Navigate to a different page（根据页面调整窗口大小并居中）
ipcMain.handle('nav:goTo', async (event, page) => {
  const pageMap = {
    mainpage:  { file: 'mainpage/mainpage.html',  width: 500, height: 650 },
    hotmappage: { file: 'hotmappage/hotmappage.html', width: 1000, height: 700 },
    sumpage:   { file: 'sumpage/sumpage.html',   width: 1000, height: 800 }
  };
  const cfg = pageMap[page];
  if (cfg) {
    // 锁定窗口尺寸：先设 max 收缩再设 min 撑底，防止 frameless 窗口变形
    mainWindow.setMaximumSize(cfg.width, cfg.height);
    mainWindow.setMinimumSize(cfg.width, cfg.height);
    mainWindow.setSize(cfg.width, cfg.height);
    mainWindow.center();
    mainWindow.loadFile(path.join(__dirname, cfg.file));
  }
});

// ========== Timer State Preservation ==========

// 跨页面导航时保存/恢复计时器状态
let savedTimerState = null;

ipcMain.handle('timer:saveState', async (event, timerState) => {
  savedTimerState = timerState;
});

ipcMain.handle('timer:getState', async () => {
  const state = savedTimerState;
  savedTimerState = null; // 取出后清除
  return state;
});

// ========== Quit Protection ==========

// 渲染进程响应计时状态查询
ipcMain.handle('app:reportTimerState', async (event, timerState) => {
  // 清除超时定时器
  if (mainWindow && mainWindow._quitTimeout) {
    clearTimeout(mainWindow._quitTimeout);
    mainWindow._quitTimeout = null;
  }

  if (!timerState.isActive) {
    // 没有活跃任务，直接退出
    isQuitting = true;
    app.quit();
    return;
  }

  // 有活跃任务：如果在 mini 模式，先退出 mini 恢复完整窗口
  if (isMiniMode) {
    isMiniMode = false;
    mainWindow.setSkipTaskbar(false);
    const orig = miniOriginalSize || { width: 500, height: 650 };
    mainWindow.setMaximumSize(orig.width, orig.height);
    mainWindow.setMinimumSize(orig.width, orig.height);
    mainWindow.setSize(orig.width, orig.height);
    mainWindow.center();
    // 通知渲染进程退出 mini 模式
    mainWindow.webContents.send('app:exitMiniMode');
  }

  // 强制窗口恢复并置顶后再弹窗
  mainWindow.show();
  mainWindow.restore();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  // 短暂延迟确保窗口渲染完毕再触发弹窗
  setTimeout(() => {
    if (mainWindow) {
      mainWindow.webContents.send('app:showQuitConfirm', timerState.tag);
      // 弹窗显示后取消置顶
      setTimeout(() => {
        if (mainWindow) mainWindow.setAlwaysOnTop(false);
      }, 600);
    }
  }, 150);

  // 兜底超时：10 秒后用户未操作则自动取消退出
  var confirmTimeout = setTimeout(function () {
    if (mainWindow) {
      mainWindow.setAlwaysOnTop(false);
      if (mainWindow._confirmTimeout === confirmTimeout) {
        mainWindow._confirmTimeout = null;
      }
    }
  }, 10000);
  mainWindow._confirmTimeout = confirmTimeout;
});

// 用户取消退出
ipcMain.handle('app:cancelQuit', async () => {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(false);
    if (mainWindow._confirmTimeout) {
      clearTimeout(mainWindow._confirmTimeout);
      mainWindow._confirmTimeout = null;
    }
  }
});

// 渲染进程结束任务后通知主进程退出
ipcMain.handle('app:quitNow', async () => {
  if (mainWindow && mainWindow._confirmTimeout) {
    clearTimeout(mainWindow._confirmTimeout);
    mainWindow._confirmTimeout = null;
  }
  isQuitting = true;
  app.quit();
});

// ========== Single Instance Lock ==========

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 已有实例在运行，直接退出
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // 用户尝试启动第二个实例时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ========== App Lifecycle ==========

app.whenReady().then(async () => {
  initDataFile();
  // 初始化 SQLite 数据库
  const recordsDir = path.dirname(currentFilePath);
  const dbPath = path.join(recordsDir, 'records.db');
  try {
    await dbService.initDB(dbPath, currentFilePath);
    console.log('[main] 数据库初始化完成');
  } catch (err) {
    console.error('[main] 数据库初始化失败:', err.message);
  }
  createWindow();
  createTray();
});

// 防止所有窗口关闭时退出应用
app.on('window-all-closed', (event) => {
  // 不退出，继续在托盘中运行
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  dbService.close();
});
