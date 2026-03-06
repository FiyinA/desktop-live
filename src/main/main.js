const { app, BrowserWindow, ipcMain, screen, shell, desktopCapturer } = require('electron')
const path = require('path')
const Store = require('electron-store') || { get: () => {}, set: () => {} }

let mainWindow = null
let overlayWindow = null

// ─── Create Main UI Window ───────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 620,
    minWidth: 340,
    minHeight: 500,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    backgroundColor: '#0a0a0f',
    show: false
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
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

ipcMain.on('close-window', () => {
  app.quit()
})

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url)
})

ipcMain.on('log', (event, level, ...args) => {
  console[level]('[renderer]', ...args)
})

ipcMain.handle('get-screen-source', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 }
  })
  return sources.map(s => ({ id: s.id, name: s.name }))
})

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createMainWindow()
  createOverlayWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
