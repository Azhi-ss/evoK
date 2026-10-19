/** Same marker pi-subagents prepends in buildIntercomBridgeInstruction. */
export const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";

export function isReviewerGatePrompt(prompt: string): boolean {
  return /<active_agent\b[^>]*\bname="reviewer-gate"/.test(prompt) || prompt.includes("名字是 `reviewer-gate`");
}

/**
 * Reviewer-gate must not see the intercom bridge. The bridge block is cut off
 * at the marker, and any leftover contact_supervisor wording is removed.
 */
export function reviewerGateSystemPrompt(prompt: string): string {
  const marker = prompt.indexOf(INTERCOM_BRIDGE_MARKER);
  const body = marker === -1 ? prompt : prompt.slice(0, marker).trimEnd();
  return body.split("contact_supervisor").join("");
}
