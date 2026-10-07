import { applyEdits, modify } from 'jsonc-parser';

export interface NetworkConfigTarget {
  path: (string | number)[];
  label: string;
  host: string;
  protocol: 'ftp' | 'sftp';
  networkInterface?: string | null;
  isProfile: boolean;
}

export function getNetworkConfigTargets(text: string): NetworkConfigTarget[] {
  const parsed = JSON.parse(text);
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  const targets: NetworkConfigTarget[] = [];
  roots.forEach((config, index) => {
    const basePath = Array.isArray(parsed) ? [index] : [];
    const baseLabel = config.name || `Connection ${index + 1}`;
    const protocol = config.protocol || 'sftp';
    if (protocol === 'ftp' || protocol === 'sftp') {
      targets.push({
        path: basePath, label: `${baseLabel} — base configuration`, host: config.host || '',
        protocol,
        networkInterface: config.networkInterface, isProfile: false,
      });
    }
    Object.entries(config.profiles || {}).forEach(([name, profile]: [string, any]) => {
      const profileProtocol = profile.protocol || protocol;
      if (profileProtocol !== 'ftp' && profileProtocol !== 'sftp') return;
      targets.push({
        path: [...basePath, 'profiles', name], label: `${baseLabel} — ${name}`,
        host: profile.host || config.host || '', isProfile: true,
        protocol: profileProtocol,
        networkInterface: Object.prototype.hasOwnProperty.call(profile, 'networkInterface')
          ? profile.networkInterface : config.networkInterface,
      });
    });
  });
  return targets;
}

export function setNetworkInterface(text: string, target: NetworkConfigTarget, name?: string): string {
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
