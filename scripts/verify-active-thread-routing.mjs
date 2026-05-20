import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../config.json", import.meta.url), "utf8")
);

const errors = [];
const fanoutSources = Object.entries(config.channelWebhooks || {}).filter(
  ([, value]) => Array.isArray(value)
);

if (fanoutSources.length > 0) {
  errors.push(
    `channelWebhooks still contains fanout arrays: ${fanoutSources
      .map(([source]) => source)
      .join(", ")}`
  );
}

for (const key of ["spot", "futures"]) {
  const block = config.activeBlocks?.[key];
  if (!block) {
    errors.push(`activeBlocks.${key} is missing`);
    continue;
  }
  if (
    typeof block.threadWebhook !== "string" ||
    !block.threadWebhook.startsWith("https://discord.com/api/webhooks/")
  ) {
    errors.push(`activeBlocks.${key}.threadWebhook is missing or invalid`);
  }
}

if (
  config.activeBlocks?.spot?.threadWebhook &&
  config.activeBlocks?.futures?.threadWebhook &&
  config.activeBlocks.spot.threadWebhook !==
    config.activeBlocks.futures.threadWebhook
) {
  errors.push(
    "activeBlocks.spot and activeBlocks.futures must share the KOL forum webhook"
  );
}

if (config.activeBlocks?.alerts?.threadWebhook) {
  errors.push("activeBlocks.alerts must not send to the KOL forum webhook");
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      fanoutSources: fanoutSources.length,
      spotThreadWebhook: Boolean(config.activeBlocks?.spot?.threadWebhook),
      futuresThreadWebhook: Boolean(
        config.activeBlocks?.futures?.threadWebhook
      ),
      alertsThreadWebhook: Boolean(config.activeBlocks?.alerts?.threadWebhook)
    },
    null,
    2
  )
);
