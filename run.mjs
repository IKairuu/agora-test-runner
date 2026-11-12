// Runs one AGORA delivery and writes result.json. Same steps as the old runner (server.mjs):
// clone on the VM, put the locked tests back, install with network, test with NO network,
// both inside throwaway Docker containers with CPU and memory limits.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const IMAGE = process.env.RUNNER_IMAGE || 'node:22-bookworm';
const ALLOWED_HOSTS = ['github.com', 'gitlab.com'];
const t0 = Date.now();

function run(cmd, args, timeout = 9 * 60e3) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20e6, timeout }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`, timedOut: Boolean(err && err.killed) });
    });
  });
}

async function finish(result) {
  await writeFile('result.json', JSON.stringify({ durationMs: Date.now() - t0, ...result }));
  console.log(JSON.stringify({ ...result, diffText: undefined, logTail: undefined }, null, 2));
  process.exit(0);
}

let j;
try {
  j = JSON.parse(Buffer.from(process.env.PAYLOAD || '', 'base64').toString('utf8'));
} catch {
  await finish({ error: 'bad payload' });
}
if (!j.repoUrl || !j.commit || !j.baseCommit) await finish({ error: 'repoUrl, commit and baseCommit are required' });

let host = '';
try { host = new URL(j.repoUrl).hostname; } catch { /* checked below */ }
if (!j.repoUrl.startsWith('https://') || !ALLOWED_HOSTS.includes(host)) await finish({ error: 'repo must be an https GitHub or GitLab URL' });
if (!/^[0-9a-f]{7,40}$/i.test(j.commit) || !/^[0-9a-f]{7,40}$/i.test(j.baseCommit)) await finish({ error: 'commit and baseCommit must be commit hashes' });

const dir = await mkdtemp(path.join(tmpdir(), 'agora-'));
const repo = path.join(dir, 'repo');

// 1) Clone and check out the delivered commit (no repository code runs here)
const clone = await run('git', ['clone', '--quiet', '--no-checkout', j.repoUrl, repo]);
if (clone.code !== 0) await finish({ error: 'clone failed', logTail: clone.out.slice(-6000) });
const co = await run('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', j.commit]);
if (co.code !== 0) await finish({ error: 'checkout failed', logTail: co.out.slice(-6000) });

// 2) What did the seller change compared with the base commit?
const range = `${j.baseCommit}..${j.commit}`;
const names = await run('git', ['-C', repo, 'diff', '--name-only', range]);
const changedFiles = names.out.split('\n').map((s) => s.trim()).filter(Boolean);
const diff = await run('git', ['-C', repo, 'diff', range]);

// 3) Put the LOCKED test files back, so edited tests cannot make a delivery pass
for (const f of j.testFiles || []) {
  const target = path.resolve(repo, f.path);
  if (!target.startsWith(repo + path.sep)) await finish({ error: `test file path escapes the repo: ${f.path}` });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, f.content);
}

// 4) Install with network, then run the tests with no network, 1 CPU and 1 GB RAM
const vol = `${repo}:/w`;
const installCmd = j.buildCommand || 'npm ci --ignore-scripts || npm install --ignore-scripts';
const install = await run('docker', ['run', '--rm', '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
  '-v', vol, '-w', '/w', IMAGE, 'sh', '-c', installCmd]);
const test = await run('docker', ['run', '--rm', '--network', 'none', '--memory', '1g', '--cpus', '1', '--pids-limit', '256',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', vol, '-w', '/w', IMAGE, 'sh', '-c', j.testCommand || 'npm test']);

const log = `## install (exit ${install.code})\n${install.out}\n## test (exit ${test.code})\n${test.out}`;
await finish({
  exitCode: test.code,
  installExit: install.code,
  timedOut: test.timedOut,
  changedFiles,
  diffText: diff.out.slice(0, 20000),
  logSha256: createHash('sha256').update(log).digest('hex'),
  logTail: log.slice(-6000),
  runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
});
