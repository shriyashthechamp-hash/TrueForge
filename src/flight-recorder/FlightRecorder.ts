import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FlightRecorderEvent, ProofOfChangeReport } from '../shared/types.js';

export class FlightRecorder {
  private events: FlightRecorderEvent[] = [];
  private currentTaskId = '';
  private currentInstruction = '';
  private testsDiscovered = new Set<string>();
  private testsExecuted = new Set<string>();
  private testOutputs: string[] = [];
  private lastTestPassed = true;

  constructor(private readonly logDir?: string) {}

  public startTask(taskId: string, instruction: string): void {
    this.currentTaskId = taskId;
    this.currentInstruction = instruction;
    this.events = [];
    this.testsDiscovered.clear();
    this.testsExecuted.clear();
    this.testOutputs = [];
    this.lastTestPassed = true;

    this.record('turn_start', `Started task: "${instruction}"`, { taskId });
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

    if (type === 'tool_result' && details) {
      const toolName = String(details.toolName ?? '');
      if (toolName === 'run_test_command') {
        const out = String(details.output ?? '');
        this.testOutputs.push(out);
        const cmd = String(details.command ?? '');
        this.testsExecuted.add(cmd);
        if (out.includes('FAILED') || out.includes('error') || details.isError) {
          this.lastTestPassed = false;
        }
      }
    }

    return event;
  }

  public addDiscoveredTests(tests: string[]): void {
    for (const t of tests) {
      this.testsDiscovered.add(t);
    }
  }

  public getEvents(): FlightRecorderEvent[] {
    return [...this.events];
  }

  public compileProofOfChange(options: {
    filesModified: string[];
    patchesProposed: number;
    patchesAccepted: number;
  }): ProofOfChangeReport {
    const executed = Array.from(this.testsExecuted);
    const discovered = Array.from(this.testsDiscovered);

    let status: ProofOfChangeReport['status'] = 'unverified';
    if (executed.length > 0) {
      status = this.lastTestPassed ? 'success' : 'failed';
    } else if (options.patchesAccepted > 0) {
      status = 'partial';
    }

    const report: ProofOfChangeReport = {
      taskId: this.currentTaskId,
      userInstruction: this.currentInstruction,
      filesModified: options.filesModified,
      patchesProposed: options.patchesProposed,
      patchesAccepted: options.patchesAccepted,
      testsDiscovered: discovered,
      testsExecuted: executed,
      testsPassed: executed.length > 0 && this.lastTestPassed,
      testOutputSummary: this.testOutputs.join('\n---\n').slice(0, 4000),
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

