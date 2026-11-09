// Electron entry point: opens Drone Sim as a Windows desktop app.
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const { startServer } = require('./server');

// Make sure the GPU is used for the 3D world.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;

async function createWindow() {
  const { port } = await startServer(0, { onQuit: () => app.quit() });
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#05070d',
    title: 'Drone Sim',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.maximize();
  win.loadURL(`http://127.0.0.1:${port}/`);
}

ipcMain.on('quit', () => app.quit());
ipcMain.on('toggle-fullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen());
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
