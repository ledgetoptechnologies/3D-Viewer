'use strict';

// Deliberately deployment-specific, not NODE_ENV-specific: staging runs Node in
// production mode. This is not a general NAS or production admission override.
function isIdentifiedSmbStaging(config) {
  return config.deploymentId === 'staging-192.168.50.90'
    && config.expectedHost === '192.168.50.90'
    && config.publicBaseUrl === 'https://192.168.50.90:8088';
}

function allowUnavailableSmbInodes(config, space) {
  return config.stagingSmbAllowUnavailableInodes === true
    && isIdentifiedSmbStaging(config)
    // Linux SMB2_SUPER_MAGIC, observed from the actual target root's statfs.
    && space.filesystemType === 0xfe534d42
    && space.files === 0 && space.ffree === 0;
}

module.exports = {isIdentifiedSmbStaging, allowUnavailableSmbInodes};
