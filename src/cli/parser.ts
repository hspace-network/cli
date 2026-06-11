export interface ParsedInput {
  command: string;
  args: string[];
}

const MULTI_WORD_COMMANDS = ["set strategy"];

export function parseInput(raw: string): ParsedInput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  for (const cmd of MULTI_WORD_COMMANDS) {
    if (lower === cmd || lower.startsWith(cmd + " ")) {
      const rest = trimmed.slice(cmd.length).trim();
      const args = rest.length > 0 ? rest.split(/\s+/) : [];
      return { command: cmd, args };
    }
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0]!.toLowerCase();
  const args = parts.slice(1);

  return { command, args };
}
