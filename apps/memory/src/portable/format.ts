export type PortableScalar = string | number | null;
export type PortableRecord = Record<string, PortableScalar>;
export interface CollectionDescriptor {
  readonly name: string;
  readonly table: string;
  /** SQL column -> portable domain field. JSON-valued columns are exact TEXT, never parsed. */
  readonly fields: Readonly<Record<string, string>>;
  readonly types: Readonly<Record<string, {
    readonly type: string;
    readonly nullable: boolean;
  }>>;
  readonly primaryKey: readonly string[];
  readonly references: readonly {
    field: string;
    collection: string;
    targetField: string;
  }[];
}
export interface PortableManifestV1 {
  format: 'bara-memory';
  version: 1;
  archiveId: string;
  createdAt: string;
  source: {
    appVersion: string;
    schemaVersion: number;
  };
  collections: Record<string, {
    file: string;
    count: number;
    sha256: string;
  }>;
  allocators: Record<string, string>;
  attachments: Array<{
    sha256: string;
    extension: string;
    byteSize: number;
    file: string;
  }>;
  indexes: {
    policy: 'recompute';
    sourceCounts: Record<string, number>;
  };
  exclusions: Array<{
    name: string;
    reason: string;
  }>;
}
export interface ValidatedArchive {
  directory: string;
  manifest: PortableManifestV1;
  fingerprint: string;
  collections: Record<string, PortableRecord[]>;
}
export function assertPortableScalar(value: unknown, context = 'value'): PortableScalar {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error('Unsafe integer: ' + context);
    }
    return Number(value);
  }
  if (value === null) {
    return value;
  }
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new Error('Unpaired UTF-16 surrogate: ' + context);
        }
        index++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error('Unpaired UTF-16 surrogate: ' + context);
      }
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) {
    return value;
  }
  throw new Error('Invalid portable scalar: ' + context);
}
