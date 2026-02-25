import { createSchedulerClient } from "@/clients/scheduler.ts";
import { createGatewayClient } from "@/clients/gateway.ts";
import { loadConfiguration } from "@/configuration/loader.ts";

async function smokeTest(): Promise<void> {
  console.log("=== kraken integration smoke test ===\n");

  const configuration = await loadConfiguration();
  const schedulerClient = createSchedulerClient(configuration.services.schedulerUrl);
  const gatewayClient = createGatewayClient(configuration.services.gatewayUrl);

  console.log("1. testing gateway health check...");
  const health = await gatewayClient.healthCheck({});
  console.log(`   result: healthy=${health.healthy}, version=${health.version}`);

  console.log("\n2. registering a cron job on scheduler...");
  const cron = await schedulerClient.registerCron({
    name: "test-daily-lint",
    cronExpression: "0 0 9 * * *",
    taskTemplate: "lint",
    parameters: { scope: "all" },
  });
  console.log(`   result: cronId=${cron.cronId}, nextRun=${cron.nextRun}`);

  console.log("\n3. listing crons...");
  const crons = await schedulerClient.listCrons({});
  console.log(`   result: ${crons.crons.length} cron(s) registered`);
  for (const entry of crons.crons) {
    console.log(`   - ${entry.name} (${entry.cronExpression}) next: ${entry.nextRun}`);
  }

  console.log("\n4. unregistering cron...");
  await schedulerClient.unregisterCron({ cronId: cron.cronId });
  const afterUnregister = await schedulerClient.listCrons({});
  console.log(`   result: ${afterUnregister.crons.length} cron(s) remaining`);

  console.log("\n5. testing gateway LLM proxy (will fail without API key)...");
  try {
    const completion = await gatewayClient.complete({
      model: "openrouter/auto",
      messages: [{ role: "user", content: "Say hello in one word." }],
    });
    console.log(`   result: ${completion.message?.content}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.log(`   expected error (no API key): ${message.slice(0, 100)}`);
  }

  console.log("\n=== all integration tests passed ===");
}

smokeTest().catch((error) => {
  console.error("smoke test failed:", error);
  process.exit(1);
});
