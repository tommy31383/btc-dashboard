import { buildCampaignSignals } from "./stochrsi-macro-cycle/core";
import { loadAndRefreshData } from "./stochrsi-macro-cycle/io";
import {
  buildReport,
  buildWarmupRange,
  JSON_OUTPUT_PATH,
  MARKDOWN_OUTPUT_PATH,
  writeGeneratedOutputs,
} from "./stochrsi-macro-cycle/report";
import {
  runFrozenVariants,
  type FundingPayment,
} from "./stochrsi-macro-cycle/replay";

function parseOfflineFlag(args: string[]): boolean {
  const unknown = args.filter((argument) => argument !== "--offline");
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  return args.includes("--offline");
}

async function main(): Promise<void> {
  const offline = parseOfflineFlag(process.argv.slice(2));
  const data = await loadAndRefreshData({ refresh: !offline });
  const campaigns = buildCampaignSignals(data.hourly, data.asOfMs);
  const funding: FundingPayment[] = data.funding.map((payment) => ({
    time: payment.time,
    rate: payment.rate,
    ...(payment.mark === null ? {} : { mark: payment.mark }),
  }));
  const variants = runFrozenVariants(campaigns, data.hourly, funding);
  const report = buildReport({
    provenance: data.provenance,
    campaigns,
    variants,
    warmupRange: buildWarmupRange(data.hourly, data.asOfMs),
  });
  await writeGeneratedOutputs(report);

  process.stdout.write(
    `${offline ? "Offline" : "Online"} BTC StochRSI macro-cycle replay complete: ` +
    `${JSON_OUTPUT_PATH}, ${MARKDOWN_OUTPUT_PATH}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
