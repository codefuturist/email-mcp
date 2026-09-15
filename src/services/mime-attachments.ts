import type { AttachmentMeta } from '../types/index.js';

type BodyPart = Record<string, unknown>;

interface DownloadablePart {
  filename: string;
  orig: string;
  mimeType: string;
  size: number;
  path: string;
  id: string;
}

function asPart(bodyStructure: unknown): BodyPart | null {
  if (!bodyStructure || typeof bodyStructure !== 'object') return null;
  return bodyStructure as BodyPart;
}

function partParams(bs: BodyPart): Record<string, string> {
  return {
    ...((bs.parameters as Record<string, string> | undefined) ?? {}),
    ...((bs.dispositionParameters as Record<string, string> | undefined) ?? {}),
  };
}

function partMimeType(bs: BodyPart): string {
  const type = String(bs.type ?? '').toLowerCase();
  if (type.includes('/')) return type;
  return `${String(bs.type ?? 'application')}/${String(bs.subtype ?? 'octet-stream')}`;
}

function partFilename(bs: BodyPart): string {
  const params = partParams(bs);
  if (params.filename) return params.filename;
  if (params.name) return params.name;
  if (typeof bs.id === 'string' && bs.id.length > 0) {
    const cid = bs.id.replace(/^<|>$/g, '');
    return cid.split('@')[0] || cid;
  }
  return 'unnamed';
}

function uniquifyFilename(seen: Set<string>, name: string): string {
  if (!seen.has(name)) {
    seen.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  let next: string;
  do {
    next = `${base}-${i}${ext}`;
    i += 1;
  } while (seen.has(next));
  seen.add(next);
  return next;
}

/** Attachments, plus named/CID inline images (often no Content-Disposition). */
export function isDownloadablePart(bodyStructure: unknown): boolean {
  const bs = asPart(bodyStructure);
  if (!bs) return false;
  if (bs.disposition === 'attachment') return true;
  const type = String(bs.type ?? '').toLowerCase();
  if (type === 'multipart' || type.startsWith('multipart/')) return false;
  const params = partParams(bs);
  const named = Boolean(params.filename || params.name || bs.id);
  if (bs.disposition === 'inline') return named;
  return (type === 'image' || type.startsWith('image/')) && named;
}

function walkDownloadable(
  bodyStructure: unknown,
  partPath: string,
  seen: Set<string>,
  out: DownloadablePart[],
): void {
  const bs = asPart(bodyStructure);
  if (!bs) return;
  const currentPart = bs.part as string | undefined;
  const effectivePath = currentPart ?? partPath;
  if (isDownloadablePart(bs)) {
    const orig = partFilename(bs);
    out.push({
      filename: uniquifyFilename(seen, orig),
      orig,
      mimeType: partMimeType(bs),
      size: (bs.size as number) ?? 0,
      path: effectivePath,
      id: typeof bs.id === 'string' ? bs.id.replace(/^<|>$/g, '') : '',
    });
  }
  if (Array.isArray(bs.childNodes)) {
    for (let i = 0; i < bs.childNodes.length; i++) {
      const childPart = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      walkDownloadable(bs.childNodes[i], childPart, seen, out);
    }
  }
}

export function collectDownloadableParts(bodyStructure: unknown): DownloadablePart[] {
  const out: DownloadablePart[] = [];
  walkDownloadable(bodyStructure, '', new Set(), out);
  return out;
}

export function hasAttachments(bodyStructure: unknown): boolean {
  return collectDownloadableParts(bodyStructure).length > 0;
}

export function extractAttachments(bodyStructure: unknown): AttachmentMeta[] {
  return collectDownloadableParts(bodyStructure).map((p) => ({
    filename: p.filename,
    mimeType: p.mimeType,
    size: p.size,
  }));
}

/** Resolve MIME part path by unique filename, original name, Content-ID, or part number. */
export function findMimePartByFilename(
  bodyStructure: unknown,
  targetFilename: string,
  _partPath = '',
): string | undefined {
  const parts = collectDownloadableParts(bodyStructure);
  const lower = String(targetFilename).toLowerCase();
  const match = parts.find(
    (p) =>
      p.filename === targetFilename ||
      p.orig === targetFilename ||
      p.filename.toLowerCase() === lower ||
      p.orig.toLowerCase() === lower ||
      p.id.toLowerCase() === lower ||
      p.id.split('@')[0].toLowerCase() === lower ||
      String(p.path) === String(targetFilename),
  );
  return match?.path;
}
