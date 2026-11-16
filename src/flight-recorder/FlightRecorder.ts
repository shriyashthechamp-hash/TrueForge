import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  FlightRecorderEvent,
  ProofOfChangeReport,
  TestCaseResult,
  TestExecutionStatus,
} from '../shared/types.js';

export class FlightRecorder {
  private events: FlightRecorderEvent[] = [];
  private currentTaskId = '';
  private currentInstruction = '';
  private implementationPlan: string[] = [];
  private filesInspected = new Set<string>();
  private commandsExecuted: string[] = [];
  private testsDiscovered = new Set<string>();
  private testsExecuted = new Set<string>();
  private testResults: TestCaseResult[] = [];
  private testOutputs: string[] = [];
  private skippedOrFailedChecks: string[] = [];
  private remainingRisks: string[] = [];
  private unverifiedBehavior: string[] = [];
  private selectedContextMetadata: { filePath: string; tokens: number; score: number }[] = [];

  constructor(private readonly logDir?: string) {}

  public startTask(taskId: string, instruction: string): void {
    this.currentTaskId = taskId;
    this.currentInstruction = instruction;
    this.events = [];
    this.implementationPlan = [];
    this.filesInspected.clear();
    this.commandsExecuted = [];
    this.testsDiscovered.clear();
    this.testsExecuted.clear();
    this.testResults = [];
    this.testOutputs = [];
    this.skippedOrFailedChecks = [];
    this.remainingRisks = [];
    this.unverifiedBehavior = [];
    this.selectedContextMetadata = [];

    this.record('turn_start', `Started task: "${instruction}"`, { taskId });
  }

  public setImplementationPlan(plan: string[]): void {
    this.implementationPlan = [...plan];
  }

  public addFileInspected(filePath: string): void {
    this.filesInspected.add(filePath);
  }

  public setContextSelectionMetadata(items: { filePath: string; tokens: number; score: number }[]): void {
    this.selectedContextMetadata = [...items];
  }

  public addDiscoveredTests(tests: string[]): void {
    for (const t of tests) {
      this.testsDiscovered.add(t);
    }
  }

  public addRemainingRisk(risk: string): void {
    this.remainingRisks.push(risk);
  }

  public addUnverifiedBehavior(note: string): void {
    this.unverifiedBehavior.push(note);
  }

  public record(
    type: FlightRecorderEvent['type'],
    summary: string,
    details?: Record<string, unknown>
  ): FlightRecorderEvent {
    const event: FlightRecorderEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      type,
      summary,
      details,
    };
    this.events.push(event);

    if (details) {
      if (details.filePath && typeof details.filePath === 'string') {
        this.filesInspected.add(details.filePath);
      }

      if (type === 'tool_call' && details.name === 'run_test_command') {
        const cmd = String((details.args as any)?.command ?? '');
        if (cmd) this.commandsExecuted.push(cmd);
      }

      if (type === 'tool_result') {
        const toolName = String(details.toolName ?? '');
        if (toolName === 'run_test_command') {
          const out = String(details.output ?? '');
          const cmd = String(details.command ?? '');
          this.testOutputs.push(out);
          this.testsExecuted.add(cmd || 'test_suite');

          const isFail = out.includes('FAILED') || out.includes('error') || details.isError;
          const isSkip = out.includes('skipped') && !isFail && !out.includes('passed');

          const status: TestExecutionStatus = isFail ? 'failed' : isSkip ? 'skipped' : 'passed';
          this.testResults.push({
            testName: cmd || 'test_execution',
            status,
            output: out.slice(0, 500),
          });

          if (isFail) {
            this.skippedOrFailedChecks.push(`Test failure in command: ${cmd}`);
          }
        }
      }
    }

    return event;
  }

  public getEvents(): FlightRecorderEvent[] {
    return [...this.events];
  }

  /**
   * Compiles complete 14-point verifiable Proof of Change report
   */
  public compileProofOfChange(options: {
    filesModified: string[];
    patchesProposed: number;
    patchesAccepted: number;
    approvedHunksCount?: number;
    rejectedHunksCount?: number;
    isReadOnly?: boolean;
  }): ProofOfChangeReport {
    const executed = Array.from(this.testsExecuted);
    const discovered = Array.from(this.testsDiscovered);

    // Compute not-run tests
    for (const d of discovered) {
      if (!this.testResults.some((r) => r.testName.includes(d))) {
        this.testResults.push({
          testName: d,
          status: 'not_run',
        });
      }
    }

    const hasFailedTests = this.testResults.some((r) => r.status === 'failed');
    const hasPassedTests = this.testResults.some((r) => r.status === 'passed');

    let status: ProofOfChangeReport['status'] = 'unverified';
    if (hasFailedTests) {
      status = 'failed';
    } else if (hasPassedTests) {
      status = 'success';
    } else if (options.patchesAccepted > 0) {
      status = 'partial';
    } else if (options.isReadOnly || (options.patchesProposed === 0 && options.filesModified.length === 0)) {
      status = 'read_only_completed';
    }

    if (this.remainingRisks.length === 0 && options.filesModified.length > 0) {
      this.remainingRisks.push('Standard pre-merge automated CI regression validation recommended.');
    } else if (status === 'read_only_completed' && this.remainingRisks.length === 0) {
      this.remainingRisks.push('Read-only query: no repository files modified.');
    }

    const report: ProofOfChangeReport = {
      taskId: this.currentTaskId,
      userInstruction: this.currentInstruction,
      implementationPlan: this.implementationPlan.length > 0
        ? this.implementationPlan
        : ['Analyze context and discover relevant files', 'Stage surgical modifications', 'Execute test suite to prove correctness'],
      contextSelected: this.selectedContextMetadata,
      filesInspected: Array.from(this.filesInspected),
      filesModified: options.filesModified,
      patchesProposed: options.patchesProposed,
      patchesAccepted: options.patchesAccepted,
      approvedHunksCount: options.approvedHunksCount ?? options.patchesAccepted,
      rejectedHunksCount: options.rejectedHunksCount ?? (options.patchesProposed - options.patchesAccepted),
      commandsExecuted: this.commandsExecuted,
      testsDiscovered: discovered,
      testsExecuted: executed,
      testResults: this.testResults,
      testsPassed: hasPassedTests && !hasFailedTests,
      testOutputSummary: this.testOutputs.join('\n---\n').slice(0, 4000),
      skippedOrFailedChecks: this.skippedOrFailedChecks,
      remainingRisks: this.remainingRisks,
      unverifiedBehavior: this.unverifiedBehavior,
      status,
      generatedAt: new Date().toISOString(),
    };

    return report;
  }

  public async persistLog(filePath?: string): Promise<void> {
    if (!this.logDir && !filePath) return;
    const target = filePath ?? path.join(this.logDir!, `flight_recorder_${this.currentTaskId}.json`);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(this.events, null, 2), 'utf8');
    } catch (err) {
      console.warn('Failed to persist flight recorder log:', err);
    }
  }
}
