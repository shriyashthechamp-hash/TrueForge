import { describe, it, expect, beforeEach } from 'vitest';
import { FlightRecorder } from '../../src/flight-recorder/FlightRecorder.js';

describe('FlightRecorder & ProofOfChange (System 04 & 06)', () => {
  let recorder: FlightRecorder;

  beforeEach(() => {
    recorder = new FlightRecorder();
  });

  it('records events and tracks execution state', () => {
    recorder.startTask('task_test_1', 'Implement feature X');
    recorder.record('tool_call', 'Invoked read_file', { filePath: 'src/main.py' });
    recorder.record('tool_result', 'Read 20 lines', { filePath: 'src/main.py' });

    const events = recorder.getEvents();
    expect(events.length).toBe(3); // turn_start + tool_call + tool_result
    expect(events[0].type).toBe('turn_start');
  });

  it('compiles comprehensive 14-point Proof of Change report with discrete statuses', () => {
    recorder.startTask('task_proof_2', 'Fix security bug in CLI');
    recorder.addDiscoveredTests(['test_cli.py::test_config', 'test_cli.py::test_routes']);
    recorder.setContextSelectionMetadata([{ filePath: 'src/cli.py', tokens: 120, score: 85 }]);

    // Record test passing tool result
    recorder.record('tool_result', 'Test command executed', {
      toolName: 'run_test_command',
      command: 'pytest tests/test_cli.py -k test_config',
      output: '1 passed in 0.05s',
      isError: false,
    });

    const report = recorder.compileProofOfChange({
      filesModified: ['src/cli.py'],
      patchesProposed: 1,
      patchesAccepted: 1,
      approvedHunksCount: 1,
      rejectedHunksCount: 0,
    });

    expect(report.taskId).toBe('task_proof_2');
    expect(report.status).toBe('success');
    expect(report.testsPassed).toBe(true);
    expect(report.filesModified).toContain('src/cli.py');
    expect(report.testResults.some((r) => r.status === 'passed')).toBe(true);
    expect(report.testResults.some((r) => r.status === 'not_run')).toBe(true);
    expect(report.remainingRisks.length).toBeGreaterThan(0);
  });
});
