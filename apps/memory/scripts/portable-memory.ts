// Keep models, DB initialization and settings out of help/verify imports.
type PortableArgs = { command: 'help' } |
  { command: 'export'; db: string; assets: string; out: string } |
  { command: 'verify'; archive: string } |
  { command: 'restore'; archive: string; out: string; resume?: boolean; model?: 'bge-m3' };

const HELP = `Offline portable memory commands (run from apps/memory):
  bun run portable:export --db <sqlite-file> --assets <asset-folder> --out <new-archive-folder>
  bun run portable:verify --archive <archive-folder>
  bun run portable:restore --archive <archive-folder> --out <new-destination-folder> [--resume] [--model bge-m3]

Stop the source server and other writers before export. All paths are explicit.
Restore recomputes indexes; only bge-m3 is registered. No automatic live cutover.
Resume interrupted restore with the same archive, output and model using --resume.
Results are JSON on stdout; progress and errors go to stderr.
`;

export function parsePortableArgs(argv: string[]): PortableArgs {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { command: 'help' };
  const command = argv[0];
  if (command !== 'export' && command !== 'verify' && command !== 'restore') {
    throw new Error('Expected command: export, verify or restore. Use --help for usage.');
  }
  if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) return { command: 'help' };
  const allowed = command === 'export' ? ['db', 'assets', 'out'] :
    command === 'restore' ? ['archive', 'out', 'resume', 'model'] : ['archive'];
  const values: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const key = arg.slice(2);
    if (!arg.startsWith('--') || !allowed.includes(key)) throw new Error(`Unknown argument: ${arg}`);
    if (key in values) throw new Error(`Duplicate argument: ${arg}`);
    if (key === 'resume') { values[key] = true; continue; }
    const value = argv[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    values[key] = value;
  }
  const required = command === 'export' ? ['db', 'assets', 'out'] : command === 'restore' ? ['archive', 'out'] : ['archive'];
  for (const key of required) if (!(key in values)) throw new Error(`Missing required --${key}`);
  if (values.model !== undefined && values.model !== 'bge-m3') throw new Error('Unsupported --model; only bge-m3 is registered.');
  return { command, ...values } as PortableArgs;
}

function duration(ms: number): string { return `${Math.ceil(ms / 1000)}s`; }

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: PortableArgs;
  try { args = parsePortableArgs(argv); }
  catch (error) { console.error(`portable-memory: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  if (args.command === 'help') { process.stdout.write(HELP); return 0; }
  const controller = new AbortController();
  let interruptedBy: string | undefined;
  const interrupt = (signal: string) => {
    if (controller.signal.aborted) return;
    interruptedBy = signal;
    controller.abort(new Error(`Interrupted by ${signal}`));
    console.error(args.command === 'restore'
      ? `Interrupted by ${signal}; stopping at a safe checkpoint. Resume with the same paths/model and --resume.`
      : `Interrupted by ${signal}; stopping the command.`);
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    let result: unknown;
    switch (args.command) {
      case 'export': {
        const { exportPortableArchive } = await import('../src/portable/export.ts');
        result = await exportPortableArchive({ dbPath: args.db, assetDir: args.assets, destination: args.out, signal: controller.signal });
        break;
      }
      case 'verify': {
        const { validatePortableArchive } = await import('../src/portable/validate.ts');
        const archive = await validatePortableArchive(args.archive);
        result = { valid: true, directory: archive.directory, fingerprint: archive.fingerprint, manifest: archive.manifest };
        break;
      }
      case 'restore': {
        const { restorePortableArchive } = await import('../src/portable/restore.ts');
        result = await restorePortableArchive({
          archive: args.archive, destination: args.out, resume: args.resume, model: args.model,
          signal: controller.signal,
          onProgress(progress) {
            const eta = progress.estimatedRemainingMs === null ? 'unknown (measuring throughput)' : duration(progress.estimatedRemainingMs);
            console.error(`[${progress.phase}] ${progress.completed}/${progress.total}; elapsed ${duration(progress.elapsedMs)}; ETA ${eta}`);
          },
        });
        break;
      }
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    console.error(`portable-memory: ${error instanceof Error ? error.message : String(error)}`);
    return interruptedBy === 'SIGINT' ? 130 : interruptedBy === 'SIGTERM' ? 143 : 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

if (import.meta.main) process.exitCode = await main();
