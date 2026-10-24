export function isAllowed<T>(userId: T | undefined, allowedUserIds: T[]): boolean {
  return userId !== undefined && allowedUserIds.length > 0 && allowedUserIds.includes(userId);
}

/**
 * Discord authorization check: the global allowlist grants access everywhere (DMs + all
 * guild channels). A channel-scoped allowlist entry only grants access to guild messages
 * in that specific channel — it never applies to DMs, even for the same user ID.
 * A thread without its own entry inherits its parent channel's entry.
 */
export function isDiscordAuthorized(
  userId: string | undefined,
  isGuild: boolean,
  channelId: string,
  allowedUserIds: string[],
  channelAllowedUserIds: Record<string, string[]> | undefined,
  parentChannelId?: string,
): boolean {
  if (isAllowed(userId, allowedUserIds)) return true;
  if (!isGuild) return false;
  const scoped = channelAllowedUserIds?.[channelId]
    ?? (parentChannelId ? channelAllowedUserIds?.[parentChannelId] : undefined)
    ?? [];
  return isAllowed(userId, scoped);
}
