import {Configuration, Ident, Manifest, Project, Workspace, YarnVersion} from '@yarnpkg/core';
import {npmConfigUtils, npmHttpUtils}                                    from '@yarnpkg/plugin-npm';
import semver                                                           from 'semver';

type PackageMetadata = {
  versions: Record<string, {
    deprecated?: unknown;
  }>;
};

export function assertCompatibleYarnVersion() {
  if (YarnVersion === null || !semver.satisfies(YarnVersion, `>=3.2.0 <4`)) {
    throw new Error(
      `yarn-plugin-yarn-bulkaudit requires Yarn >=3.2.0 <4 (running ${YarnVersion ?? `an unknown version`})`,
    );
  }
}

export function getAuditRegistry(workspace: Workspace, {configuration}: {configuration: Configuration}) {
  // Yarn 3 requires the manifest as its first argument. Yarn 4 removed it.
  return npmConfigUtils.getAuditRegistry(workspace.manifest as Manifest, {configuration});
}

export async function getPackageMetadata(ident: Ident, {project}: {project: Project}): Promise<PackageMetadata> {
  // npmHttpUtils.getPackageMetadata was added after Yarn 3.2. Fetching through
  // npmHttpUtils.get preserves Yarn's scope registry and authentication logic.
  return await npmHttpUtils.get(npmHttpUtils.getIdentUrl(ident), {
    configuration: project.configuration,
    ident,
    jsonResponse: true,
  }) as PackageMetadata;
}

export function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
