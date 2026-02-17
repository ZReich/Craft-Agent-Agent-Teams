/**
 * Health Monitor Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TeammateHealthMonitor } from '../health-monitor';

describe('TeammateHealthMonitor', () => {
  let monitor: TeammateHealthMonitor;

  beforeEach(() => {
    monitor = new TeammateHealthMonitor();
  });

  afterEach(() => {
    monitor.dispose();
  });

  describe('initialization', () => {
    it('should create with default config', () => {
      expect(monitor).toBeInstanceOf(TeammateHealthMonitor);
    });

    it('should create with custom config', () => {
      const customMonitor = new TeammateHealthMonitor({
        stallTimeoutMs: 10000,
        errorLoopThreshold: 5,
      });
      expect(customMonitor).toBeInstanceOf(TeammateHealthMonitor);
      customMonitor.dispose();
    });
  });

  describe('monitoring lifecycle', () => {
    it('should start monitoring a team', () => {
      expect(() => monitor.startMonitoring('team-1')).not.toThrow();
    });

    it('should stop monitoring a team', () => {
      monitor.startMonitoring('team-1');
      expect(() => monitor.stopMonitoring('team-1')).not.toThrow();
    });

    it('should handle starting monitoring twice (idempotent)', () => {
      monitor.startMonitoring('team-1');
      monitor.startMonitoring('team-1');
      monitor.stopMonitoring('team-1');
    });
  });

  describe('activity recording', () => {
    it('should record tool call activity', () => {
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_call',
        toolName: 'Read',
        toolInput: 'some-file.ts',
      });

      const health = monitor.getHealth('team-1', 'mate-1');
      expect(health).toBeDefined();
      expect(health?.teammateId).toBe('mate-1');
      expect(health?.teammateName).toBe('Worker A');
    });

    it('should track consecutive errors', () => {
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_result',
        toolName: 'Read',
        error: true,
      });

      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_result',
        toolName: 'Read',
        error: true,
      });

      const health = monitor.getHealth('team-1', 'mate-1');
      expect(health?.consecutiveErrors).toBe(2);
      expect(health?.lastErrorTool).toBe('Read');
    });

    it('should reset error counter on successful tool result', () => {
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_result',
        toolName: 'Read',
        error: true,
      });

      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_result',
        toolName: 'Read',
        error: false,
      });

      const health = monitor.getHealth('team-1', 'mate-1');
      expect(health?.consecutiveErrors).toBe(0);
      expect(health?.lastErrorTool).toBeUndefined();
    });

    it('should normalize near-duplicate search queries for retry-storm tracking', () => {
      const teamId = 'team-1';
      const mateId = 'mate-1';

      monitor.recordActivity(teamId, mateId, 'Worker A', {
        type: 'tool_call',
        toolName: 'WebSearch',
        toolInput: 'Best Mexican restaurants Billings page=1',
      });
      monitor.recordActivity(teamId, mateId, 'Worker A', {
        type: 'tool_call',
        toolName: 'WebSearch',
        toolInput: 'best mexican restaurants billings page=2',
      });

      const health = monitor.getHealth(teamId, mateId);
      expect(health).toBeDefined();
      expect(health?.recentToolCalls).toHaveLength(2);
      expect(health?.recentToolCalls[0]?.normalizedInput).toBe(health?.recentToolCalls[1]?.normalizedInput);
    });
  });

  describe('context usage', () => {
    it('should record context usage', () => {
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_call',
        toolName: 'Read',
      });

      monitor.recordContextUsage('team-1', 'mate-1', 0.75);

      const health = monitor.getHealth('team-1', 'mate-1');
      expect(health?.contextUsage).toBe(0.75);
    });

    it('should clamp context usage to 0-1 range', () => {
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_call',
        toolName: 'Read',
      });

      monitor.recordContextUsage('team-1', 'mate-1', 1.5);
      let health = monitor.getHealth('team-1', 'mate-1');
      expect(health?.contextUsage).toBe(1);

      monitor.recordContextUsage('team-1', 'mate-1', -0.5);
      health = monitor.getHealth('team-1', 'mate-1');
      expect(health?.contextUsage).toBe(0);
    });
  });

  describe('team health queries', () => {
    it('should return empty array for unknown team', () => {
      const health = monitor.getTeamHealth('unknown-team');
      expect(health).toEqual([]);
    });

    it('should return all teammates in a team', () => {
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_call',
        toolName: 'Read',
      });

      monitor.recordActivity('team-1', 'mate-2', 'Worker B', {
        type: 'tool_call',
        toolName: 'Write',
      });

      const health = monitor.getTeamHealth('team-1');
      expect(health).toHaveLength(2);
      expect(health.map((h) => h.teammateId)).toEqual(['mate-1', 'mate-2']);
    });
  });

  describe('dispose', () => {
    it('should clean up all resources', () => {
      monitor.startMonitoring('team-1');
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_call',
        toolName: 'Read',
      });

      monitor.dispose();

      const health = monitor.getTeamHealth('team-1');
      expect(health).toEqual([]);
    });
  });
});
