const electronInstaller = require('electron-winstaller');
const path = require('path');
const packageJson = require('../package.json');

async function buildInstaller() {
  console.log('Building Installer with electron-winstaller to bypass signtool hangs...');
  try {
    await electronInstaller.createWindowsInstaller({
      appDirectory: path.join(__dirname, '..', 'dist', 'win-unpacked'),
      outputDirectory: path.join(__dirname, '..', 'dist', 'installer'),
      authors: 'Ganga Digital',
      exe: 'Ganga Digital Automation.exe',
      setupExe: `Ganga Digital Automation Setup ${packageJson.version}.exe`,
      noMsi: true
    });
    console.log('Installer built successfully in dist/installer!');
  } catch (e) {
    console.error(`Installer build crashed: ${e.message}`);
    process.exit(1);
  }
}

buildInstaller();
