const SAFE_READ_ONLY_SHELL_COMMANDS = [
  /^pwd$/,
  /^ls(?: -a|-l|-la|-al)?$/,
  /^git status(?: --(?:short|branch|porcelain|untracked-files=(?:no|normal)))*$/,
  /^git log(?: --oneline| --decorate| --max-count=[1-9]\d{0,2})*$/,
  /^git diff(?: --stat| --cached| --name-only| --no-color)*$/,
  /^git rev-parse (?:HEAD|--show-toplevel|--is-inside-work-tree)$/,
  /^git ls-files(?: --cached)?$/,
];

/**
 * Narrow shell inspection mode. Commands are executed by the process manager,
 * but this mode accepts only single, fixed read-only command forms: no shell
 * operators, substitutions, redirections, arbitrary executables, or paths.
 * Mutating commands remain on the ordinary checkpoint-gated shell path.
 */
export function isReadOnlyShellInspectionCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f;&|<>`'$(){}\\*?\[\]]/.test(normalized)) return false;
  const match = SAFE_READ_ONLY_SHELL_COMMANDS.some((pattern) => pattern.test(normalized));
  if (!match) return false;
  return true;
}

export function readOnlyShellInspectionError(command: string): string | undefined {
  return isReadOnlyShellInspectionCommand(command)
    ? undefined
    : "Read-only shell inspection accepts only pwd, ls, and the allowlisted read-only git status/log/diff/rev-parse/ls-files forms. Use ordinary bash for other commands; it requires a review checkpoint.";
}
