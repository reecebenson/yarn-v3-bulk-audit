import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), `..`);
const bundle = resolve(root, `plugin-yarn-bulkaudit.js`);

function run(binary, args, cwd) {
  return runProgram(process.execPath, [binary, ...args], cwd);
}

function runProgram(program, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: {
        ...process.env,
        YARN_ENABLE_IMMUTABLE_INSTALLS: `0`,
        YARN_ENABLE_TELEMETRY: `0`,
      },
      stdio: [`ignore`, `pipe`, `pipe`],
    });
    let stdout = ``;
    let stderr = ``;
    child.stdout.on(`data`, chunk => stdout += chunk);
    child.stderr.on(`data`, chunk => stderr += chunk);
    child.on(`error`, reject);
    child.on(`close`, code => resolvePromise({code, stdout, stderr}));
  });
}

async function makeRegistryFixture(cwd) {
  const packageCwd = resolve(cwd, `registry-package`);
  await mkdir(packageCwd);
  await writeFile(resolve(packageCwd, `package.json`), `${JSON.stringify({
    name: `vulnerable`,
    version: `1.0.0`,
    main: `index.js`,
  })}\n`);
  await writeFile(resolve(packageCwd, `index.js`), `module.exports = true;\n`);

  const npmCli = resolve(dirname(process.execPath), `../lib/node_modules/npm/bin/npm-cli.js`);
  const packed = await run(npmCli, [
    `pack`,
    `--cache`,
    resolve(cwd, `.npm-cache`),
    `--pack-destination`,
    cwd,
  ], packageCwd);
  assert.equal(packed.code, 0, JSON.stringify(packed));

  const tarball = await readFile(resolve(cwd, `vulnerable-1.0.0.tgz`));
  const requests = [];
  let auditEnabled = true;

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request)
      chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({method: request.method, url: request.url, body});

    const registry = `http://127.0.0.1:${server.address().port}`;

    if (request.method === `GET` && request.url === `/vulnerable`) {
      const metadata = {
        name: `vulnerable`,
        [`dist-tags`]: {latest: `1.0.0`},
        versions: {
          [`1.0.0`]: {
            name: `vulnerable`,
            version: `1.0.0`,
            deprecated: `Use a maintained replacement`,
            dist: {
              shasum: createHash(`sha1`).update(tarball).digest(`hex`),
              integrity: `sha512-${createHash(`sha512`).update(tarball).digest(`base64`)}`,
              tarball: `${registry}/vulnerable/-/vulnerable-1.0.0.tgz`,
            },
          },
        },
      };
      response.setHeader(`content-type`, `application/json`);
      response.end(JSON.stringify(metadata));
      return;
    }

    if (request.method === `GET` && request.url === `/vulnerable/-/vulnerable-1.0.0.tgz`) {
      response.setHeader(`content-type`, `application/octet-stream`);
      response.end(tarball);
      return;
    }

    if (request.method === `POST` && request.url === `/-/npm/v1/security/advisories/bulk`) {
      const payload = JSON.parse(body);
      const result = auditEnabled && payload.vulnerable ? {
        vulnerable: [{
          id: 42,
          title: `Test advisory`,
          url: `https://example.test/advisories/42`,
          severity: `high`,
          vulnerable_versions: `<2.0.0`,
        }],
      } : {};
      response.setHeader(`content-type`, `application/json`);
      response.end(JSON.stringify(result));
      return;
    }

    response.statusCode = 404;
    response.end(`not found`);
  });

  await new Promise(resolvePromise => server.listen(0, `127.0.0.1`, resolvePromise));
  return {
    requests,
    registry: `http://127.0.0.1:${server.address().port}`,
    disableAdvisories: () => auditEnabled = false,
    close: () => new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())),
  };
}

for (const [version, binary] of [
  [`3.2.0`, resolve(root, `node_modules/@yarnpkg/cli-dist/bin/yarn.js`)],
  [`3.8.7`, resolve(root, `node_modules/yarn-3-latest/bin/yarn.js`)],
]) {
  test(`the bundle overrides npm audit on Yarn ${version}`, async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), `yarn-bulkaudit-`));
    try {
      await writeFile(resolve(cwd, `package.json`), `${JSON.stringify({private: true})}\n`);

      const imported = await run(binary, [`plugin`, `import`, bundle], cwd);
      assert.equal(imported.code, 0, imported.stderr || imported.stdout);

      const help = await run(binary, [`npm`, `audit`, `--help`], cwd);
      assert.equal(help.code, 0, help.stderr || help.stdout);
      assert.match(help.stdout, /--no-deprecations/);
      assert.match(help.stdout, /--exclude/);
      assert.match(help.stdout, /--ignore/);

      const publishHelp = await run(binary, [`npm`, `publish`, `--help`], cwd);
      assert.equal(publishHelp.code, 0, publishHelp.stderr || publishHelp.stdout);

      const yarnrc = await readFile(resolve(cwd, `.yarnrc.yml`), `utf8`);
      assert.match(yarnrc, /plugin-npm-cli/);
    } finally {
      await rm(cwd, {recursive: true, force: true});
    }
  });
}

test(`the command uses the bulk endpoint and filters its response`, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), `yarn-bulkaudit-registry-`));
  const binary = resolve(root, `node_modules/@yarnpkg/cli-dist/bin/yarn.js`);
  let fixture;

  try {
    fixture = await makeRegistryFixture(cwd);
    await writeFile(resolve(cwd, `package.json`), `${JSON.stringify({
      private: true,
      dependencies: {vulnerable: `1.0.0`},
    })}\n`);
    await writeFile(resolve(cwd, `.yarnrc.yml`), [
      `npmRegistryServer: "${fixture.registry}"`,
      `unsafeHttpWhitelist:`,
      `  - 127.0.0.1`,
      ``,
    ].join(`\n`));

    const imported = await run(binary, [`plugin`, `import`, bundle], cwd);
    assert.equal(imported.code, 0, imported.stderr || imported.stdout);

    const installed = await run(binary, [`install`], cwd);
    assert.equal(installed.code, 0, installed.stderr || installed.stdout);

    const audit = await run(binary, [`npm`, `audit`, `--no-deprecations`, `--json`], cwd);
    assert.equal(audit.code, 1, audit.stderr || audit.stdout);
    assert.match(audit.stdout, /https:\/\/example\.test\/advisories\/42/);

    const bulkRequest = fixture.requests.find(request => request.url === `/-/npm/v1/security/advisories/bulk`);
    assert.deepEqual(JSON.parse(bulkRequest.body), {vulnerable: [`1.0.0`]});
    assert.equal(fixture.requests.some(request => request.url === `/-/npm/v1/security/audits/quick`), false);

    const ignored = await run(binary, [`npm`, `audit`, `--no-deprecations`, `--ignore`, `42`, `--json`], cwd);
    assert.equal(ignored.code, 0, ignored.stderr || ignored.stdout);
    assert.equal(ignored.stdout, ``);

    const excluded = await run(binary, [`npm`, `audit`, `--no-deprecations`, `--exclude`, `vulnerable`, `--json`], cwd);
    assert.equal(excluded.code, 0, excluded.stderr || excluded.stdout);
    assert.equal(excluded.stdout, ``);
    const lastBulkRequest = fixture.requests.filter(request => request.url === `/-/npm/v1/security/advisories/bulk`).at(-1);
    assert.deepEqual(JSON.parse(lastBulkRequest.body), {});

    fixture.disableAdvisories();
    const deprecated = await run(binary, [`npm`, `audit`, `--json`], cwd);
    assert.equal(deprecated.code, 1, deprecated.stderr || deprecated.stdout);
    assert.match(deprecated.stdout, /vulnerable \(deprecation\)/);
    assert.match(deprecated.stdout, /Use a maintained replacement/);
  } finally {
    if (fixture)
      await fixture.close();
    await rm(cwd, {recursive: true, force: true});
  }
});
