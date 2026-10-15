import path from "node:path";

/**
 * Folder under the OpenClaw state directory that holds Ada's SQLite stores. It keeps its
 * pre-rename name on purpose: live volumes already hold the saved Lexroom and Google
 * sign-ins and the matter memory there, and moving them would risk losing the sign-ins.
 */
const ADA_STATE_SUBDIR = "vera";

export function adaStatePath(stateDir: string, file: string): string {
  return path.join(stateDir, ADA_STATE_SUBDIR, file);
}
