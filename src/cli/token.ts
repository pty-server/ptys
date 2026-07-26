export function resolveToken(flagValue: string | undefined): string | undefined {
  if (flagValue !== undefined && flagValue.length > 0) {
    return flagValue;
  }
  const fromEnv = process.env.PTYS_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return undefined;
}
