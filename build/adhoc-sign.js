const path = require('path');
const { execFileSync } = require('child_process');

/* electron-builder skips signing when there is no Apple certificate, which leaves the bundle
   with only Electron's stub signature. On Apple Silicon a quarantined download with a broken
   seal is reported as "damaged". Signing the whole bundle ad hoc gives it a valid seal, so
   macOS shows the normal "unidentified developer" prompt instead. */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
