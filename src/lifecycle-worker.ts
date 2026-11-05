import { parentPort, workerData } from 'node:worker_threads';
import { OperatorError } from './errors.js';
import { upgradeDeployment } from './upgrade.js';

/**
 * One maintenance-window upgrade runs on its own thread so the Operator Console
 * keeps answering while the coordinated checkpoint, locked migrations, and
 * service restart proceed. Progress is durable: the upgrade record and the
 * migration ledger are written for every step, and this thread only reports the
 * terminal outcome of the attempt it started.
 */
interface UpgradeJobData {
  kind: 'upgrade';
  root: string;
  masterKey: string;
  operator: string;
  bundle: string;
  releaseKey: string;
  confirmedFingerprint: string;
  license?: string;
  backupRoot?: string;
}

function run(data: UpgradeJobData): void {
  try {
    const result = upgradeDeployment({
      root: data.root,
      masterKey: data.masterKey,
      operator: data.operator,
      bundle: data.bundle,
      releaseKey: data.releaseKey,
      confirmedFingerprint: data.confirmedFingerprint,
      ...(data.license === undefined ? {} : { license: data.license }),
      ...(data.backupRoot === undefined ? {} : { backupRoot: data.backupRoot }),
    });
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    if (error instanceof OperatorError) {
      parentPort?.postMessage({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.nextStep === undefined ? {} : { next_step: error.nextStep }),
        },
      });
      return;
    }
    parentPort?.postMessage({
      ok: false,
      error: {
        code: 'LIFECYCLE_JOB_FAILED',
        message: error instanceof Error ? error.message : 'The lifecycle operation failed.',
      },
    });
  }
}

run(workerData as UpgradeJobData);
