const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const generatedRoot = path.join(os.tmpdir(), 'novatube-downloader');

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveGeneratedDir(envName, folderName) {
  const fallback = path.join(generatedRoot, folderName);
  const configured = process.env[envName];
  if (!configured) return fallback;

  const resolved = path.resolve(configured);
  if (resolved === projectRoot || isInside(projectRoot, resolved)) {
    console.warn(`${envName} points inside the project. Using temporary storage at ${fallback}.`);
    return fallback;
  }

  return resolved;
}

const downloadRoot = resolveGeneratedDir('DOWNLOAD_DIR', 'downloads');
const tempRoot = resolveGeneratedDir('TEMP_DIR', 'temp');
const logRoot = resolveGeneratedDir('LOG_DIR', 'logs');
const previewRoot = path.join(tempRoot, 'previews');

module.exports = {
  projectRoot,
  generatedRoot,
  downloadRoot,
  tempRoot,
  logRoot,
  previewRoot,
  isInside,
};
