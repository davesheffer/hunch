// `hunch task benchmark`: flag parsing only; the orchestration lives in src/benchmark/orchestrate.ts.
// No Hunch store is opened: the benchmark drives an audited Hunch build against rebuilt task repos.
import type { Command } from "commander";
import { runBenchmark } from "../benchmark/orchestrate.js";

interface TaskBenchmarkFlags {
  suite: string;
  arms: string;
  runs: string;
  seed: string;
  runnerConfig?: string;
  output: string;
  sourceRepo?: string;
  mainRef: string;
  privateRepo?: string;
  privateRef: string;
  audited?: string;
  tasks?: string;
  prepareOnly?: boolean;
  reportOnly?: boolean;
  recount?: boolean;
  npmCi: boolean;
  allowDirtyController?: boolean;
}

const list = (value: string): string[] => value.split(",").map((item) => item.trim()).filter(Boolean);

export function registerTaskBenchmarkCommand(task: Command): void {
  task.command("benchmark")
    .description("Run the context-efficiency benchmark (Gate A): paired no-hunch/current-hunch runs per suite task, then report.json + report.md. "
      + "Exit 0 done, 1 preflight/prepare failure, 2 manifest mismatch, 3 schedule stopped (CLI version changed)")
    .requiredOption("--suite <file>", "suite JSON (hunch.context-efficiency-suite/1)")
    .option("--arms <a,b>", "baseline,treatment arms", "no-hunch,current-hunch")
    .option("--runs <n>", "repetitions per task (one extra tie-break repetition may follow)", "2")
    .requiredOption("--seed <seed>", "arm-order seed")
    .option("--runner-config <file>", "runner JSON (hunch.benchmark-runner/1); required unless --report-only")
    .requiredOption("--output <dir>", "output directory (manifest.json, snapshots/, runs/, report.*)")
    .option("--source-repo <path>", "repository the tasks come from; required unless --report-only")
    .option("--main-ref <ref>", "main ref the public memory snapshot is cut from", "origin/main")
    .option("--private-repo <path>", "private overlay repository; required unless --report-only")
    .option("--private-ref <ref>", "private overlay ref", "main")
    .option("--audited <path>", "audited Hunch checkout with a built dist/; required unless --report-only")
    .option("--tasks <ids>", "comma-separated task ids (suite order kept; needs its own --output)")
    .option("--prepare-only", "stop after the manifest")
    .option("--report-only", "only rebuild report.json + report.md from existing run.json files")
    .option("--recount", "with --report-only: recount token and call fields from each run's transcript.jsonl (run.json untouched)")
    .option("--no-npm-ci", "skip npm ci in each run repo (fixture provider only)")
    .option("--allow-dirty-controller", "allow uncommitted changes in the controller checkout (fixture provider only)")
    .action(async (flags: TaskBenchmarkFlags, cmd: Command) => {
      const runs = Number(flags.runs);
      const result = await runBenchmark({
        suite: flags.suite,
        arms: list(flags.arms),
        armsExplicit: cmd.getOptionValueSource("arms") === "cli",
        runs: Number.isInteger(runs) ? runs : Number.NaN,
        seed: flags.seed,
        runnerConfig: flags.runnerConfig,
        output: flags.output,
        sourceRepo: flags.sourceRepo,
        mainRef: flags.mainRef,
        privateRepo: flags.privateRepo,
        privateRef: flags.privateRef,
        audited: flags.audited,
        tasks: flags.tasks ? list(flags.tasks) : null,
        prepareOnly: !!flags.prepareOnly,
        reportOnly: !!flags.reportOnly,
        recount: !!flags.recount,
        noNpmCi: !flags.npmCi,
        allowDirtyController: !!flags.allowDirtyController,
      });
      process.exitCode = result.exitCode;
    });
}
