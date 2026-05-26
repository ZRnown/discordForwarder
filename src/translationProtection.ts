export interface ProtectedTranslationTokens {
  text: string;
  restore(translated: string): string;
}

export function protectMentionLikeTokensForTranslation(
  text: string
): ProtectedTranslationTokens {
  const tokens: string[] = [];
  const protectedText = (text || "").replace(/@\S+/gu, (match) => {
    const index = tokens.push(match) - 1;
    return `__MENTION_${index}__`;
  });

  return {
    text: protectedText,
    restore(translated: string) {
      return (translated || "").replace(/__MENTION_(\d+)__/g, (full, raw) => {
        const index = Number(raw);
        return Number.isFinite(index) && tokens[index] != null
          ? tokens[index]
          : full;
      });
    }
  };
}
