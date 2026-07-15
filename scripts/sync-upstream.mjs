import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), `..`);
const repository = `yarnpkg/berry`;
const upstreamRoot = `packages/plugin-npm-cli/sources`;

const args = process.argv.slice(2);
const check = args.includes(`--check`);
const refIndex = args.indexOf(`--ref`);
const ref = refIndex === -1 ? `master` : args[refIndex + 1];

if (!ref)
  throw new Error(`--ref requires a value`);

const headers = {
  Accept: `application/vnd.github+json`,
  [`User-Agent`]: `yarn-v3-audit-updater`,
  ...process.env.GITHUB_TOKEN ? {Authorization: `Bearer ${process.env.GITHUB_TOKEN}`} : {},
};

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok)
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return await response.text();
}

function replaceRequired(source, search, replacement, file) {
  if (!source.includes(search))
    throw new Error(`Upstream compatibility transform no longer applies to ${file}: ${JSON.stringify(search)}`);
  return source.replace(search, replacement);
}

function adaptAudit(source) {
  const file = `commands/npm/audit.ts`;

  source = replaceRequired(
    source,
    `description: \`perform a vulnerability audit against the installed packages\``,
    `description: \`This command is controlled by yarn-v3-bulk-audit; it performs a vulnerability audit against the installed packages\``,
    file,
  );
  source = replaceRequired(
    source,
    `import * as npmAuditTypes                                                                                                        from '../../npmAuditTypes';`,
    `import * as npmAuditCompat                                                                                                       from '../../npmAuditCompat';\nimport * as npmAuditTypes                                                                                                        from '../../npmAuditTypes';`,
    file,
  );
  source = replaceRequired(
    source,
    `  async execute() {\n    const configuration`,
    `  async execute() {\n    npmAuditCompat.assertCompatibleYarnVersion();\n\n    const configuration`,
    file,
  );
  source = replaceRequired(
    source,
    `const registry = npmConfigUtils.getAuditRegistry({configuration});`,
    `const registry = npmAuditCompat.getAuditRegistry(workspace, {configuration});`,
    file,
  );
  source = replaceRequired(
    source,
    `npmHttpUtils.getPackageMetadata(structUtils.parseIdent(packageName), {`,
    `npmAuditCompat.getPackageMetadata(structUtils.parseIdent(packageName), {`,
    file,
  );
  source = replaceRequired(
    source,
    `Object.hasOwn(auditResult, packageName)`,
    `npmAuditCompat.hasOwn(auditResult, packageName)`,
    file,
  );

  return source;
}

function adaptUtils(source) {
  const file = `npmAuditUtils.ts`;

  source = replaceRequired(
    source,
    `          ID: typeof advisory.id !== \`undefined\` && {\n            label: \`ID\`,\n            value: formatUtils.tuple(formatUtils.Type.ID, advisory.id),\n          },`,
    `          ...typeof advisory.id !== \`undefined\` ? {ID: {\n            label: \`ID\`,\n            value: formatUtils.tuple(formatUtils.Type.NO_HINT, \`\${advisory.id}\`),\n          }} : {},`,
    file,
  );
  source = replaceRequired(
    source,
    `          URL: typeof advisory.url !== \`undefined\` && {\n            label: \`URL\`,\n            value: formatUtils.tuple(formatUtils.Type.URL, advisory.url),\n          },`,
    `          ...typeof advisory.url !== \`undefined\` ? {URL: {\n            label: \`URL\`,\n            value: formatUtils.tuple(formatUtils.Type.URL, advisory.url),\n          }} : {},`,
    file,
  );
  source = replaceRequired(
    source,
    `workspace.anchoredPackage.dependencies.values()`,
    `workspace.dependencies.values()`,
    file,
  );
  source = replaceRequired(
    source,
    `const devirtualizedDescriptor = structUtils.ensureDevirtualizedDescriptor(descriptor);`,
    `const devirtualizedDescriptor = structUtils.isVirtualDescriptor(descriptor)\n      ? structUtils.devirtualizeDescriptor(descriptor)\n      : descriptor;`,
    file,
  );
  source = replaceRequired(
    source,
    `const devirtualizedLocator = structUtils.ensureDevirtualizedLocator(pkg);`,
    `const devirtualizedLocator = structUtils.isVirtualLocator(pkg)\n      ? structUtils.devirtualizeLocator(pkg)\n      : pkg;`,
    file,
  );

  return source;
}

const commitResponse = await fetch(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, {headers});
if (!commitResponse.ok)
  throw new Error(`Failed to resolve upstream ref ${ref}: ${commitResponse.status} ${commitResponse.statusText}`);
const {sha} = await commitResponse.json();

const upstreamManifestUrl = `https://raw.githubusercontent.com/${repository}/${sha}/packages/plugin-npm-cli/package.json`;
const upstreamManifest = JSON.parse(await fetchText(upstreamManifestUrl, {headers}));
if (!`${upstreamManifest.version}`.startsWith(`4.`)) {
  throw new Error(
    `Refusing to sync @yarnpkg/plugin-npm-cli ${upstreamManifest.version}; this backport tracks Yarn 4.x only`,
  );
}

const files = [
  [`commands/npm/audit.ts`, adaptAudit],
  [`npmAuditTypes.ts`, source => source],
  [`npmAuditUtils.ts`, adaptUtils],
];

let changed = false;
let sourceChanged = false;
for (const [file, adapt] of files) {
  const url = `https://raw.githubusercontent.com/${repository}/${sha}/${upstreamRoot}/${file}`;
  const content = adapt(await fetchText(url, {headers}));
  const destination = resolve(root, `sources`, file);

  let previous = null;
  try {
    previous = await readFile(destination, `utf8`);
  } catch {}

  if (previous !== content) {
    changed = true;
    sourceChanged = true;
    if (!check)
      await writeFile(destination, content);
  }
}

const metadata = `${JSON.stringify({
  repository,
  ref,
  commit: sha,
  files: files.map(([file]) => `${upstreamRoot}/${file}`),
}, null, 2)}\n`;
const metadataPath = resolve(root, `.yarn-audit-upstream.json`);
let previousMetadata = null;
try {
  previousMetadata = await readFile(metadataPath, `utf8`);
} catch {}

// Keep the last commit that actually changed the tracked audit sources. Yarn's
// master branch moves frequently for unrelated packages; updating metadata on
// every such commit would create empty weekly synchronization PRs.
if ((sourceChanged || previousMetadata === null) && previousMetadata !== metadata) {
  changed = true;
  if (!check)
    await writeFile(metadataPath, metadata);
}

if (check && changed) {
  console.error(`The backport differs from Yarn ${ref} (${sha}). Run npm run sync:upstream.`);
  process.exitCode = 1;
} else if (changed) {
  console.log(`Updated the backport from Yarn ${ref} at ${sha}.`);
} else {
  console.log(`Already up to date with Yarn ${ref} at ${sha}.`);
}
