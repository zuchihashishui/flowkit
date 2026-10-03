'use strict';
const features = [
  'elevenlabs_native_download_files',
  'elevenlabs_unlimited_native_audio',
  'elevenlabs_recover_downloads',
  'elevenlabs_safe_pre_submit_failures',
  'elevenlabs_auto_prepare_tab'
];
function backendProblem(health) {
  if (health?.studio_api === 3 && features.every(name => health?.studio_features?.[name] === true)) return '';
  const missing = backendProblem.missing(health);
  return 'Backend update required: an older or incompatible backend is using port 8100. ' +
    (missing.length ? 'Missing features: ' + missing.join(', ') + '. ' : 'Unsupported Studio API version. ') +
    'Use Restart local backend below when available, or close the older backend console and restart Studio from the complete updated folder. Existing jobs and downloaded audio are retained.';
};

backendProblem.missing = health => features.filter(name => health?.studio_features?.[name] !== true);
module.exports = backendProblem;
