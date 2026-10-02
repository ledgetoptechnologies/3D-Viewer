'use strict';

// Deliberately deployment-specific, not NODE_ENV-specific: staging runs Node in
// production mode. This is not a general NAS or production admission override.
function isIdentifiedSmbStaging(config) {
  return config.deploymentId === 'staging-192.168.50.90'
    && ((config.expectedHost === '192.168.50.90'
      && config.publicBaseUrl === 'https://192.168.50.90:8088')
      || (config.expectedHost === 'viewer-staging.ledgetopdroneservices.com'
        && config.publicBaseUrl === 'https://viewer-staging.ledgetopdroneservices.com'));
}

function allowUnavailableSmbInodes(config, space) {
  return config.stagingSmbAllowUnavailableInodes === true
    && isIdentifiedSmbStaging(config)
    // Linux SMB2_SUPER_MAGIC, observed from the actual target root's statfs.
    && space.filesystemType === 0xfe534d42
    && space.files === 0 && space.ffree === 0;
}

// Revalidate the actual filesystem on every conversion tick. An initial
// admission is not permission to ignore later mount or configuration changes.
function hasDerivativeInodeHeadroom(config, space, admission) {
  if (allowUnavailableSmbInodes(config, space)) return true;
  if (!Number.isFinite(space.files) || space.files <= 0
    || !Number.isFinite(space.ffree) || space.ffree < 0
    || space.ffree > space.files) return false;
  const reserve = admission?.inodeReserve === null
    ? Math.min(100000, Math.max(10000, Math.ceil(space.files * 0.05)))
    : admission?.inodeReserve;
  return Number.isFinite(reserve) && reserve >= 0 && space.ffree > reserve;
}

module.exports = {isIdentifiedSmbStaging, allowUnavailableSmbInodes, hasDerivativeInodeHeadroom};
