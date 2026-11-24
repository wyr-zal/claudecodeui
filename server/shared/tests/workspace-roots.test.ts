import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// 放在源码目录旁，避免 /tmp 的系统目录保护干扰实际目录边界测试。
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = await realpath(await mkdtemp(path.join(testDirectory, 'workspace-roots-fixture-')));
const homeRoot = path.join(fixtureRoot, 'home');
const firstExtraRoot = path.join(fixtureRoot, 'projects');
const secondExtraRoot = path.join(fixtureRoot, 'projects with spaces');
const outsideRoot = path.join(fixtureRoot, 'outside');
const missingRoot = path.join(fixtureRoot, 'unmounted');
await Promise.all([homeRoot, firstExtraRoot, secondExtraRoot, outsideRoot]
  .map((root) => mkdir(root)));

const environmentKeys = ['HOME', 'USERPROFILE', 'WORKSPACES_ROOT', 'WORKSPACES_EXTRA_ROOTS'] as const;
const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
process.env.HOME = homeRoot;
process.env.USERPROFILE = homeRoot;
process.env.WORKSPACES_ROOT = homeRoot;
process.env.WORKSPACES_EXTRA_ROOTS = [
  '', missingRoot, ` ${firstExtraRoot} `, secondExtraRoot, firstExtraRoot, 'relative-root', '',
].join(path.delimiter);

const { resolvePathUnderRoots, resolveWorkspacePathForHost, validateWorkspacePath, WORKSPACES_ROOT } = await import('@/shared/utils.js');

after(async () => {
  for (const key of environmentKeys) {
    const previousValue = previousEnvironment[key];
    if (previousValue === undefined) delete process.env[key];
    else process.env[key] = previousValue;
  }
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('保留默认目录及原有单目录配置', async () => {
  assert.equal(WORKSPACES_ROOT, homeRoot);
  assert.deepEqual(await validateWorkspacePath(path.join(homeRoot, 'app')), {
    valid: true, resolvedPath: path.join(homeRoot, 'app'),
  });
});

test('多个额外根目录、空白、空项和重复项均可正确处理', async () => {
  for (const root of [firstExtraRoot, secondExtraRoot]) {
    assert.deepEqual(await validateWorkspacePath(path.join(root, 'app')), {
      valid: true, resolvedPath: path.join(root, 'app'),
    });
  }
});

test('未挂载的额外目录不会阻止后续有效目录，也不会自动获准', async () => {
  assert.equal((await validateWorkspacePath(path.join(secondExtraRoot, 'app'))).valid, true);
  assert.equal((await validateWorkspacePath(path.join(missingRoot, 'app'))).valid, false);
});

test('允许额外根目录本身及多层尚未创建的项目目录', async () => {
  assert.equal((await validateWorkspacePath(firstExtraRoot)).valid, true);
  const target = path.join(firstExtraRoot, 'new', 'nested', 'app');
  assert.deepEqual(await validateWorkspacePath(target), { valid: true, resolvedPath: target });
});

test('拒绝同名前缀的兄弟目录', async () => {
  const validation = await validateWorkspacePath(`${firstExtraRoot}-other`);
  assert.equal(validation.valid, false);
  assert.match(validation.error || '', /allowed workspace root/);
});

test('拒绝未配置的目录与跳出允许目录的路径', async () => {
  for (const target of [outsideRoot, path.join(firstExtraRoot, '..', 'outside', 'app')]) {
    assert.equal((await validateWorkspacePath(target)).valid, false);
  }
});

test('相对额外根目录不会被展开为 cwd 的授权', async () => {
  assert.equal((await validateWorkspacePath(path.resolve('relative-root', 'app'))).valid, false);
});

test('拒绝指向允许范围外的目录链接以及链接下多层新目录', async () => {
  const escapeLink = path.join(firstExtraRoot, 'escape');
  await symlink(outsideRoot, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [escapeLink, path.join(escapeLink, 'new', 'nested', 'app')]) {
    assert.equal((await validateWorkspacePath(target)).valid, false);
  }
});

test('断开的目录链接及其下的新目录不会被当作普通新目录放行', async () => {
  const danglingLink = path.join(firstExtraRoot, 'dangling');
  await symlink(missingRoot, danglingLink, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [danglingLink, path.join(danglingLink, 'new', 'app')]) {
    assert.equal((await validateWorkspacePath(target)).valid, false);
  }
});

test('允许指向另一个已授权根目录的链接并返回真实路径', async () => {
  const allowedLink = path.join(homeRoot, 'other-projects');
  await symlink(firstExtraRoot, allowedLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await validateWorkspacePath(path.join(allowedLink, 'new', 'app')), {
    valid: true, resolvedPath: path.join(firstExtraRoot, 'new', 'app'),
  });
});

test('系统目录及指向系统目录的链接仍被拒绝', async () => {
  const systemRoot = process.platform === 'win32' ? (process.env.SystemRoot || 'C:\\Windows') : '/etc';
  const canonicalSystemRoot = await realpath(systemRoot);
  const systemLink = path.join(homeRoot, 'system-link');
  await symlink(systemRoot, systemLink, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [systemRoot, canonicalSystemRoot, systemLink]) {
    const validation = await validateWorkspacePath(target);
    assert.equal(validation.valid, false);
    assert.match(validation.error || '', /system directory|system-critical/);
  }
});

test('enforces canonical system directories and /var exceptions when parent roots are configured', { skip: process.platform === 'win32' }, async () => {
  const canonicalEtc = await realpath('/etc');
  const canonicalVarTmp = await realpath('/var/tmp');
  const canonicalVarFolders = process.platform === 'darwin' ? await realpath('/var/folders') : null;
  const extraRoots = [path.dirname(canonicalEtc), canonicalVarTmp, ...(canonicalVarFolders ? [canonicalVarFolders] : [])];
  const script = `
    const { validateWorkspacePath } = await import(${JSON.stringify(new URL('../utils.ts', import.meta.url).href)});
    console.log(JSON.stringify({
      etc: await validateWorkspacePath(${JSON.stringify(canonicalEtc)}),
      varTmp: await validateWorkspacePath(${JSON.stringify(path.join(canonicalVarTmp, 'safe-workspace'))}),
      varFolders: ${canonicalVarFolders ? `await validateWorkspacePath(${JSON.stringify(path.join(canonicalVarFolders, 'safe-workspace'))})` : 'null'},
    }));
  `;
  const result = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], {
    env: { ...process.env, WORKSPACES_EXTRA_ROOTS: extraRoots.join(path.delimiter) }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    etc: { valid: boolean; error?: string };
    varTmp: { valid: boolean };
    varFolders: { valid: boolean } | null;
  };
  assert.equal(parsed.etc.valid, false);
  assert.match(parsed.etc.error || '', /system directory|system-critical/);
  assert.equal(parsed.varTmp.valid, true);
  if (parsed.varFolders) {
    assert.equal(parsed.varFolders.valid, true);
  }
});

test('Windows 盘符和目录大小写变化不造成误拒绝', { skip: process.platform !== 'win32' }, async () => {
  const target = path.join(firstExtraRoot.toUpperCase(), 'new-app');
  assert.equal((await validateWorkspacePath(target)).valid, true);
});

test('Windows 额外根须明确盘符或完整 UNC，不能依赖当前工作盘', { skip: process.platform !== 'win32' }, () => {
  const driveRoot = 'D:\\';
  const uncShareRoot = '\\\\server\\share\\';
  const uncRoot = '\\\\server\\share\\projects';
  const roots = [
    firstExtraRoot.slice(2), firstExtraRoot.slice(2).replaceAll('\\', '/'),
    'F:relative', '\\\\server', driveRoot, firstExtraRoot, uncShareRoot, uncRoot,
  ];
  const script = `
    const { WORKSPACE_ROOTS } = await import(${JSON.stringify(new URL('../utils.ts', import.meta.url).href)});
    console.log(JSON.stringify(WORKSPACE_ROOTS));
  `;
  const result = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], {
    env: { ...process.env, WORKSPACES_EXTRA_ROOTS: roots.join(path.delimiter) }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [homeRoot, driveRoot, firstExtraRoot, uncShareRoot, uncRoot]);
});

test('resolvePathUnderRoots accepts filesystem roots and Windows drive casing while rejecting prefix siblings', async () => {
  const reportPath = path.join(firstExtraRoot, 'report.md');
  const siblingDirectory = path.join(fixtureRoot, 'projects-other');
  const siblingReportPath = path.join(siblingDirectory, 'report.md');
  await mkdir(siblingDirectory, { recursive: true });
  await Promise.all([
    writeFile(reportPath, 'ok', 'utf8'),
    writeFile(siblingReportPath, 'no', 'utf8'),
  ]);

  const filesystemRoot = path.parse(fixtureRoot).root;
  assert.equal(await resolvePathUnderRoots(reportPath, [filesystemRoot]), reportPath);
  assert.equal(await resolvePathUnderRoots(siblingReportPath, [firstExtraRoot]), null);

  if (process.platform === 'win32') {
    assert.equal(
      await resolvePathUnderRoots(reportPath.toUpperCase(), [filesystemRoot.toLowerCase()]),
      reportPath,
    );
    assert.equal(
      await resolvePathUnderRoots(reportPath.toUpperCase(), [firstExtraRoot.toLowerCase()]),
      reportPath,
    );
  }
});

test('未配置额外根目录时仍仅允许默认用户目录', () => {
  // 独立进程重载模块，验证环境变量未配置时的兼容行为。
  const environment = { ...process.env };
  delete environment.WORKSPACES_ROOT;
  delete environment.WORKSPACES_EXTRA_ROOTS;
  const script = `
    const { validateWorkspacePath, WORKSPACES_ROOT } = await import(${JSON.stringify(new URL('../utils.ts', import.meta.url).href)});
    console.log(JSON.stringify({
      root: WORKSPACES_ROOT,
      home: (await validateWorkspacePath(${JSON.stringify(path.join(homeRoot, 'app'))})).valid,
      extra: (await validateWorkspacePath(${JSON.stringify(path.join(firstExtraRoot, 'app'))})).valid,
    }));
  `;
  const result = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], {
    env: environment, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { root: homeRoot, home: true, extra: false });
});

test('maps mounted Windows drives and current-distro WSL UNC paths on Linux/WSL', () => {
  const wsl2Mounts = [
    'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000 0 0',
    'F:\\134 /mnt/f 9p rw,noatime,aname=drvfs;path=F:\\;uid=1000 0 0',
    'F:\\134Work\\040Space /mnt/work 9p rw,noatime,aname=drvfs;path=F:\\Work\\040Space;uid=1000 0 0',
  ].join('\n');
  const wsl1Mounts = 'F: /mnt/f drvfs rw,noatime,uid=1000 0 0\n';

  assert.deepEqual(
    resolveWorkspacePathForHost('F:\\Workspaces\\demo-app', { platform: 'linux', mountsContent: wsl2Mounts }),
    { path: '/mnt/f/Workspaces/demo-app', isWindowsPath: true },
  );
  assert.deepEqual(
    resolveWorkspacePathForHost('f:/Workspaces/demo-app/', { platform: 'linux', mountsContent: wsl2Mounts }),
    { path: '/mnt/f/Workspaces/demo-app', isWindowsPath: true },
  );
  assert.deepEqual(
    resolveWorkspacePathForHost('\\\\?\\F:\\Workspaces\\demo-app', { platform: 'linux', mountsContent: wsl2Mounts }),
    { path: '/mnt/f/Workspaces/demo-app', isWindowsPath: true },
  );
  assert.deepEqual(
    resolveWorkspacePathForHost('F:\\Work Space\\repo', { platform: 'linux', mountsContent: wsl2Mounts }),
    { path: '/mnt/work/repo', isWindowsPath: true },
  );
  assert.deepEqual(
    resolveWorkspacePathForHost('F:\\Workspaces\\demo-app', { platform: 'linux', mountsContent: wsl1Mounts }),
    { path: '/mnt/f/Workspaces/demo-app', isWindowsPath: true },
  );
  assert.deepEqual(
    resolveWorkspacePathForHost('\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\app', {
      platform: 'linux',
      mountsContent: wsl2Mounts,
      wslDistroName: 'Ubuntu-22.04',
    }),
    { path: '/home/user/app', isWindowsPath: true },
  );
});

test('rejects unmounted drives, drive-relative paths, and non-WSL Windows paths instead of joining with cwd', async () => {
  const wslMounts = 'F:\\134 /mnt/f 9p rw,noatime,aname=drvfs;path=F:\\;uid=1000 0 0\n';

  for (const [label, target, mountsContent] of [
    ['unmounted drive', 'Z:\\Workspaces\\app', wslMounts],
    ['non-WSL Linux host', 'F:\\Workspaces\\app', ''],
    ['drive-relative path', 'F:relative\\app', wslMounts],
    ['bare drive letter', 'F:', wslMounts],
    ['other WSL distro UNC path', '\\\\wsl.localhost\\Debian\\home\\user\\app', wslMounts],
    ['network UNC path', '\\\\server\\share\\app', wslMounts],
  ] as const) {
    const validation = await validateWorkspacePath(target, {
      platform: 'linux',
      mountsContent,
      wslDistroName: 'Ubuntu-22.04',
    });
    assert.equal(validation.valid, false, `${label} should be rejected`);
    assert.ok(validation.error && !validation.error.includes('allowed workspace root'), `${label} must not fall back to cwd resolution: ${validation.error}`);
  }

  const winSystemValidation = await validateWorkspacePath('C:\\Windows\\System32', {
    platform: 'linux',
    mountsContent: 'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000 0 0\n',
  });
  assert.equal(winSystemValidation.valid, false);
  assert.match(winSystemValidation.error || '', /system directory/);
});
