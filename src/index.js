export {
  createUpdateRecovery,
  isChunkLoadError,
  DEFAULT_STORAGE_KEY,
  DEFAULT_RELOAD_PARAM,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_OVERLAY_ID,
  DEFAULT_MESSAGES,
} from './appUpdateRecovery.js'

export {
  armStandaloneViewportFix,
  forceViewportRecompute,
  isStandaloneDisplay,
  isIosDevice,
  expectedViewportHeight,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_STEP_MS,
  DEFAULT_SHORTFALL_TOLERANCE_PX,
} from './standaloneViewportFix.js'

export {
  compressImage,
  fitWithin,
  isImageFile,
  DEFAULT_MAX_EDGE,
  DEFAULT_QUALITY,
  DEFAULT_MIN_QUALITY,
  DEFAULT_TARGET_BYTES,
} from './imageCompress.js'
