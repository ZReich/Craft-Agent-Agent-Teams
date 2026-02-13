import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLogger } from '../audit-logger';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('AuditLogger', () => {
  let testDir: string;
  let logger: AuditLogger;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'audit-logger-test-'));
    logger = new AuditLogger('test-team', testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('log', () => {
    it('should write a log entry', async () => {
      await logger.log({
        type: 'quality-gate-started',
        taskId: 'task-1',
        teammateId: 'worker-1',
        data: { test: 'value' },
      });

      const entries = await logger.getEntries();
      expect(entries).toHaveLength(1);
      const firstEntry = entries[0];
      expect(firstEntry).toBeDefined();
      expect(firstEntry!.type).toBe('quality-gate-started');
      expect(firstEntry!.taskId).toBe('task-1');
      expect(firstEntry!.teammateId).toBe('worker-1');
      expect(firstEntry!.data).toEqual({ test: 'value' });
      expect(firstEntry!.timestamp).toBeDefined();
      expect(firstEntry!.teamId).toBe('test-team');
    });

    it('should append multiple entries', async () => {
      await logger.log({ type: 'quality-gate-started', data: {} });
      await logger.log({ type: 'quality-gate-completed', data: { passed: true } });
      await logger.log({ type: 'feedback-sent', data: {} });

      const entries = await logger.getEntries();
      expect(entries).toHaveLength(3);
    });

    it('should create the log directory if it does not exist', async () => {
      const newLogger = new AuditLogger('new-team', testDir);
      await newLogger.log({ type: 'quality-gate-started', data: {} });

      const entries = await newLogger.getEntries();
      expect(entries).toHaveLength(1);
    });
  });

  describe('getEntries', () => {
    it('should return empty array when log file does not exist', async () => {
      const entries = await logger.getEntries();
      expect(entries).toEqual([]);
    });

    it('should filter by type', async () => {
      await logger.log({ type: 'quality-gate-started', data: {} });
      await logger.log({ type: 'quality-gate-completed', data: {} });
      await logger.log({ type: 'feedback-sent', data: {} });

      const entries = await logger.getEntries({ type: 'feedback-sent' });
      expect(entries).toHaveLength(1);
      const firstEntry = entries[0];
      expect(firstEntry).toBeDefined();
      expect(firstEntry!.type).toBe('feedback-sent');
    });

    it('should filter by taskId', async () => {
      await logger.log({ type: 'quality-gate-started', taskId: 'task-1', data: {} });
      await logger.log({ type: 'quality-gate-completed', taskId: 'task-2', data: {} });

      const entries = await logger.getEntries({ taskId: 'task-1' });
      expect(entries).toHaveLength(1);
      const firstEntry = entries[0];
      expect(firstEntry).toBeDefined();
      expect(firstEntry!.taskId).toBe('task-1');
    });

    it('should filter by teammateId', async () => {
      await logger.log({ type: 'quality-gate-started', teammateId: 'worker-1', data: {} });
      await logger.log({ type: 'quality-gate-completed', teammateId: 'worker-2', data: {} });

      const entries = await logger.getEntries({ teammateId: 'worker-2' });
      expect(entries).toHaveLength(1);
      const firstEntry = entries[0];
      expect(firstEntry).toBeDefined();
      expect(firstEntry!.teammateId).toBe('worker-2');
    });

    it('should handle malformed lines gracefully', async () => {
      await logger.log({ type: 'quality-gate-started', data: {} });

      // Manually append a malformed line
      const { appendFile } = await import('fs/promises');
      const logPath = join(testDir, 'test-team', 'audit.jsonl');
      await appendFile(logPath, 'invalid json line\n');

      await logger.log({ type: 'quality-gate-completed', data: {} });

      const entries = await logger.getEntries();
      expect(entries).toHaveLength(2); // Should skip the malformed line
    });
  });

  describe('getTaskTimeline', () => {
    it('should return entries sorted by timestamp', async () => {
      await logger.log({ type: 'quality-gate-started', taskId: 'task-1', data: {} });
      await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
      await logger.log({ type: 'feedback-sent', taskId: 'task-1', data: {} });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await logger.log({ type: 'quality-gate-completed', taskId: 'task-1', data: {} });
      await logger.log({ type: 'quality-gate-started', taskId: 'task-2', data: {} });

      const timeline = await logger.getTaskTimeline('task-1');
      expect(timeline).toHaveLength(3);
      const [first, second, third] = timeline;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(third).toBeDefined();
      expect(first!.type).toBe('quality-gate-started');
      expect(second!.type).toBe('feedback-sent');
      expect(third!.type).toBe('quality-gate-completed');
    });
  });

  describe('getSummary', () => {
    it('should return empty summary when no entries', async () => {
      const summary = await logger.getSummary();
      expect(summary).toEqual({
        totalReviews: 0,
        passedFirstCycle: 0,
        averageCycles: 0,
        escalationCount: 0,
        totalStalls: 0,
        totalConflicts: 0,
      });
    });

    it('should count reviews and cycles correctly', async () => {
      // First review - passes on cycle 1
      await logger.log({
        type: 'quality-gate-completed',
        taskId: 'task-1',
        teammateId: 'worker-1',
        cycleNumber: 1,
        data: { passed: true },
      });

      // Second review - passes on cycle 3
      await logger.log({
        type: 'quality-gate-completed',
        taskId: 'task-2',
        teammateId: 'worker-2',
        cycleNumber: 3,
        data: { passed: true },
      });

      const summary = await logger.getSummary();
      expect(summary.totalReviews).toBe(2);
      expect(summary.passedFirstCycle).toBe(1);
      expect(summary.averageCycles).toBe(2); // (1 + 3) / 2
    });

    it('should count escalations, stalls, and conflicts', async () => {
      await logger.log({ type: 'escalation-triggered', data: {} });
      await logger.log({ type: 'escalation-triggered', data: {} });
      await logger.log({ type: 'stall-detected', data: {} });
      await logger.log({ type: 'file-conflict-detected', data: {} });

      const summary = await logger.getSummary();
      expect(summary.escalationCount).toBe(2);
      expect(summary.totalStalls).toBe(1);
      expect(summary.totalConflicts).toBe(1);
    });

    it('should only count passed reviews in totals', async () => {
      // Failed review (not passed)
      await logger.log({
        type: 'quality-gate-completed',
        taskId: 'task-1',
        cycleNumber: 1,
        data: { passed: false },
      });

      // Passed review
      await logger.log({
        type: 'quality-gate-completed',
        taskId: 'task-2',
        cycleNumber: 1,
        data: { passed: true },
      });

      const summary = await logger.getSummary();
      expect(summary.totalReviews).toBe(1); // Only the passed review
      expect(summary.passedFirstCycle).toBe(1);
    });
  });
});
