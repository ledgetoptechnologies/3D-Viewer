'use strict';

// These are registered input inventories, not arbitrary image assets. Archive
// imports may have no dataset image rows but retain their camera originals on
// the result version. COUNT queries avoid loading photos or walking disk on a
// dashboard request, and the attempt join prevents cross-task attribution.
function taskImageInventory(database, taskId, versionId = null) {
  const datasetCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM dataset_files files
    JOIN processing_tasks task ON task.dataset_id=files.dataset_id
    WHERE task.id=? AND (files.processing_role='image'
      OR (COALESCE(files.processing_role,'auto')='auto' AND COALESCE(files.mime_type,files.content_type) LIKE 'image/%'))
      AND NOT EXISTS (
        SELECT 1 FROM retained_imports retained
        JOIN retained_import_files product ON product.retained_import_id=retained.id
        WHERE retained.dataset_id=files.dataset_id AND product.relative_path=files.relative_path
          AND product.sha256=files.sha256 AND product.role<>'source_photo'
      )
      AND NOT EXISTS (
        SELECT 1 FROM processing_attempts attempt
        JOIN model_assets product ON product.version_id=attempt.result_model_version_id
        JOIN datasets dataset ON dataset.id=files.dataset_id
        WHERE attempt.task_id=task.id AND product.kind IN ('ortho','dsm','dtm')
          AND (product.root_key=dataset.root_key
            OR (dataset.storage_mode='external_reference' AND dataset.root_key=product.root_key||'@'||dataset.id))
          AND product.relative_path=dataset.relative_path||'/'||files.relative_path
          AND product.sha256=files.sha256
      )
  `).get(taskId).count);
  if (datasetCount > 0) return { sourceImageCount: datasetCount, sourceImageCountSource: 'dataset_inputs' };
  const originalCount = versionId ? Number(database.prepare(`
    SELECT COUNT(*) AS count FROM model_camera_photos photos
    WHERE photos.version_id=? AND EXISTS (
      SELECT 1 FROM processing_attempts attempt
      WHERE attempt.task_id=? AND attempt.result_model_version_id=photos.version_id
    )
  `).get(versionId, taskId).count) : 0;
  if (originalCount > 0) return { sourceImageCount: originalCount, sourceImageCountSource: 'registered_camera_originals' };
  // No inventory is not evidence of a zero-image reconstruction.
  return { sourceImageCount: null, sourceImageCountSource: null };
}

module.exports = { taskImageInventory };
