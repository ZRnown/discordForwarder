import { ChannelId } from "./config.js";

export interface ClickableAliasPersona {
  keyword?: string;
  jumpChannelId?: ChannelId;
}

export interface ClickableAliasChannel {
  keyword: string;
  channelId: ChannelId;
}

export function normalizeClickableAlias(text: string) {
  return (text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF\u2060]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function rewriteClickableAliases(
  text: string,
  options: {
    personas?: ClickableAliasPersona[];
    channelAliases?: ClickableAliasChannel[];
  }
) {
  if (!text || !text.includes("@")) {
    return text;
  }

  const aliasTargets = [
    ...(options.personas ?? [])
      .filter((persona) => persona.keyword && persona.jumpChannelId)
      .map((persona) => ({
        keyword: String(persona.keyword),
        channelId: String(persona.jumpChannelId)
      })),
    ...(options.channelAliases ?? []).map((channel) => ({
      keyword: String(channel.keyword),
      channelId: String(channel.channelId)
    }))
  ]
    .map((target) => ({
      ...target,
      normalizedKeyword: normalizeClickableAlias(target.keyword)
    }))
    .filter((target) => target.normalizedKeyword)
    .sort((a, b) => b.normalizedKeyword.length - a.normalizedKeyword.length);

  if (aliasTargets.length === 0) {
    return text;
  }

  return text.replace(/(^|\s)(@\S+)/gu, (full, prefix, rawToken) => {
    const trailing = rawToken.match(/[),.;:!?，。；：！？]+$/u)?.[0] ?? "";
    const token = trailing ? rawToken.slice(0, -trailing.length) : rawToken;
    if (/^<[@#&]/.test(token)) {
      return full;
    }

    const normalizedToken = normalizeClickableAlias(token.slice(1));
    const target = aliasTargets.find((candidate) =>
      normalizedToken.includes(candidate.normalizedKeyword)
    );
    if (!target) {
      return full;
    }

    return `${prefix}<#${target.channelId}>${trailing}`;
  });
}
