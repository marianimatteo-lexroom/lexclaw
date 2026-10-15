/**
 * Reads `ADA_<name>`, falling back to the pre-rename `VERA_<name>`, so a deployment that
 * still carries the old variable names keeps working. Blank values count as unset.
 */
export function readAdaEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const key of [`ADA_${name}`, `VERA_${name}`]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}
