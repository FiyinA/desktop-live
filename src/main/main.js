const { app, BrowserWindow, ipcMain, screen, shell, desktopCapturer, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const Store = require('electron-store') || { get: () => {}, set: () => {} }

let mainWindow = null
let overlayWindow = null

// ─── Create Main UI Window ───────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 620,
    minWidth: 340,
    minHeight: 160,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: false,
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      backgroundThrottling: false
    },
    backgroundColor: '#ffffff',
    show: false
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // F12 opens DevTools for debugging
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.on('closed', () => {
    if (overlayWindow) {
      overlayWindow.close()
    }
    app.quit()
  })
}

// ─── Create Blue Border Overlay Window ───────────────────────────────────────
function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false
  })

  // Make window click-through so desktop still works
  overlayWindow.setIgnoreMouseEvents(true)

  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'))

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.on('show-overlay', () => {
  if (!overlayWindow) createOverlayWindow()
  overlayWindow.showInactive()
})

ipcMain.on('hide-overlay', () => {
  if (overlayWindow) overlayWindow.hide()
})

ipcMain.on('overlay-pulse', (event, mode) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('set-mode', mode)
  }
})

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize()
})

ipcMain.on('resize-window', (_event, height) => {
  if (mainWindow) {
    const [width] = mainWindow.getSize()
    mainWindow.setSize(width, height, false)
  }
})

ipcMain.on('close-window', () => {
  app.quit()
})

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url)
})

ipcMain.on('log', (event, level, ...args) => {
  console[level]('[renderer]', ...args)
})

ipcMain.handle('open-file-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Text Files', extensions: ['txt', 'md', 'js', 'ts', 'py', 'json', 'csv', 'html', 'css', 'jsx', 'tsx'] }
    ]
  })
  if (canceled || !filePaths[0]) return null
  const filePath = filePaths[0]
  return {
    path: filePath,
    name: path.basename(filePath),
    content: fs.readFileSync(filePath, 'utf8')
  }
})

ipcMain.handle('get-screen-source', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 }
  })
  const displays = screen.getAllDisplays()
  return sources.map((s, i) => {
    // display_id is a numeric string matching screen.Display.id on Windows/macOS
    const numericId = s.display_id ? parseInt(s.display_id) : NaN
    const display = (!isNaN(numericId) && displays.find(d => d.id === numericId))
      || displays[i]
      || displays[0]
    return { id: s.id, name: s.name, bounds: display.bounds }
  })
})

ipcMain.on('set-overlay-screen', (_event, bounds) => {
  if (overlayWindow && bounds) {
    overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  }
})

// ─── App Lifecycle ────────────────────────────────────────────────────────────
// Prevent Chromium from dropping the GPU compositor layer on repaint,
// which causes the white-screen flash in frameless windows.
app.commandLine.appendSwitch('disable-gpu-vsync')
app.commandLine.appendSwitch('disable-frame-rate-limit')
app.commandLine.appendSwitch('in-process-gpu')

app.whenReady().then(() => {
  createMainWindow()
  createOverlayWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
