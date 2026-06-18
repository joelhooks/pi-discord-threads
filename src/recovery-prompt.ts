const BRIDGE_RECOVERY_MARKERS = [
  "The previous Discord/Pi turn in this thread was interrupted by a bridge daemon restart",
  "Interrupted request to recover:",
] as const;

export function isBridgeRecoveryPrompt(prompt: string | undefined): boolean {
  if (!prompt) return false;
  return BRIDGE_RECOVERY_MARKERS.some((marker) => prompt.includes(marker));
}

export function recoverableInterruptedPrompt(prompt: string | undefined): string | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) return undefined;
  return isBridgeRecoveryPrompt(trimmed) ? undefined : trimmed;
}
