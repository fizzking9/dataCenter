import { parentPort, workerData } from 'node:worker_threads';
import { readRecoveryManifest, restoreDeployment, verifyRecoverySet } from './backup.js';
import { OperatorError } from './errors.js';
import { readJsonFile, writeJsonFile } from './state.js';
import type { RestorationRecord } from './recovery.js';

/**
 * One isolated restoration, run off the console's event loop. The console keeps
 * answering polls while this worker materializes and verifies the restored copy,
 * and every stage it reaches is written into the same durable record the browser
 * reads, so progress survives a console restart as well.
 */
export interface RestoreWorkerJob {
  targetRoot: string;
  masterKey: string;
  backupRoot: string;
  backupId: string;
  operator: string;
  recordPath: string;
}

const job = workerData as RestoreWorkerJob;

function reportFailure(error: unknown): void {
  const failure = error instanceof OperatorError
    ? {
      code: error.code,
      message: error.message,
      ...(error.nextStep === undefined ? {} : { next_step: error.nextStep }),
    }
    : { code: 'RESTORATION_FAILED', message: error instanceof Error ? error.message : String(error) };
  parentPort?.postMessage({ ok: false, error: failure });
}

try {
  // Integrity is re-proved first, so a damaged set is named before any target
  // directory exists and the durable record states exactly which check failed.
  verifyRecoverySet(job.backupRoot, readRecoveryManifest(job.backupRoot, job.backupId));
  const record = readJsonFile<RestorationRecord>(job.recordPath);
  record.progress.push({ step: 'integrity_verified', outcome: 'succeeded', at: new Date().toISOString() });
  writeJsonFile(job.recordPath, record);

  const restored = restoreDeployment({
    root: job.targetRoot,
    masterKey: job.masterKey,
    operator: job.operator,
    backupRoot: job.backupRoot,
    backupId: job.backupId,
  });
  parentPort?.postMessage({ ok: true, restored });
} catch (error) {
  reportFailure(error);
}
