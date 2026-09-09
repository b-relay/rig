/** Git object IDs use exactly SHA-1 or SHA-256 hexadecimal width. */
export function isGitCommit(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
