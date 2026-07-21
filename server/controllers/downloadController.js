const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const ytdlp = require('yt-dlp-exec');
const { sanitizeFileName, formatSeconds, parseTimeToSeconds, isValidTime, runCommand } = require('../services/downloadService');

ffmpeg.setFfmpegPath(ffmpegPath);

const { DOWNLOAD_DIR, TEMP_DIR } = process.env;
const downloadRoot = path.join(os.tmpdir(), 'yt-downloader');
const tempRoot = path.join(os.tmpdir(), 'yt-downloader-temp');

fs.mkdirSync(downloadRoot, { recursive: true });
fs.mkdirSync(tempRoot, { recursive: true });
const previewRoot = path.join(tempRoot, 'previews');
const ytdlpPath = path.resolve(
  path.dirname(require.resolve('yt-dlp-exec')),
  '..',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

const activeProcesses = new Map();
const queues = [];
let runningDownloads = 0;
const maxDownloads = Math.max(1, Number(process.env.MAX_DOWNLOADS || 1));
// Faster download defaults; override by setting environment variables.
const downloadFragments = Math.min(256, Math.max(1, Number(process.env.DOWNLOAD_FRAGMENTS || 256)));
const downloadHttpChunkSize = process.env.DOWNLOAD_HTTP_CHUNK_SIZE || '64M';
const downloadBufferSize = process.env.DOWNLOAD_BUFFER_SIZE || '4M';
const useHlsMpegTs = process.env.HLS_USE_MPEGTS !== 'false';
const skipUnavailableFragments = process.env.SKIP_UNAVAILABLE_FRAGMENTS !== 'false';
// Empty means no throttling by default — set DOWNLOAD_THROTTLED_RATE to enable.
const downloadThrottledRate = process.env.DOWNLOAD_THROTTLED_RATE || '';
const fastVideoMode = process.env.FAST_VIDEO_MODE !== 'false';
const fastAudioMode = process.env.FAST_AUDIO_MODE !== 'false';
const fastTrimMode = process.env.FAST_TRIM_MODE !== 'false';
const sectionDownloadMode = process.env.SECTION_DOWNLOAD_MODE === 'true';
const forceKeyframesAtCuts = process.env.FORCE_KEYFRAMES_AT_CUTS !== 'false';
const maxPreviewSeconds = Math.max(10, Number(process.env.MAX_PREVIEW_SECONDS || 180));
const ffmpegVideoPreset = process.env.FFMPEG_VIDEO_PRESET || 'ultrafast';
const { spawnSync } = require('child_process');

// Prefer an external multi-connection downloader when available (aria2c is recommended).
let externalDownloader = process.env.YTDLP_EXTERNAL_DOWNLOADER || '';
let externalDownloaderArgs = process.env.YTDLP_EXTERNAL_DOWNLOADER_ARGS || '';
if (!externalDownloader) {
  try {
    const check = spawnSync('aria2c', ['--version'], { stdio: 'ignore' });
    if (check.status === 0) {
      externalDownloader = 'aria2c';
      // Reasonable defaults for aria2c to maximize parallelism without overwhelming most networks.
      externalDownloaderArgs = externalDownloaderArgs || 'aria2c:-x 16 -s 16 -k 1M';
      console.log('[downloadController] using aria2c as external downloader with args:', externalDownloaderArgs);
    }
  } catch (e) {
    // ignore — no external downloader available
  }
}
console.log('[downloadController] effective download settings]', { downloadFragments, downloadHttpChunkSize, downloadBufferSize, downloadThrottledRate, externalDownloader, externalDownloaderArgs });
const defaultYtdlpHeaders = [
  'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer: https://www.youtube.com/',
  'Accept-Language: en-US,en;q=0.9',
];
const ytdlpHeaders = process.env.YTDLP_ADD_HEADERS
  ? process.env.YTDLP_ADD_HEADERS.split(';').map((header) => header.trim()).filter(Boolean)
  : defaultYtdlpHeaders;
const ytdlpIgnoreConfig = process.env.YTDLP_IGNORE_CONFIG !== 'false';
const ytdlpJsRuntime = process.env.YTDLP_JS_RUNTIME || `node:${process.execPath}`;
const cancellableStatuses = new Set(['queued', 'preparing', 'downloading', 'processing']);
const previewFiles = new Map();

fs.ensureDirSync(previewRoot);

function isCancelledError(error) {
  return error?.code === 'ERR_CANCELLED';
}

function isCancelled(record) {
  return record.cancelRequested || record.status === 'cancelled';
}

function setDownloadProgress(record, value) {
  record.progress = Math.max(record.progress || 0, Math.min(99, Math.round(value)));
}

function updateYtdlpProgress(record, output, start = 5, end = 88) {
  const matches = [...String(output).matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g)];
  const last = matches.at(-1);
  if (!last) return;
  const rawPercent = Number(last[1]);
  if (!Number.isFinite(rawPercent)) return;
  setDownloadProgress(record, start + (rawPercent / 100) * (end - start));
}

function createActiveContext(record, type) {
  const controller = new AbortController();
  const context = {
    type,
    controller,
    process: null,
    startedAt: new Date().toISOString(),
    cancel() {
      record.cancelRequested = true;
      record.status = 'cancelled';
      record.error = 'Download cancelled.';
      controller.abort();
    },
  };
  activeProcesses.set(record.id, context);
  return context;
}

function commandOptionsFor(record, context, progressStart, progressEnd) {
  return {
    cwd: process.cwd(),
    signal: context.controller.signal,
    cancelMessage: 'Download cancelled.',
    onProcess: (child) => {
      context.process = child;
    },
    onOutput: (stream, output) => {
      updateYtdlpProgress(record, output, progressStart, progressEnd);
    },
  };
}

function getActiveProcessSummary() {
  return Array.from(activeProcesses.entries()).map(([id, context]) => ({
    id,
    type: context.type,
    pid: context.process?.pid || null,
    startedAt: context.startedAt,
  }));
}

function getHeightLimit(quality) {
  const height = Number.parseInt(String(quality || '1080'), 10);
  return Number.isFinite(height) && height > 0 ? height : 1080;
}

function getVideoFormatSelector(height) {
  if (!fastVideoMode) {
    return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
  }

  return [
    `best[height=${height}][ext=mp4]`,
    `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
    `best[height<=${height}][ext=mp4]`,
    `bestvideo[height<=${height}]+bestaudio`,
    `best[height<=${height}]`,
    'best',
  ].join('/');
}

function getYtdlpSpeedArgs() {
  const args = [
    ...(ytdlpIgnoreConfig ? ['--ignore-config'] : []),
    '--no-color',
    '--concurrent-fragments', String(downloadFragments),
    '--http-chunk-size', downloadHttpChunkSize,
    '--buffer-size', downloadBufferSize,
    '--resize-buffer',
    ...(useHlsMpegTs ? ['--hls-use-mpegts'] : []),
    ...(skipUnavailableFragments ? ['--skip-unavailable-fragments'] : []),
    // Only set throttled-rate when explicitly configured.
    ...(downloadThrottledRate ? ['--throttled-rate', downloadThrottledRate] : []),
    '--retries', '20',
    '--fragment-retries', '20',
    '--file-access-retries', '10',
    '--extractor-retries', '10',
    '--socket-timeout', '30',
    '--newline',
    '--no-mtime',
    '--no-playlist',
  ];

  if (ytdlpHeaders.length) {
    for (const header of ytdlpHeaders) {
      args.push('--add-headers', header);
    }
  }

  if (externalDownloader) {
    args.push('--downloader', externalDownloader);
    if (externalDownloaderArgs) {
      args.push('--downloader-args', externalDownloaderArgs);
    }
  }

  return args;
}

function getYtdlpJsRuntimeArgs() {
  return ytdlpJsRuntime ? ['--js-runtimes', ytdlpJsRuntime] : [];
}

function getYtdlpJsRuntimeOptions() {
  return ytdlpJsRuntime ? { jsRuntimes: ytdlpJsRuntime } : {};
}

function hasTrim(record) {
  return Boolean(
    (record.startTime && record.startTime !== '00:00:00')
    || (record.endTime && record.endTime !== '00:00:00'),
  );
}

function getTrimStart(record) {
  return record.startTime && record.startTime !== '00:00:00' ? record.startTime : '00:00:00';
}

function getTrimEnd(record) {
  return record.endTime && record.endTime !== '00:00:00' ? record.endTime : null;
}

function getSectionValue(record) {
  return `*${getTrimStart(record)}-${getTrimEnd(record) || 'inf'}`;
}

function getSectionDownloadArgs(record, forceKeyframes = forceKeyframesAtCuts) {
  if (!sectionDownloadMode || !hasTrim(record)) return [];
  return [
    '--download-sections', getSectionValue(record),
    ...(forceKeyframes ? ['--force-keyframes-at-cuts'] : []),
  ];
}

async function findDownloadedFile(id, extensions, root = tempRoot) {
  for (const ext of extensions) {
    const candidate = path.join(root, `${id}.${ext}`);
    if (await fs.pathExists(candidate)) return candidate;
  }

  const files = await fs.readdir(root);
  const prefix = `${id}.`;
  const match = files.find((file) => file.startsWith(prefix) && !file.endsWith('.part'));
  return match ? path.join(root, match) : null;
}

async function cleanupTempFiles(id) {
  const files = await fs.readdir(tempRoot);
  await Promise.all(files
    .filter((file) => file.startsWith(`${id}.`))
    .map((file) => fs.remove(path.join(tempRoot, file))));
}

async function cleanupSiblingFiles(id, root, keepPath) {
  const files = await fs.readdir(root);
  const keep = keepPath ? path.resolve(keepPath) : '';
  await Promise.all(files
    .filter((file) => file.startsWith(`${id}.`))
    .map((file) => path.join(root, file))
    .filter((filePath) => path.resolve(filePath) !== keep)
    .map((filePath) => fs.remove(filePath)));
}

function getTrimDuration(record) {
  if (!record.endTime || record.endTime === '00:00:00') return null;
  return String(parseTimeToSeconds(record.endTime) - parseTimeToSeconds(record.startTime || '00:00:00'));
}

function addFastTrimArgs(args, record, alreadySectioned = false) {
  if (!alreadySectioned && record.startTime && record.startTime !== '00:00:00') {
    args.push('-ss', record.startTime);
  }
  const trimDuration = getTrimDuration(record);
  if (trimDuration) {
    args.push('-t', trimDuration);
  }
}

function getRangeDuration(startTime, endTime) {
  if (!endTime || endTime === '00:00:00') return 0;
  return parseTimeToSeconds(endTime) - parseTimeToSeconds(startTime || '00:00:00');
}

function getPreviewFormatSelector(type, quality) {
  if (type === 'audio') return 'bestaudio[ext=m4a]/bestaudio/best';
  const height = Math.min(getHeightLimit(quality || '480p'), 720);
  return [
    `best[height<=${height}][ext=mp4]`,
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
    `best[height<=${height}]`,
    'best',
  ].join('/');
}

function registerPreviewFile(filePath, type) {
  const id = path.basename(filePath, path.extname(filePath));
  const ttlMs = 10 * 60 * 1000;
  previewFiles.set(id, {
    id,
    type,
    path: filePath,
    expiresAt: Date.now() + ttlMs,
  });
  setTimeout(async () => {
    const preview = previewFiles.get(id);
    if (!preview || preview.path !== filePath) return;
    previewFiles.delete(id);
    await fs.remove(filePath);
  }, ttlMs).unref?.();
  return id;
}

function isValidYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return parsed.protocol === 'https:' && (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be');
  } catch {
    return false;
  }
}

function createDownloadRecord(type, title, quality, url) {
  const id = uuidv4();
  return {
    id,
    type,
    title: sanitizeFileName(title || 'download'),
    quality,
    url,
    createdAt: new Date().toISOString(),
    status: 'queued',
    progress: 0,
    path: null,
    thumbnail: null,
  };
}

async function analyzeVideo(req, res) {
  try {
    console.log('[analyzeVideo] incoming', { method: req.method, url: req.originalUrl, headers: req.headers['content-type'], body: req.body });
    const { url } = req.body;
    if (!isValidYouTubeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL.' });
    }

    const data = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
      ignoreConfig: true,
      ...getYtdlpJsRuntimeOptions(),
    });
    const formats = Array.isArray(data.formats) ? data.formats : [];
    const videoQualities = [...new Set(formats
      .filter((f) => f.vcodec !== 'none' && Number.isFinite(f.height) && f.height >= 144)
      .map((f) => `${f.height}p`))]
      .sort((a, b) => Number(b.slice(0, -1)) - Number(a.slice(0, -1)));
    const audioStreams = formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none').map((f) => ({
      bitrate: f.tbr || 128,
      format_id: f.format_id,
      ext: f.ext || 'm4a',
    }));

    res.json({
      id: data.id || null,
      title: data.title,
      thumbnail: data.thumbnail || null,
      duration: formatSeconds(data.duration || 0),
      channel: data.uploader || data.channel || 'Unknown',
      views: data.view_count || 0,
      uploadDate: data.upload_date || 'Unknown',
      description: data.description || '',
      formats,
      qualities: videoQualities,
      audioStreams,
      videoSize: data.filesize || null,
      audioSize: null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to analyze the video right now.' });
  }
}

async function startVideoDownload(req, res) {
  try {
    const { url, quality, startTime, endTime, title } = req.body;
    if (!isValidYouTubeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL.' });
    }

    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return res.status(400).json({ error: 'Use time format HH:MM:SS.' });
    }
    if (!isValidTrimRange(startTime, endTime)) {
      return res.status(400).json({ error: 'End time must be later than start time.' });
    }
    const record = createDownloadRecord('video', title || 'video', quality, url);
    record.status = 'queued';
    record.startTime = startTime || null;
    record.endTime = endTime || null;
    queues.push(record);

    res.json({ downloadId: record.id });

    scheduleDownloads();
  } catch (error) {
    res.status(500).json({ error: 'Unable to start video download.' });
  }
}

async function startAudioDownload(req, res) {
  try {
    const { url, bitrate, startTime, endTime, title } = req.body;
    if (!isValidYouTubeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL.' });
    }

    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return res.status(400).json({ error: 'Use time format HH:MM:SS.' });
    }
    if (!isValidTrimRange(startTime, endTime)) {
      return res.status(400).json({ error: 'End time must be later than start time.' });
    }
    const record = createDownloadRecord('audio', title || 'audio', bitrate, url);
    record.startTime = startTime || null;
    record.endTime = endTime || null;
    queues.push(record);

    res.json({ downloadId: record.id });

    scheduleDownloads();
  } catch (error) {
    res.status(500).json({ error: 'Unable to start audio download.' });
  }
}

function isValidTrimRange(startTime, endTime) {
  if (!endTime || endTime === '00:00:00') return true;
  return parseTimeToSeconds(endTime) > parseTimeToSeconds(startTime || '00:00:00');
}

function scheduleDownloads() {
  while (runningDownloads < maxDownloads) {
    const record = queues.find((item) => item.status === 'queued');
    if (!record) return;
    runningDownloads += 1;
    const processor = record.type === 'video' ? processVideoDownload : processAudioDownload;
    processor(record).finally(() => {
      runningDownloads -= 1;
      scheduleDownloads();
    });
  }
}

async function processVideoDownload(record) {
  const tempFile = path.join(tempRoot, `${record.id}.%(ext)s`);
  const outputFile = path.join(downloadRoot, `${record.id}.mp4`);
  const context = createActiveContext(record, 'video');

  record.status = 'preparing';
  setDownloadProgress(record, 3);

  try {
    record.status = 'downloading';
    const heightFilter = getHeightLimit(record.quality);
    const isTrimRequested = hasTrim(record);
    const usesSectionDownload = isTrimRequested && sectionDownloadMode;
    const ytdlpArgs = [
      '--format', getVideoFormatSelector(heightFilter),
      '--merge-output-format', 'mp4',
      '--output', tempFile,
      '--ffmpeg-location', ffmpegPath,
      ...getYtdlpJsRuntimeArgs(),
      ...getSectionDownloadArgs(record),
      ...getYtdlpSpeedArgs(),
      record.url,
    ];
    console.log('[downloadController] starting video download', { id: record.id, url: record.url, args: ytdlpArgs.slice(0, 10) });
    await runCommand(ytdlpPath, ytdlpArgs, commandOptionsFor(record, context, 5, 86));
    if (isCancelled(record)) return;

    // Locate the actual downloaded temporary file.
    const tempInput = await findDownloadedFile(record.id, ['mp4', 'mkv', 'webm']);
    if (!tempInput) throw new Error('Downloaded video file not found in the temporary folder.');

    // A full download has already been merged into MP4 by yt-dlp. Moving it
    // avoids a second, slow full-video re-encode. Cropped files still pass
    // through FFmpeg so the final file duration is capped consistently.
    if (!isTrimRequested && path.extname(tempInput).toLowerCase() === '.mp4') {
      record.status = 'processing';
      setDownloadProgress(record, 94);
      await fs.move(tempInput, outputFile, { overwrite: true });
      record.status = 'completed';
      record.path = outputFile;
      record.progress = 100;
      return;
    }

    const fastCopyArgs = [];
    addFastTrimArgs(fastCopyArgs, record, usesSectionDownload);
    fastCopyArgs.push(
      '-i', tempInput,
      '-map', '0',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      outputFile,
    );

    const encodeArgs = [];
    addFastTrimArgs(encodeArgs, record, usesSectionDownload);
    encodeArgs.push(
      '-i', tempInput,
      '-threads', '0',
      '-c:v', 'libx264',
      '-preset', ffmpegVideoPreset,
      '-crf', '23',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-y',
      outputFile,
    );

    // Convert the temporary file to a predictable MP4 output.
    if (tempInput !== outputFile) {
      record.status = 'processing';
      setDownloadProgress(record, 90);
      const ffmpegOptions = {
        cwd: process.cwd(),
        signal: context.controller.signal,
        cancelMessage: 'Download cancelled.',
        onProcess: (child) => {
          context.process = child;
        },
      };

      if (fastTrimMode) {
        try {
          await runCommand(ffmpegPath, fastCopyArgs, ffmpegOptions);
        } catch (error) {
          if (isCancelled(record) || isCancelledError(error)) throw error;
          await runCommand(ffmpegPath, encodeArgs, ffmpegOptions);
        }
      } else {
        await runCommand(ffmpegPath, encodeArgs, ffmpegOptions);
      }
      if (isCancelled(record)) return;
    }

    record.status = 'completed';
    record.path = outputFile;
    record.progress = 100;
  } catch (error) {
    if (isCancelled(record) || isCancelledError(error)) {
      record.status = 'cancelled';
      record.error = 'Download cancelled.';
    } else {
      record.status = 'failed';
      record.error = error.message;
    }
  } finally {
    activeProcesses.delete(record.id);
    await cleanupTempFiles(record.id);
  }
}

async function processAudioDownload(record) {
  const tempFile = path.join(tempRoot, `${record.id}.%(ext)s`);
  const context = createActiveContext(record, 'audio');

  record.status = 'preparing';
  setDownloadProgress(record, 3);

  try {
    record.status = 'downloading';
    const isTrimRequested = hasTrim(record);
    const usesSectionDownload = isTrimRequested && sectionDownloadMode;
    const ytdlpArgs = [
      '--format', 'bestaudio[ext=m4a]/bestaudio/best',
      '--output', tempFile,
      ...getYtdlpJsRuntimeArgs(),
      ...getSectionDownloadArgs(record),
      ...getYtdlpSpeedArgs(),
      record.url,
    ];
    console.log('[downloadController] starting audio download', { id: record.id, url: record.url, args: ytdlpArgs.slice(0, 8) });
    await runCommand(ytdlpPath, ytdlpArgs, commandOptionsFor(record, context, 5, 78));
    if (isCancelled(record)) return;

    // Find whatever file yt-dlp actually saved
    const tempInput = await findDownloadedFile(record.id, ['m4a', 'webm', 'mp4', 'opus', 'ogg']);

    if (!tempInput) {
      throw new Error('Downloaded audio file not found in temp directory.');
    }

    const wantsOriginalAudio = fastAudioMode && String(record.quality || '').toLowerCase() === 'source';

    if (wantsOriginalAudio) {
      const ext = path.extname(tempInput).toLowerCase().replace('.', '') || 'm4a';
      const sourceOutputFile = path.join(downloadRoot, `${record.id}.${ext}`);

      if (!isTrimRequested) {
        record.status = 'processing';
        setDownloadProgress(record, 94);
        await fs.move(tempInput, sourceOutputFile, { overwrite: true });
        record.status = 'completed';
        record.path = sourceOutputFile;
        record.progress = 100;
        return;
      }

      const copyArgs = [];
      addFastTrimArgs(copyArgs, record, usesSectionDownload);
      copyArgs.push(
        '-i', tempInput,
        '-vn',
        '-c:a', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-y',
        sourceOutputFile,
      );

      record.status = 'processing';
      setDownloadProgress(record, 88);
      await runCommand(ffmpegPath, copyArgs, {
        cwd: process.cwd(),
        signal: context.controller.signal,
        cancelMessage: 'Download cancelled.',
        onProcess: (child) => {
          context.process = child;
        },
      });
      if (isCancelled(record)) return;
      record.status = 'completed';
      record.path = sourceOutputFile;
      record.progress = 100;
      return;
    }

    const outputFile = path.join(downloadRoot, `${record.id}.mp3`);
    const args = [];
    addFastTrimArgs(args, record, usesSectionDownload);
    args.push(
      '-i', tempInput,
      '-vn',
      '-threads', '0',
      '-c:a', 'libmp3lame',
      '-ar', '44100',
      '-ac', '2',
      '-b:a', `${record.quality || '128k'}`,
      '-compression_level', '0',
      '-y',
      outputFile,
    );

    record.status = 'processing';
    setDownloadProgress(record, 86);
    await runCommand(ffmpegPath, args, {
      cwd: process.cwd(),
      signal: context.controller.signal,
      cancelMessage: 'Download cancelled.',
      onProcess: (child) => {
        context.process = child;
      },
    });
    if (isCancelled(record)) return;
    record.status = 'completed';
    record.path = outputFile;
    record.progress = 100;
  } catch (error) {
    if (isCancelled(record) || isCancelledError(error)) {
      record.status = 'cancelled';
      record.error = 'Download cancelled.';
    } else {
      record.status = 'failed';
      record.error = error.message;
    }
  } finally {
    activeProcesses.delete(record.id);
    await cleanupTempFiles(record.id);
  }
}

async function createPreview(req, res) {
  const { type } = req.params;
  const { url, startTime = '00:00:00', endTime, quality = '480p' } = req.body;

  try {
    if (!['video', 'audio'].includes(type)) {
      return res.status(400).json({ error: 'Preview type must be video or audio.' });
    }
    if (!isValidYouTubeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL.' });
    }
    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return res.status(400).json({ error: 'Use time format HH:MM:SS.' });
    }
    if (!endTime || endTime === '00:00:00') {
      return res.status(400).json({ error: 'Choose an end time before previewing a crop.' });
    }
    if (!isValidTrimRange(startTime, endTime)) {
      return res.status(400).json({ error: 'End time must be later than start time.' });
    }

    const duration = getRangeDuration(startTime, endTime);
    if (duration > maxPreviewSeconds) {
      return res.status(400).json({ error: `Preview clips can be up to ${maxPreviewSeconds} seconds.` });
    }

    const id = uuidv4();
    const tempFile = path.join(previewRoot, `${id}.source.%(ext)s`);
    const outputFile = path.join(previewRoot, `${id}.${type === 'video' ? 'mp4' : 'mp3'}`);
    const durationSeconds = getRangeDuration(startTime, endTime);

    const ytdlpArgs = [
      '--format', getPreviewFormatSelector(type, quality),
      '--merge-output-format', type === 'video' ? 'mp4' : 'mkv',
      '--output', tempFile,
      '--ffmpeg-location', ffmpegPath,
      ...getYtdlpJsRuntimeArgs(),
      ...getYtdlpSpeedArgs(),
      url,
    ];
    console.log('[downloadController] starting preview generation', { id, url, args: ytdlpArgs.slice(0, 8) });
    await runCommand(ytdlpPath, ytdlpArgs, { cwd: process.cwd() });

    const tempInput = await findDownloadedFile(id, type === 'video'
      ? ['mp4', 'mkv', 'webm']
      : ['m4a', 'webm', 'mp4', 'opus', 'ogg', 'mkv'], previewRoot);
    if (!tempInput) throw new Error('Preview source file was not created.');

    if (type === 'video') {
      await runCommand(ffmpegPath, [
        '-t', String(durationSeconds),
        '-i', tempInput,
        '-map', '0:v:0?',
        '-map', '0:a:0?',
        '-threads', '0',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero',
        '-y',
        outputFile,
      ], { cwd: process.cwd() });
    } else {
      await runCommand(ffmpegPath, [
        '-t', String(durationSeconds),
        '-i', tempInput,
        '-vn',
        '-threads', '0',
        '-c:a', 'libmp3lame',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', '128k',
        '-compression_level', '0',
        '-y',
        outputFile,
      ], { cwd: process.cwd() });
    }

    await cleanupSiblingFiles(id, previewRoot, outputFile);
    const previewId = registerPreviewFile(outputFile, type);
    res.json({
      previewId,
      previewUrl: `/api/preview/file/${encodeURIComponent(previewId)}`,
      type,
      duration: durationSeconds,
      expiresInSeconds: 600,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to create preview clip right now.' });
  }
}

async function getPreviewFile(req, res) {
  const preview = previewFiles.get(req.params.id);
  if (!preview || preview.expiresAt < Date.now() || !await fs.pathExists(preview.path)) {
    previewFiles.delete(req.params.id);
    return res.status(404).json({ error: 'Preview expired. Create it again.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  res.type(preview.type === 'audio' ? 'audio/mpeg' : 'video/mp4');
  res.sendFile(preview.path);
}

async function getDownload(req, res) {
  const { id } = req.params;
  const record = queues.find((item) => item.id === id);
  if (record?.path && await fs.pathExists(record.path)) {
    return res.download(record.path);
  }

  const filePath = path.join(downloadRoot, `${id}.mp4`);
  if (await fs.pathExists(filePath)) {
    return res.download(filePath);
  }
  const mp3Path = path.join(downloadRoot, `${id}.mp3`);
  if (await fs.pathExists(mp3Path)) {
    return res.download(mp3Path);
  }
  const m4aPath = path.join(downloadRoot, `${id}.m4a`);
  if (await fs.pathExists(m4aPath)) {
    return res.download(m4aPath);
  }
  const webmPath = path.join(downloadRoot, `${id}.webm`);
  if (await fs.pathExists(webmPath)) {
    return res.download(webmPath);
  }
  res.status(404).json({ error: 'File not found.' });
}

function getDownloadStatus(req, res) {
  const record = queues.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Download not found.' });
  res.json({
    id: record.id,
    title: record.title,
    type: record.type,
    quality: record.quality,
    status: record.status,
    progress: record.progress,
    error: record.error || null,
    downloadUrl: record.status === 'completed' ? `/api/download/${record.id}` : null,
  });
}

function cancelDownload(req, res) {
  const record = queues.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Download not found.' });

  if (record.status === 'completed') {
    return res.status(409).json({ error: 'This download is already complete.' });
  }

  if (!cancellableStatuses.has(record.status)) {
    return res.json({ success: true, id: record.id, status: record.status });
  }

  record.cancelRequested = true;
  record.status = 'cancelled';
  record.error = 'Download cancelled.';

  const active = activeProcesses.get(record.id);
  if (active) active.cancel();

  res.json({ success: true, id: record.id, status: record.status, message: record.error });
}

async function deleteDownload(req, res) {
  const { id } = req.params;
  const record = queues.find((item) => item.id === id);
  const targets = [
    record?.path,
    path.join(downloadRoot, `${id}.mp4`),
    path.join(downloadRoot, `${id}.mp3`),
    path.join(downloadRoot, `${id}.m4a`),
    path.join(downloadRoot, `${id}.webm`),
  ].filter(Boolean);
  for (const target of targets) {
    await fs.remove(target);
  }
  res.json({ success: true });
}

module.exports = {
  analyzeVideo,
  startVideoDownload,
  startAudioDownload,
  createPreview,
  getPreviewFile,
  getDownload,
  getDownloadStatus,
  cancelDownload,
  deleteDownload,
  getActiveProcessSummary,
  queues,
  activeProcesses,
};
