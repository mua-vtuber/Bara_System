import { lstat, realpath, mkdir, readdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, parse, join, relative, isAbsolute, dirname } from 'node:path';
/** Inspect every existing component, including parents, so links/junctions cannot escape ownership. */
export async function assertNoLinks(path: string, allowMissingLeaf = false): Promise<string> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error('Symbolic link forbidden: ' + current);
      }
    }
    catch (error) {
      if (allowMissingLeaf && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return absolute;
      }
      throw error;
    }
  }
  if (await realpath(absolute) !== absolute && process.platform !== 'win32') {
    throw new Error('Noncanonical path');
  }
  return absolute;
}
export async function archiveFile(directory: string, file: string): Promise<string> {
  if (isAbsolute(file) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..') || /[:\x00]/.test(file)) {
    throw new Error('Unsafe archive path');
  }
  const path = join(directory, file);
  await assertNoLinks(path);
  if (!(await lstat(path)).isFile()) {
    throw new Error('Archive entry is not a regular file: ' + file);
  }
  return path;
}
export async function assertNewDestination(destination: string, sources: readonly string[] = []): Promise<string> {
  const target = await assertNoLinks(destination, true);
  for (const source of sources) {
    const input = resolve(source);
    const delta = relative(input, target);
    const inverse = relative(target, input);
    if (delta === '' || (!delta.startsWith('..') && !isAbsolute(delta)) || (!inverse.startsWith('..') && !isAbsolute(inverse))) {
      throw new Error('Source and destination overlap');
    }
  }
  try {
    await lstat(target);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return target;
    }
    throw error;
  }
  throw new Error('Destination already exists');
}
/** Exclusive reservation + exclusive file copies. Manifest is the final completeness marker.
* Failure leaves an explicitly incomplete reserved directory; no preexisting path is overwritten or removed.
*/
export async function publishDirectory(stage: string, destination: string): Promise<void> {
  if (dirname(stage) !== dirname(destination)) {
    throw new Error('Publication must stay on the same filesystem');
  }
  await assertNewDestination(destination);
  await assertNoLinks(stage);
  await mkdir(destination);
  async function copy(directory: string, target: string, root = false): Promise<void> {
    for (const item of await readdir(directory, {
      withFileTypes: true
    })) {
      if (root && item.name === 'manifest.json') {
        continue;
      }
      const source = join(directory, item.name);
      await assertNoLinks(source);
      const output = join(target, item.name);
      if (item.isDirectory()) {
        await mkdir(output);
        await copy(source, output);
      }
      else if (item.isFile()) {
        await copyFile(source, output, constants.COPYFILE_EXCL);
      }
      else {
        throw new Error('Unsupported staging entry');
      }
    }
  }
  await copy(stage, destination, true);
  await copyFile(join(stage, 'manifest.json'), join(destination, 'manifest.json'), constants.COPYFILE_EXCL);
}
