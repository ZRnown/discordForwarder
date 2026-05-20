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

export function buildActiveSlotSourceId(category: string, scopeKey: string) {
  return `active-slot:${category}:${scopeKey}`;
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
    const existingTarget = canEditActiveForwardItem(prepared.item)
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
