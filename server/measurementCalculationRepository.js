'use strict';
const crypto = require('node:crypto');
const problem = (code, status = 400) => Object.assign(new Error(code), { code, status });
class MeasurementCalculationRepository {
  constructor(database) { this.database = database; }
  transaction(fn) { this.database.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.database.exec('COMMIT'); return result; } catch (e) { this.database.exec('ROLLBACK'); throw e; } }
  enqueue(measurement, request) {
    return this.transaction(() => {
      const current = this.database.prepare('SELECT revision FROM private_measurements WHERE id=? AND deleted_at IS NULL').get(measurement.id);
      if (current?.revision !== measurement.revision) throw problem('measurement_revision_conflict', 409);
      const active = this.database.prepare("SELECT count(*) n FROM measurement_calculation_jobs WHERE status IN ('queued','running')").get().n;
      if (active >= 20) throw problem('measurement_queue_full', 429);
      const prior = this.database.prepare("SELECT * FROM measurement_calculation_jobs WHERE measurement_id=? AND revision=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(measurement.id, measurement.revision);
      if (prior) throw problem('measurement_calculation_already_active', 409);
      const id = crypto.randomUUID(), at = new Date().toISOString();
      // Keep at most twenty terminal calculations per record. Retain the
      // numerical provenance with each remaining result, not unbounded private
      // geometry/capability snapshots from every historical button press.
      this.database.prepare("DELETE FROM measurement_calculation_jobs WHERE measurement_id=? AND status NOT IN ('queued','running') AND id NOT IN (SELECT id FROM measurement_calculation_jobs WHERE measurement_id=? AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 19)").run(measurement.id, measurement.id);
      this.database.prepare("INSERT INTO measurement_calculation_jobs(id,measurement_id,revision,request_json,status,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)").run(id, measurement.id, measurement.revision, JSON.stringify(request), at, at);
      return this.get(measurement.id, id);
    });
  }
  get(measurementId, id) {
    const row = this.database.prepare('SELECT j.* FROM measurement_calculation_jobs j JOIN private_measurements m ON m.id=j.measurement_id WHERE j.id=? AND j.measurement_id=? AND m.deleted_at IS NULL').get(id, measurementId);
    return row ? { id: row.id, measurementId: row.measurement_id, revision: row.revision, status: row.status, result: row.result_json ? JSON.parse(row.result_json) : null, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  list(measurementId) {
    return this.database.prepare('SELECT j.id FROM measurement_calculation_jobs j JOIN private_measurements m ON m.id=j.measurement_id WHERE j.measurement_id=? AND m.deleted_at IS NULL ORDER BY j.created_at DESC,j.id DESC LIMIT 20').all(measurementId).map(row => this.get(measurementId, row.id));
  }
  cancel(measurementId, id) {
    return this.database.prepare("UPDATE measurement_calculation_jobs SET request_json=json_remove(request_json,'$.authority'),status='cancelled',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND measurement_id=? AND status IN ('queued','running')").run(new Date().toISOString(), id, measurementId).changes === 1;
  }
  claim(owner, at = Date.now()) {
    return this.transaction(() => {
      const time = new Date(at).toISOString();
      // Do not automatically replay a heavy job after process death. Its source
      // and authorization must be explicitly submitted again by the owner.
      this.database.prepare("UPDATE measurement_calculation_jobs SET request_json=json_remove(request_json,'$.authority'),status='failed',error_code='worker_interrupted',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE status='running' AND lease_expires_at<=?").run(time, time);
      if (this.database.prepare("SELECT 1 FROM measurement_calculation_jobs WHERE status='running' LIMIT 1").get()) return null;
      // Reserve measurements only while existing processing lanes have no work
      // leased. Worker dispatch also prevents newly starting heavy local lanes.
      for (const table of ['dataset_operations','processing_jobs','derivative_jobs']) if (this.database.prepare(`SELECT 1 FROM ${table} WHERE status='leased' LIMIT 1`).get()) return null;
      this.database.prepare("UPDATE measurement_calculation_jobs SET request_json=json_remove(request_json,'$.authority'),status='cancelled',updated_at=? WHERE status='queued' AND NOT EXISTS(SELECT 1 FROM private_measurements m WHERE m.id=measurement_calculation_jobs.measurement_id AND m.revision=measurement_calculation_jobs.revision AND m.deleted_at IS NULL)").run(time);
      const row = this.database.prepare("SELECT * FROM measurement_calculation_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
      if (!row) return null;
      const token = crypto.randomUUID();
      this.database.prepare("UPDATE measurement_calculation_jobs SET status='running',lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?").run(owner, token, new Date(at + 90_000).toISOString(), time, row.id);
      return { id: row.id, measurementId: row.measurement_id, revision: row.revision, request: JSON.parse(row.request_json), token };
    });
  }
  live(job, owner, at = Date.now()) {
    return Boolean(this.database.prepare("SELECT 1 FROM measurement_calculation_jobs j JOIN private_measurements m ON m.id=j.measurement_id WHERE j.id=? AND j.status='running' AND j.lease_owner=? AND j.lease_token=? AND j.lease_expires_at>? AND m.deleted_at IS NULL AND m.revision=j.revision").get(job.id, owner, job.token, new Date(at).toISOString()));
  }
  heartbeat(job, owner) {
    if (!this.live(job, owner)) return false;
    return this.database.prepare("UPDATE measurement_calculation_jobs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?").run(new Date(Date.now() + 90_000).toISOString(), job.id, owner, job.token).changes === 1;
  }
  finish(job, owner, result, errorCode = null) {
    return this.transaction(() => {
      if (!this.live(job, owner)) return false;
      return this.database.prepare("UPDATE measurement_calculation_jobs SET status=?,result_json=?,error_code=?,request_json=json_remove(request_json,'$.authority'),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=? AND lease_token=?").run(errorCode ? 'failed' : 'complete', result ? JSON.stringify(result) : null, errorCode, new Date().toISOString(), job.id, owner, job.token).changes === 1;
    });
  }
}
module.exports = { MeasurementCalculationRepository };
