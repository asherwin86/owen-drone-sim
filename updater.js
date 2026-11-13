// Auto-update for the portable DroneSim.exe, using GitHub Releases.
// On start: asks GitHub for the latest release. If it is newer, offers to
// download it, then swaps the exe after the game closes and relaunches it.
const { app, dialog, net, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'asherwin86/owen-drone-sim';
const ASSET = 'DroneSim.exe';

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', 'DroneSim-Updater');
    req.setHeader('Accept', 'application/vnd.github+json');
    let body = '';
    req.on('response', (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', 'DroneSim-Updater');
    req.on('response', (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        hash.update(c);
        out.write(c);
        if (total) onProgress(got / total);
      });
      res.on('end', () => out.end(() => resolve({ size: got, sha256: hash.digest('hex') })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function swapAndRelaunch(newFile, exePath) {
  // Wait for this process to exit (the portable exe stays locked until then),
  // swap the file, relaunch, and delete the script.
  const script = path.join(path.dirname(newFile), 'dronesim-update.cmd');
  const lines = [
    '@echo off',
    ':retry',
    `move /y "${newFile}" "${exePath}" >nul 2>&1`,
    'if errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto retry',
    ')',
    `start "" "${exePath}"`,
    '(goto) 2>nul & del "%~f0"',
  ];
  fs.writeFileSync(script, lines.join('\r\n'));
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  app.quit();
}

async function checkForUpdates(win) {
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!app.isPackaged || !exePath) return; // only the packaged portable exe updates itself
  let rel;
  try {
    rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  } catch {
    return; // offline or rate limited: stay quiet, try again next launch
  }
  if (!rel || !newer(rel.tag_name, app.getVersion())) return;
  const asset = (rel.assets || []).find((a) => a.name === ASSET);
  if (!asset) return;

  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Update now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Drone Sim update',
    message: `Drone Sim ${rel.tag_name.replace(/^v/, '')} is available`,
    detail: `You have ${app.getVersion()}. The update downloads in the background (${Math.round(asset.size / 1048576)} MB), then the game restarts.`,
  });
  if (response !== 0) return;

  const dest = path.join(path.dirname(exePath), 'DroneSim.update.exe');
  try {
    const { size, sha256 } = await download(asset.browser_download_url, dest, (f) => {
      if (win && !win.isDestroyed()) {
        win.setProgressBar(f);
        win.setTitle(`Drone Sim - downloading update ${Math.round(f * 100)}%`);
      }
    });
    if (win && !win.isDestroyed()) { win.setProgressBar(-1); win.setTitle('Drone Sim'); }
    const expected = asset.digest && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;
    if (size !== asset.size || (expected && expected !== sha256)) throw new Error('Downloaded file did not verify.');
    swapAndRelaunch(dest, exePath);
  } catch (e) {
    try { fs.unlinkSync(dest); } catch {}
    if (win && !win.isDestroyed()) { win.setProgressBar(-1); win.setTitle('Drone Sim'); }
    dialog.showMessageBox(win, {
      type: 'warning', title: 'Drone Sim update',
      message: 'The update could not be installed.',
      detail: String(e.message || e) + '\nThe game still works; it will try again next time.',
    });
  }
}

module.exports = { checkForUpdates };
