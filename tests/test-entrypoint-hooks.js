const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const dockerfilePath = path.join(rootDir, 'Dockerfile');
const entrypointPath = path.join(rootDir, 'entrypoint.sh');
const composePath = path.join(rootDir, 'docker-compose.yml');

test('Start-Time Init Hooks - Configuration & Static Checks', async (t) => {
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
    const entrypointContent = fs.readFileSync(entrypointPath, 'utf8');
    const composeContent = fs.readFileSync(composePath, 'utf8');

    await t.test('Dockerfile provisions /etc/entrypoint.d/async directory without sudo modifications', () => {
        assert.match(dockerfileContent, /\/etc\/entrypoint\.d\/async/, 'Dockerfile should create /etc/entrypoint.d/async');
        assert.doesNotMatch(dockerfileContent, /sudoers\.d/, 'Dockerfile must not grant passwordless sudo');
    });

    await t.test('entrypoint.sh loops over *.sh for synchronous and asynchronous hooks', () => {
        assert.match(entrypointContent, /for script in \/etc\/entrypoint\.d\/\*\.sh/, 'entrypoint.sh should glob sync *.sh');
        assert.match(entrypointContent, /for script in \/etc\/entrypoint\.d\/async\/\*\.sh/, 'entrypoint.sh should glob async *.sh');
    });

    await t.test('docker-compose.yml includes commented volume mount for /etc/entrypoint.d', () => {
        assert.match(composeContent, /#\s+-\s+\.\/init-scripts:\/etc\/entrypoint\.d:ro/, 'docker-compose.yml should include example mount');
    });
});

test('Start-Time Init Hooks - Functional Simulation', async (t) => {
    const entrypointContent = fs.readFileSync(entrypointPath, 'utf8');
    const hookBlockMatch = entrypointContent.match(/(# 5\. Start-Time Initialization Hooks[\s\S]*?)# 6\. Mode dispatch/);
    assert.ok(hookBlockMatch, 'Could not find init-hooks block in entrypoint.sh');
    const hookScriptTemplate = hookBlockMatch[1];

    await t.test('executes synchronous hooks in alphanumeric order and spawns async hooks to background', async () => {
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-test-'));
        const mockHooksDir = path.join(tempBase, 'entrypoint.d');
        const mockAsyncDir = path.join(mockHooksDir, 'async');
        fs.mkdirSync(mockAsyncDir, { recursive: true });

        const recordFile = path.join(tempBase, 'execution-order.txt');

        // Create sync hooks
        fs.writeFileSync(path.join(mockHooksDir, '02-second.sh'), `#!/usr/bin/env bash\necho "second" >> "${recordFile}"\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(mockHooksDir, '01-first.sh'), `#!/usr/bin/env bash\necho "first" >> "${recordFile}"\n`, { mode: 0o755 });
        // Create non-.sh file that should be ignored
        fs.writeFileSync(path.join(mockHooksDir, 'ignored.txt'), `echo "ignore" >> "${recordFile}"\n`);
        
        // Create async hook
        const asyncRecordFile = path.join(tempBase, 'async-output.txt');
        fs.writeFileSync(path.join(mockAsyncDir, '01-bg.sh'), `#!/usr/bin/env bash\necho "async running" >> "${asyncRecordFile}"\n`, { mode: 0o755 });

        // Build standalone test runner script with mock paths
        const runnerScript = `#!/usr/bin/env bash
set -e
${hookScriptTemplate.replace(/\/etc\/entrypoint\.d\/async\/\*\.sh/g, `${mockAsyncDir}/*.sh`).replace(/\/etc\/entrypoint\.d\/\*\.sh/g, `${mockHooksDir}/*.sh`)}
`;

        const runnerPath = path.join(tempBase, 'run-hooks.sh');
        fs.writeFileSync(runnerPath, runnerScript, { mode: 0o755 });

        const res = spawnSync('bash', [runnerPath], { encoding: 'utf8' });
        assert.equal(res.status, 0, `Runner script failed: ${res.stderr}\n${res.stdout}`);

        // Verify sync execution order
        assert.ok(fs.existsSync(recordFile), 'Sync execution record file should exist');
        const syncLines = fs.readFileSync(recordFile, 'utf8').trim().split('\n');
        assert.deepEqual(syncLines, ['first', 'second'], 'Sync scripts must execute in alphanumeric order');

        // Wait up to 2 seconds for async execution to complete
        const start = Date.now();
        while (!fs.existsSync(asyncRecordFile) && Date.now() - start < 2000) {
            await new Promise(r => setTimeout(r, 50));
        }

        assert.ok(fs.existsSync(asyncRecordFile), 'Async hook must execute and produce output');
        assert.equal(fs.readFileSync(asyncRecordFile, 'utf8').trim(), 'async running');

        fs.rmSync(tempBase, { recursive: true, force: true });
    });

    await t.test('handles non-zero exit codes in hooks gracefully without terminating runner', () => {
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-fail-test-'));
        const mockHooksDir = path.join(tempBase, 'entrypoint.d');
        const mockAsyncDir = path.join(mockHooksDir, 'async');
        fs.mkdirSync(mockAsyncDir, { recursive: true });

        const markerFile = path.join(tempBase, 'after-fail.txt');

        fs.writeFileSync(path.join(mockHooksDir, '01-fail.sh'), `#!/usr/bin/env bash\nexit 1\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(mockHooksDir, '02-pass.sh'), `#!/usr/bin/env bash\necho "passed" > "${markerFile}"\n`, { mode: 0o755 });

        const runnerScript = `#!/usr/bin/env bash
set -e
${hookScriptTemplate.replace(/\/etc\/entrypoint\.d\/async\/\*\.sh/g, `${mockAsyncDir}/*.sh`).replace(/\/etc\/entrypoint\.d\/\*\.sh/g, `${mockHooksDir}/*.sh`)}
`;

        const runnerPath = path.join(tempBase, 'run-hooks.sh');
        fs.writeFileSync(runnerPath, runnerScript, { mode: 0o755 });

        const res = spawnSync('bash', [runnerPath], { encoding: 'utf8' });
        assert.equal(res.status, 0, `Runner should not crash on hook exit code 1: ${res.stderr}`);
        assert.ok(fs.existsSync(markerFile), 'Subsequent hook should execute even after earlier hook returns non-zero');
        assert.match(res.stdout, /Warning: 01-fail\.sh exited with code 1/, 'Should log warning for failed hook');

        fs.rmSync(tempBase, { recursive: true, force: true });
    });

    await t.test('handles non-existent hook directories cleanly', () => {
        const nonExistentBase = path.join(os.tmpdir(), 'non-existent-' + Date.now());
        const runnerScript = `#!/usr/bin/env bash
set -e
${hookScriptTemplate.replace(/\/etc\/entrypoint\.d\/async\/\*\.sh/g, `${nonExistentBase}/async/*.sh`).replace(/\/etc\/entrypoint\.d\/\*\.sh/g, `${nonExistentBase}/*.sh`)}
`;
        const res = spawnSync('bash', ['-c', runnerScript], { encoding: 'utf8' });
        assert.equal(res.status, 0, `Runner should succeed without errors when directories do not exist: ${res.stderr}`);
    });
});
