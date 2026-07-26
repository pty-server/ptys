import type { Session } from "@pty-server/protocol";
import type { ApiClient } from "./api-client.js";

function describeCandidates(sessions: Session[]): string {
  return sessions
    .map((session) => `${session.id.slice(0, 8)}${session.name ? ` (${session.name})` : ""}`)
    .join(", ");
}

export async function resolveSessionId(
  client: ApiClient,
  workspaceId: string | undefined,
  idPrefixOrName: string,
): Promise<string> {
  const sessions = await client.listSessions(workspaceId);
  const exact = sessions.find((session) => session.id === idPrefixOrName);
  if (exact) {
    return exact.id;
  }

  const prefixMatches = sessions.filter((session) => session.id.startsWith(idPrefixOrName));
  if (prefixMatches.length === 1) {
    return prefixMatches[0].id;
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Ambiguous session id prefix "${idPrefixOrName}": ${describeCandidates(prefixMatches)}`);
  }

  const nameMatches = sessions.filter((session) => session.name === idPrefixOrName);
  if (nameMatches.length === 1) {
    return nameMatches[0].id;
  }
  if (nameMatches.length > 1) {
    throw new Error(`Ambiguous session name "${idPrefixOrName}": ${describeCandidates(nameMatches)}`);
  }

  throw new Error(`No session matches "${idPrefixOrName}"`);
}
