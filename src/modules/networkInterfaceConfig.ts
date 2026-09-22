import { applyEdits, modify } from 'jsonc-parser';

export interface FTPConfigTarget {
  path: (string | number)[];
  label: string;
  host: string;
  networkInterface?: string | null;
  isProfile: boolean;
}

export function getFTPConfigTargets(text: string): FTPConfigTarget[] {
  const parsed = JSON.parse(text);
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  const targets: FTPConfigTarget[] = [];
  roots.forEach((config, index) => {
    const basePath = Array.isArray(parsed) ? [index] : [];
    const baseLabel = config.name || `Connection ${index + 1}`;
    if (config.protocol === 'ftp') {
      targets.push({
        path: basePath, label: `${baseLabel} — base configuration`, host: config.host || '',
        networkInterface: config.networkInterface, isProfile: false,
      });
    }
    Object.entries(config.profiles || {}).forEach(([name, profile]: [string, any]) => {
      if ((profile.protocol || config.protocol || 'sftp') !== 'ftp') return;
      targets.push({
        path: [...basePath, 'profiles', name], label: `${baseLabel} — ${name}`,
        host: profile.host || config.host || '', isProfile: true,
        networkInterface: Object.prototype.hasOwnProperty.call(profile, 'networkInterface')
          ? profile.networkInterface : config.networkInterface,
      });
    });
  });
  return targets;
}

export function setNetworkInterface(text: string, target: FTPConfigTarget, name?: string): string {
  // null explicitly overrides an inherited adapter; omission uses system routing at the root.
  const value = name ?? (target.isProfile ? null : undefined);
  const indent = text.match(/\n([\t ]+)"/)?.[1] || '  ';
  return applyEdits(text, modify(text, [...target.path, 'networkInterface'], value, {
    formattingOptions: {
      insertSpaces: !indent.includes('\t'), tabSize: indent.length,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    },
  }));
}
