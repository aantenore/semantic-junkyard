export interface McpLaunchOptions {
  databaseRelativePath: string;
  memory: boolean;
  seed: boolean;
  allowDiscoveryRuns: boolean;
  allowSourceSync: boolean;
  allowBusinessWrites: boolean;
}

const BOOLEAN_FLAGS = new Set([
  "--memory",
  "--no-seed",
  "--allow-discovery",
  "--allow-sync",
  "--allow-write"
]);

export function parseMcpLaunchOptions(argv: string[], configuredDatabasePath: string): McpLaunchOptions {
  const flags = new Set<string>();
  let databaseRelativePath = configuredDatabasePath;
  let databaseOptionSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--db") {
      if (databaseOptionSeen) throw new Error("--db may be specified only once.");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--db requires a relative database path.");
      databaseOptionSeen = true;
      databaseRelativePath = value;
      index += 1;
      continue;
    }
    if (!BOOLEAN_FLAGS.has(argument)) throw new Error(`Unknown MCP startup option: ${argument}`);
    flags.add(argument);
  }

  const memory = flags.has("--memory");
  if (memory && databaseOptionSeen) throw new Error("--memory and --db are mutually exclusive.");
  return Object.freeze({
    databaseRelativePath,
    memory,
    seed: memory && !flags.has("--no-seed"),
    allowDiscoveryRuns: flags.has("--allow-discovery"),
    allowSourceSync: flags.has("--allow-sync"),
    allowBusinessWrites: flags.has("--allow-write")
  });
}
