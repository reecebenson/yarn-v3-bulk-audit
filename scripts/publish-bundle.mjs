import {copyFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), `..`);
const source = resolve(root, `bundles/@yarnpkg/plugin-npm-cli.js`);
const destination = resolve(root, `plugin-yarn-bulkaudit.js`);

await mkdir(dirname(destination), {recursive: true});
await copyFile(source, destination);
