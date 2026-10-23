import { minimatch } from 'minimatch';

/**
 * Files that may hold credentials. Matched on the path alone, before anything is opened, and
 * no include glob can bring them back: their contents are never read, hashed or sent anywhere.
 */
export const SECRET_PATTERNS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/*.jks',
  '**/*.ppk',
  '**/*.kdbx',
  '**/*.mobileprovision',
  '**/*.tfvars',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/*credential*',
  '**/*secret*',
  '**/*password*',
  '**/*apikey*',
  '**/*api_key*',
  '**/service-account*.json',
  '**/google-services.json',
  '**/GoogleService-Info.plist',
  // Unity Cloud / signing
  '**/*.keystore.meta',
  '**/ProjectSettings/UnityConnectSettings.asset',
];

/** Directories that are never entered. */
export const SECRET_DIRS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.kube',
  'secrets',
  '.secrets',
]);

const matchers = SECRET_PATTERNS.map(
  (p) => (path: string) => minimatch(path, p, { dot: true, nocase: true }),
);

export function isSecretPath(relPath: string): boolean {
  const parts = relPath.split('/');
  if (parts.slice(0, -1).some((d) => SECRET_DIRS.has(d.toLowerCase()))) return true;
  return matchers.some((m) => m(relPath));
}
