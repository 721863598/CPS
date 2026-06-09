const { contextBridge, ipcRenderer } = require('electron');

/**
 * Electron preload script for the Pomodoro Clock app.
 *
 * Exposes `window.electronAPI` to the renderer process, replacing the
 * browser-only File System Access API with Electron's native fs + dialog.
 *
 * Uses contextBridge for security (contextIsolation: true).
 */

contextBridge.exposeInMainWorld('electronAPI', {
  // ========== File Operations ==========

  /**
   * Read the current data file. Returns parsed JSON array.
   */
  readRecords: async () => {
    try {
      const filePath = await ipcRenderer.invoke('fs:getCurrentPath');
      if (!filePath) return [];
      const { content } = await ipcRenderer.invoke('fs:readFile', filePath);
      return JSON.parse(content);
    } catch (err) {
      return [];
    }
  },

  /**
   * Write records array to the current data file.
   */
  writeRecords: async (records) => {
    try {
      const filePath = await ipcRenderer.invoke('fs:getCurrentPath');
      if (!filePath) return false;
      await ipcRenderer.invoke('fs:writeFile', filePath, JSON.stringify(records, null, 2));
      return true;
    } catch (err) {
      return false;
    }
  },

  /**
   * Read raw file content as text (for repair/validation).
   */
  readFileRaw: async () => {
    try {
      const filePath = await ipcRenderer.invoke('fs:getCurrentPath');
      if (!filePath) return null;
      const { content } = await ipcRenderer.invoke('fs:readFile', filePath);
      return content;
    } catch (err) {
      return null;
    }
  },

  // ========== File State ==========

  /**
   * Get the currently open file path.
   */
  getFilePath: async () => {
    return await ipcRenderer.invoke('fs:getCurrentPath');
  },

  /**
   * Get the current file name from the path.
   */
  getFileName: async () => {
    const filePath = await ipcRenderer.invoke('fs:getCurrentPath');
    if (!filePath) return null;
    // Extract filename from path (works on both Windows and Unix)
    return filePath.split(/[\\/]/).pop();
  },

  /**
   * Check if a file is currently open.
   */
  isFileOpen: async () => {
    const filePath = await ipcRenderer.invoke('fs:getCurrentPath');
    return !!filePath;
  },

  // ========== Timer State Preservation ==========

  /**
   * Save timer state before navigating away from mainpage.
   * @param {{ totalSeconds: number, state: string, tag: string, currentSessionStartTime: string|null, saveTimestamp: number }} timerState
   */
  saveTimerState: (timerState) => {
    return ipcRenderer.invoke('timer:saveState', timerState);
  },

  /**
   * Retrieve and clear saved timer state (called on mainpage load).
   */
  getTimerState: () => {
    return ipcRenderer.invoke('timer:getState');
  },

  // ========== Navigation ==========

  /**
   * Navigate to another clock page inside the same window.
   * @param {'mainpage'|'hotmappage'|'sumpage'} page
   */
  goTo: (page) => {
    ipcRenderer.invoke('nav:goTo', page);
  },

  /**
   * Minimize window to system tray.
   */
  minimizeWindow: () => {
    ipcRenderer.invoke('window:minimize');
  },

  /**
   * Toggle mini mode (200×100 compact view with time only).
   * @param {boolean} isMini
   */
  setMiniMode: (isMini) => {
    return ipcRenderer.invoke('window:setMiniMode', isMini);
  },

  /**
   * Shrink → hide → pop up mini circle on top.
   */
  flashToMini: () => {
    return ipcRenderer.invoke('window:flashToMini');
  },

  /**
   * Move window by delta (for JS dragging in mini mode).
   * @param {number} dx
   * @param {number} dy
   */
  moveWindowBy: (dx, dy) => {
    return ipcRenderer.invoke('window:moveBy', dx, dy);
  },

  // ========== Quit Protection ==========

  /**
   * Listen for timer state query from main process (before quit).
   */
  onRequestTimerState: (callback) => {
    ipcRenderer.on('app:requestTimerState', () => callback());
  },

  /**
   * Listen for quit-confirm request from main process (active task).
   * Receives the current task tag as argument.
   */
  onShowQuitConfirm: (callback) => {
    ipcRenderer.on('app:showQuitConfirm', (event, tag) => callback(tag));
  },

  /**
   * Listen for mini mode exit request from main process (during quit protection).
   */
  onExitMiniMode: (callback) => {
    ipcRenderer.on('app:exitMiniMode', () => callback());
  },

  /**
   * Report current timer state to main process.
   * @param {{ isActive: boolean, tag?: string }} state
   */
  reportTimerState: (state) => {
    return ipcRenderer.invoke('app:reportTimerState', state);
  },

  /**
   * User cancelled the quit dialog — notify main process.
   */
  cancelQuit: () => {
    return ipcRenderer.invoke('app:cancelQuit');
  },

  /**
   * Notify main process that task is ended and app should quit.
   */
  quitNow: () => {
    return ipcRenderer.invoke('app:quitNow');
  }
});
