export const PROJECT_KEY_DELIMITER = '__';
export const UNCATEGORIZED_LABEL = 'Uncategorized';

/**
 * Gabungkan kategori & nama proyek menjadi project_key backend: `${category}__${name}`.
 * Kategori kosong menghasilkan nama polos (dianggap Uncategorized oleh parseProjectKey).
 */
export function encodeProjectKey(category: string, name: string): string {
  const cleanCategory = category.trim();
  const cleanName = name.trim();
  if (!cleanName) return '';
  if (!cleanCategory) return cleanName;
  return `${cleanCategory}${PROJECT_KEY_DELIMITER}${cleanName}`;
}

/**
 * Pecah project_key menjadi { category, displayName }.
 * Tanpa delimiter `__` (atau kategori kosong) -> 'Uncategorized'.
 */
export function parseProjectKey(rawKey: string): { category: string; displayName: string } {
  const key = rawKey.trim();
  const sep = key.indexOf(PROJECT_KEY_DELIMITER);
  if (!key || sep <= 0 || sep === key.length - PROJECT_KEY_DELIMITER.length) {
    return { category: UNCATEGORIZED_LABEL, displayName: key };
  }
  return {
    category: key.slice(0, sep),
    displayName: key.slice(sep + PROJECT_KEY_DELIMITER.length),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(cipher: string): Uint8Array {
  const binary = atob(cipher);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// shortcut: base64 obfuscation only, not encryption; upgrade when secrets need real crypto at rest.
export function obfuscateSecret(plain: string): string {
  if (!plain) return '';
  return bytesToBase64(new TextEncoder().encode(plain));
}

export function deobfuscateSecret(cipher: string): string {
  if (!cipher) return '';
  try {
    return new TextDecoder().decode(base64ToBytes(cipher));
  } catch {
    // Nilai lama / bukan cipher base64 dianggap tidak bisa dibuka.
    return '';
  }
}

/**
 * Masking kredensial pada connection string.
 * `postgres://user:secret@host:5432/db` -> `postgres://user:••••••••@host:5432/db`.
 * URI tanpa skema terdeteksi dikembalikan sebagai mask penuh.
 */
export function maskConnectionString(uri: string): string {
  const raw = uri.trim();
  if (!raw) return '';

  const match = raw.match(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@(.+)$/i);
  if (!match) return '••••••••';

  const [, scheme, userInfo, rest] = match;
  const passwordSep = userInfo.indexOf(':');
  if (passwordSep === -1) return `${scheme}${userInfo}@${rest}`;
  return `${scheme}${userInfo.slice(0, passwordSep)}:••••••••@${rest}`;
}
