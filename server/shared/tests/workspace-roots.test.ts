import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
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

const { validateWorkspacePath, WORKSPACES_ROOT } = await import('@/shared/utils.js');

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
  const systemLink = path.join(homeRoot, 'system-link');
  await symlink(systemRoot, systemLink, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [systemRoot, systemLink]) {
    const validation = await validateWorkspacePath(target);
    assert.equal(validation.valid, false);
    assert.match(validation.error || '', /system directory|system-critical/);
  }
});

test('Windows 盘符和目录大小写变化不造成误拒绝', { skip: process.platform !== 'win32' }, async () => {
  const target = path.join(firstExtraRoot.toUpperCase(), 'new-app');
  assert.equal((await validateWorkspacePath(target)).valid, true);
});

test('Windows 额外根须明确盘符或完整 UNC，不能依赖当前工作盘', { skip: process.platform !== 'win32' }, () => {
  const uncRoot = '\\\\server\\share\\projects';
  const roots = [
    firstExtraRoot.slice(2), firstExtraRoot.slice(2).replaceAll('\\', '/'),
    'F:relative', '\\\\server', firstExtraRoot, uncRoot,
  ];
  const script = `
    const { WORKSPACE_ROOTS } = await import(${JSON.stringify(new URL('../utils.ts', import.meta.url).href)});
    console.log(JSON.stringify(WORKSPACE_ROOTS));
  `;
  const result = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], {
    env: { ...process.env, WORKSPACES_EXTRA_ROOTS: roots.join(path.delimiter) }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [homeRoot, firstExtraRoot, uncRoot]);
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
