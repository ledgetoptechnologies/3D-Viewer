import fs from 'node:fs';
import crypto from 'node:crypto';

function identity(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Converter fixture must be a regular file');
  return {
    size: stat.size, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

// Only for newly created runtime-test fixtures, never retained application data.
export function sealConverterFixture(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Converter fixture is empty');
  const snapshots = files.map((file) => {
    identity(file); // Refuse symlinks before chmod.
    fs.chmodSync(file, 0o440);
    const snapshot = identity(file);
    if (process.platform !== 'win32' && snapshot.mode !== 0o440) throw new Error('Converter fixture sealing failed');
    return { file, snapshot };
  });
  return () => {
    for (const { file, snapshot } of snapshots) {
      const current = identity(file);
      if (Object.keys(snapshot).some((key) => current[key] !== snapshot[key])) {
        throw new Error('Converter changed a sealed source fixture');
      }
    }
    return snapshots.length;
  };
}
