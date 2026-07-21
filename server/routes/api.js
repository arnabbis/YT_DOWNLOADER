const express = require('express');
const { body, param } = require('express-validator');
const controller = require('../controllers/downloadController');
const { validateRequest } = require('../middleware/validation');

const router = express.Router();

router.post('/analyze', [
  body('url').isString().trim().notEmpty(),
], validateRequest, controller.analyzeVideo);

router.post('/download/video', [
  body('url').isString().trim().notEmpty(),
  body('quality').isString().trim().notEmpty(),
  body('title').optional().isString().trim().isLength({ max: 200 }),
], validateRequest, controller.startVideoDownload);

router.post('/download/audio', [
  body('url').isString().trim().notEmpty(),
  body('bitrate').isString().trim().notEmpty(),
  body('title').optional().isString().trim().isLength({ max: 200 }),
], validateRequest, controller.startAudioDownload);

router.post('/preview/:type', [
  param('type').isIn(['video', 'audio']),
  body('url').isString().trim().notEmpty(),
  body('startTime').optional().isString().trim(),
  body('endTime').optional().isString().trim(),
  body('quality').optional().isString().trim(),
], validateRequest, controller.createPreview);
router.get('/preview/file/:id', [param('id').isString().trim().notEmpty()], validateRequest, controller.getPreviewFile);

router.post('/download/:id/cancel', [param('id').isString().trim().notEmpty()], validateRequest, controller.cancelDownload);
router.get('/download/:id/status', controller.getDownloadStatus);
router.get('/download/:id', controller.getDownload);
router.delete('/delete/:id', [param('id').isString().trim().notEmpty()], validateRequest, controller.deleteDownload);

router.get('/status', (req, res) => {
  res.json({ queues: controller.queues, activeProcesses: controller.getActiveProcessSummary() });
});

module.exports = router;
