import fs from 'node:fs';
import path from 'node:path';

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function firstLines(text, count) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/gu, '').split('\n').filter((line) => line.trim()).slice(0, count);
}

// One line per step on the terminal, everything else in the results folder:
// a run is read by people and agents alike, and Playwright's own output buries
// the one line that says where it stopped.
export default class PathReporter {
  constructor({ resultsDir } = {}) {
    this.resultsDir = resultsDir;
    this.steps = [];
    this.attachments = [];
    this.started = Date.now();
    fs.mkdirSync(resultsDir, { recursive: true });
    this.log = fs.createWriteStream(path.join(resultsDir, 'output.log'), { flags: 'a' });
  }

  printsToStdio() {
    return true;
  }

  onStepBegin(test, result, step) {
    if (step.category !== 'test.step' || step.parent) return;
    this.checks = [];
    console.log(`  → ${step.title}`);
  }

  // A path step's own named steps, such as an app module's, say what the step did.
  onStepEnd(test, result, step) {
    if (step.category !== 'test.step') return;
    if (step.parent) {
      if (step.parent.category === 'test.step' && !step.parent.parent) this.checks.push(`${step.error ? '✗' : '✓'} ${step.title}`);
      return;
    }
    const failed = Boolean(step.error);
    this.steps.push({ checks: this.checks, durationMs: step.duration, error: failed ? firstLines(step.error.message, 12).join('\n') : null, status: failed ? 'failed' : 'passed', title: step.title });
    console.log(`  ${failed ? '✗' : '✓'} ${step.title.padEnd(28)} ${duration(step.duration)}`);
  }

  onStdOut(chunk) {
    this.log.write(chunk);
  }

  onStdErr(chunk) {
    this.log.write(chunk);
  }

  onTestEnd(test, result) {
    this.result = result;
    this.attachments = result.attachments.filter((item) => item.path).map((item) => ({ name: item.name, path: path.relative(process.cwd(), item.path) }));
  }

  onError(error) {
    this.globalError = firstLines(error.message, 12).join('\n');
  }

  async onEnd(fullResult) {
    const result = this.result;
    const status = result?.status === 'passed' ? 'passed' : result ? 'failed' : 'crashed';
    const error = result?.error ? firstLines(result.error.message, 14).join('\n') : this.globalError || null;
    const summary = { attachments: this.attachments, durationMs: Date.now() - this.started, error, status, steps: this.steps };
    fs.writeFileSync(path.join(this.resultsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await new Promise((resolve) => this.log.end(resolve));

    console.log(`\n${status === 'passed' ? 'PASSED' : 'FAILED'} in ${duration(summary.durationMs)} (${fullResult.status})`);
    if (status !== 'passed') {
      const failedStep = this.steps.find((step) => step.status === 'failed');
      if (failedStep) console.log(`Stopped at: ${failedStep.title}`);
      if (error) console.log(error.split('\n').map((line) => `  ${line}`).join('\n'));
      for (const attachment of this.attachments) console.log(`  ${attachment.name}: ${attachment.path}`);
      console.log(`  log: ${path.relative(process.cwd(), path.join(this.resultsDir, 'output.log'))}`);
    }
  }
}
