'use strict';
const crypto = require('node:crypto');

function recoveryScratchRelative(operation, targetRelativePath) {
  const generation = crypto.createHash('sha256').update(`${operation.lease_owner}\n${operation.attempt_count}`).digest('hex').slice(0,24);
  return `${targetRelativePath}.recovery-${operation.id}-${generation}.incomplete`;
}

// Keep the ownership check and synchronous filesystem mutation under the same
// SQLite write lock: a successor cannot reclaim between validation and rename/delete.
function withRecoveryMaterializationLease(operation, processing, action) {
  return processing.transaction(() => {
    const live = processing.database.prepare("SELECT 1 FROM dataset_operations WHERE id=? AND status='leased' AND lease_owner=? AND attempt_count=? AND lease_expires_at>?")
      .get(operation.id, operation.lease_owner, operation.attempt_count, new Date().toISOString());
    if (!live) throw Object.assign(new Error('Recovery materialization lease was lost'), { code:'operation_lease_lost' });
    return action();
  });
}
module.exports = { recoveryScratchRelative, withRecoveryMaterializationLease };
