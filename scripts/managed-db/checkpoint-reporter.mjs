// Vitest reporter for long managed-database runs: appends one JSON line per event to
// CHECKPOINT_FILE and fsyncs it, so results survive an interrupted run. Lines carry
// CHECKPOINT_BATCH and CHECKPOINT_ATTEMPT. Error text is scrubbed of every password found in
// the *_URL environment variables. Read back by scripts/managed-db/s1-report.mjs.
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';

const secrets = Object.entries(process.env)
  .filter(([k, v]) => k.endsWith('_URL') && v)
  .flatMap(([, v]) => {
    try {
      const p = decodeURIComponent(new URL(v).password);
      return p ? [p, encodeURIComponent(p)] : [];
    } catch {
      return [];
    }
  });
const scrub = (s) =>
  secrets
    .reduce((a, x) => a.split(x).join('***'), String(s ?? ''))
    .replace(/postgres(ql)?:\/\/[^\s'"]+/g, '<url>');

export default class CheckpointReporter {
  constructor() {
    this.file = process.env.CHECKPOINT_FILE;
    this.base = {
      batch: process.env.CHECKPOINT_BATCH ?? 'unknown',
      attempt: Number(process.env.CHECKPOINT_ATTEMPT ?? 1),
    };
  }

  write(event) {
    if (!this.file) return;
    const fd = openSync(this.file, 'a');
    try {
      writeSync(
        fd,
        `${JSON.stringify({ ...this.base, at: new Date().toISOString(), ...event })}\n`,
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  onTestRunStart() {
    this.write({ type: 'run-start' });
  }

  onTestModuleCollected(module) {
    for (const t of module.children.allTests())
      this.write({ type: 'collected', id: t.id, file: module.moduleId, name: t.fullName });
  }

  onTestCaseResult(t) {
    const r = t.result();
    this.write({
      type: 'result',
      id: t.id,
      name: t.fullName,
      state: r.state,
      durationMs: t.diagnostic()?.duration ?? null,
      errors: (r.errors ?? []).map((e) => scrub(e.message).slice(0, 2000)),
    });
  }

  onTestModuleEnd(module) {
    this.write({
      type: 'module-end',
      file: module.moduleId,
      state: module.state(),
      errors: module.errors().map((e) => scrub(e.message).slice(0, 2000)),
    });
  }

  onTestRunEnd(_modules, unhandledErrors, reason) {
    this.write({
      type: 'run-end',
      reason,
      unhandledErrors: (unhandledErrors ?? []).map((e) => scrub(e.message).slice(0, 2000)),
    });
  }
}
