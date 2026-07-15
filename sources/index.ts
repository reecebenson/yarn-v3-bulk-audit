import {Plugin, SettingsType} from '@yarnpkg/core';

import NpmAuditCommand    from './commands/npm/audit';
import * as npmAuditTypes from './npmAuditTypes';
import * as npmAuditUtils from './npmAuditUtils';

export {NpmAuditCommand};
export {npmAuditTypes};
export {npmAuditUtils};

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    npmAuditExcludePackages: Array<string>;
    npmAuditIgnoreAdvisories: Array<string>;
  }
}

// This plugin deliberately uses the normalized @yarnpkg/plugin-npm-cli name so
// Yarn replaces its built-in plugin instead of registering a second, ambiguous
// `npm audit` command. The dynamic require resolves the plugin bundled with the
// running Yarn version, preserving every unrelated npm command at that version.
const originalPluginRequest = [`@yarnpkg`, `plugin-npm-cli`].join(`/`);
const originalPlugin = require(originalPluginRequest).default as Plugin;

const auditConfiguration = {
  npmAuditExcludePackages: {
    description: `Array of glob patterns of packages to exclude from npm audit`,
    type: SettingsType.STRING as const,
    default: [],
    isArray: true as const,
  },
  npmAuditIgnoreAdvisories: {
    description: `Array of glob patterns of advisory IDs to exclude from npm audit`,
    type: SettingsType.STRING as const,
    default: [],
    isArray: true as const,
  },
};

const isAuditCommand = (command: any) => {
  return command.paths?.some((path: Array<string>) => path.length === 2 && path[0] === `npm` && path[1] === `audit`);
};

const plugin: Plugin = {
  ...originalPlugin,
  configuration: {
    ...originalPlugin.configuration,
    ...auditConfiguration,
  },
  commands: [
    ...(originalPlugin.commands ?? []).filter(command => !isAuditCommand(command)),
    NpmAuditCommand,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
