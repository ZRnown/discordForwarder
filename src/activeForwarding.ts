export interface ActiveForwardItem {
  content?: string;
  useEmbed?: boolean;
  uploads?: unknown[];
}

export interface ActivePreparedMessage<
  TSender,
  TItem extends ActiveForwardItem
> {
  sender: TSender;
  item: TItem;
}

export interface ActiveTargetMessage {
  channelId: string;
  messageId: string;
}

export interface ActiveTargetScope {
  webhookUrl?: string;
  threadId?: string;
  threadName?: string;
  remark?: string;
}

export function buildActiveSlotSourceId(category: string, scopeKey: string) {
  return `active-slot:${category}:${scopeKey}`;
}

export function buildActiveDedupKey(
  category: string | undefined,
  personaKeys: unknown[],
  fallbackSourceMessageId: string
) {
  const normalizedPersonas = personaKeys
    .map((key) => String(key || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const scope =
    normalizedPersonas.length > 0
      ? normalizedPersonas.join("+")
      : `message:${fallbackSourceMessageId}`;
  return `active-dedup:${category || "unknown"}:${scope}`;
}

const ACTIVE_DEDUP_ZERO_WIDTH_REGEX = /[\u200B-\u200F\u2028\u2029\uFEFF\u2060]/g;

function normalizeStrategyEmojiName(name: string) {
  const baseName = String(name || "")
    .replace(/~\d+$/u, "")
    .toLowerCase();
  return ["long", "short", "spot"].includes(baseName) ? baseName : name;
}

export function normalizeActiveDedupText(text: string): string {
  return String(text || "")
    .replace(ACTIVE_DEDUP_ZERO_WIDTH_REGEX, "")
    .replace(/<t:\d+:[RFDT]>/g, "<t:DYNAMIC:R>")
    .replace(
      /https:\/\/(?:ptb\.)?discord(?:app)?\.com\/channels\/\d+\/\d+(?:\/\d+)?/g,
      "<discord-channel-link>"
    )
    .replace(/<#\d+>/g, "@active-alias")
    .replace(/<a?:([A-Za-z0-9_~+.-]+):\d+>/g, (_match, name: string) => {
      return `:${normalizeStrategyEmojiName(name)}:`;
    })
    .replace(/:(Long|Short|Spot)(?:~\d+)?:/gi, (_match, name: string) => {
      return `:${String(name).toLowerCase()}:`;
    })
    .replace(/(^|\s)@\S+/gu, "$1@active-alias")
    .trim();
}

export function activeDedupTextsMatch(lastText: string, currentText: string) {
  const normalizedLast = normalizeActiveDedupText(lastText.trim());
  const normalizedCurrent = normalizeActiveDedupText(currentText.trim());
  return (
    normalizedLast === normalizedCurrent ||
    normalizedLast.endsWith(normalizedCurrent) ||
    normalizedCurrent.endsWith(normalizedLast) ||
    (normalizedLast.includes(normalizedCurrent) &&
      normalizedCurrent.length > 50)
  );
}

export function buildActiveSlotSourceIdsForScope(
  category: string | undefined,
  scope?: ActiveTargetScope
) {
  if (!category || !scope) {
    return [];
  }

  const scopeKeys = [
    scope.webhookUrl && scope.threadId
      ? `webhook:${scope.webhookUrl}:thread:${scope.threadId}`
      : undefined,
    scope.webhookUrl && scope.threadName
      ? `webhook:${scope.webhookUrl}:threadName:${scope.threadName}`
      : undefined,
    scope.webhookUrl && !scope.threadId && !scope.threadName && !scope.remark
      ? `webhook:${scope.webhookUrl}`
      : undefined,
    scope.remark ? `remark:${scope.remark}` : undefined
  ].filter((value): value is string => Boolean(value));

  return [...new Set(scopeKeys)].map((scopeKey) =>
    buildActiveSlotSourceId(category, scopeKey)
  );
}

const activeSourceQueues = new Map<string, Promise<unknown>>();

export async function runActiveSourceQueued<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = activeSourceQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(
    () => current,
    () => current
  );
  activeSourceQueues.set(key, next);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (activeSourceQueues.get(key) === next) {
      activeSourceQueues.delete(key);
    }
  }
}

export function canEditActiveForwardItem(item: ActiveForwardItem): boolean {
  const singleMessageLimit = item.useEmbed ? 4096 : 2000;
  return (
    (item.uploads?.length || 0) === 0 &&
    (item.content || "").length <= singleMessageLimit
  );
}

export function partitionActivePreparedMessagesForEdit<
  TSender,
  TItem extends ActiveForwardItem
>(
  sourceMessageId: string,
  preparedMessages: Array<ActivePreparedMessage<TSender, TItem>>,
  findTargetMessage: (
    sourceMessageId: string,
    sender: TSender
  ) => ActiveTargetMessage | undefined
) {
  const editable: Array<{
    prepared: ActivePreparedMessage<TSender, TItem>;
    target: ActiveTargetMessage;
  }> = [];
  const sendable: Array<ActivePreparedMessage<TSender, TItem>> = [];

  for (const prepared of preparedMessages) {
    const existingTarget =
      canEditActiveForwardItem(prepared.item)
        ? findTargetMessage(sourceMessageId, prepared.sender)
        : undefined;
    if (existingTarget) {
      editable.push({ prepared, target: existingTarget });
    } else {
      sendable.push(prepared);
    }
  }

  return { editable, sendable };
}
