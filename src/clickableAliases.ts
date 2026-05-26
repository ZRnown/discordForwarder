import { ChannelId } from "./config.js";

export interface ClickableAliasPersona {
  keyword?: string;
  identityRoleId?: ChannelId;
  jumpChannelId?: ChannelId;
}

export interface ClickableAliasChannel {
  keyword: string;
  channelId: ChannelId;
}

export interface ClickableAliasTarget {
  personas?: ClickableAliasPersona[];
  channelAliases?: ClickableAliasChannel[];
}

export function normalizeClickableAlias(text: string) {
  return (text || "")
    .toLowerCase()
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF\u2060]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function extractClickableAliasFromRemark(remark?: string) {
  if (!remark) {
    return undefined;
  }

  const sourceMatch = remark.match(/源频道「([^」]+)」/);
  const rawSource = sourceMatch?.[1] || remark;
  const normalized = normalizeClickableAlias(rawSource);
  return normalized || undefined;
}

export function rewriteClickableAliases(
  text: string,
  options: {
    personas?: ClickableAliasPersona[];
    channelAliases?: ClickableAliasChannel[];
    preferredChannelId?: ChannelId;
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

  let rewritten = text.replace(/<@&(\d+)>/g, (full, roleId) => {
    const target = (options.personas ?? []).find(
      (persona) =>
        persona.identityRoleId &&
        String(persona.identityRoleId) === String(roleId) &&
        persona.jumpChannelId
    );
    return target?.jumpChannelId ? `<#${target.jumpChannelId}>` : full;
  });

  return rewritten.replace(/(^|\s)(@\S+)/gu, (full, prefix, rawToken) => {
    const trailing = rawToken.match(/[),.;:!?，。；：！？]+$/u)?.[0] ?? "";
    const token = trailing ? rawToken.slice(0, -trailing.length) : rawToken;
    if (/^<[@#&]/.test(token)) {
      return full;
    }

    const normalizedToken = normalizeClickableAlias(token.slice(1));
    const matches = aliasTargets.filter((candidate) =>
      normalizedToken.includes(candidate.normalizedKeyword)
    );
    const target =
      matches.find(
        (candidate) =>
          options.preferredChannelId &&
          String(candidate.channelId) === String(options.preferredChannelId)
      ) ?? matches[0];
    if (!target) {
      return full;
    }

    return `${prefix}<#${target.channelId}>${trailing}`;
  });
}

export function buildClickableAliasTargets(
  options: ClickableAliasTarget
) {
  return {
    personas: options.personas ?? [],
    channelAliases: options.channelAliases ?? []
  };
}
