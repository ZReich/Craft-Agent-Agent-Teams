/**
 * File Ownership Tracker Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileOwnershipTracker } from '../file-tracker';

describe('FileOwnershipTracker', () => {
  let tracker: FileOwnershipTracker;

  beforeEach(() => {
    tracker = new FileOwnershipTracker();
  });

  afterEach(() => {
    tracker.dispose();
  });

  describe('initialization', () => {
    it('should create with default config (warn mode)', () => {
      expect(tracker).toBeInstanceOf(FileOwnershipTracker);
    });

    it('should create with strict mode', () => {
      const strictTracker = new FileOwnershipTracker({ mode: 'strict' });
      expect(strictTracker).toBeInstanceOf(FileOwnershipTracker);
      strictTracker.dispose();
    });
  });

  describe('file modification tracking', () => {
    it('should establish ownership on first modification', () => {
      const conflict = tracker.recordModification(
        'team-1',
        'mate-1',
        'Worker A',
        '/path/to/file.ts',
      );

      expect(conflict).toBeNull();
      const ownership = tracker.getOwnership('team-1', '/path/to/file.ts');
      expect(ownership).toBeDefined();
      expect(ownership?.ownerId).toBe('mate-1');
      expect(ownership?.ownerName).toBe('Worker A');
      expect(ownership?.modificationCount).toBe(1);
    });

    it('should increment modification count for same teammate', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file.ts');
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file.ts');

      const ownership = tracker.getOwnership('team-1', '/path/to/file.ts');
      expect(ownership?.modificationCount).toBe(2);
    });

    it('should detect conflict when different teammate modifies file', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file.ts');
      const conflict = tracker.recordModification(
        'team-1',
        'mate-2',
        'Worker B',
        '/path/to/file.ts',
      );

      expect(conflict).not.toBeNull();
      expect(conflict?.currentOwner.ownerId).toBe('mate-1');
      expect(conflict?.attemptedBy.teammateId).toBe('mate-2');
      expect(conflict?.blocked).toBe(false); // default mode is 'warn'
    });

    it('should block conflicts in strict mode', () => {
      const strictTracker = new FileOwnershipTracker({ mode: 'strict' });

      strictTracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file.ts');
      const conflict = strictTracker.recordModification(
        'team-1',
        'mate-2',
        'Worker B',
        '/path/to/file.ts',
      );

      expect(conflict?.blocked).toBe(true);
      strictTracker.dispose();
    });

    it('should normalize file paths', () => {
      // Record with different path formats
      tracker.recordModification('team-1', 'mate-1', 'Worker A', 'path/to/file.ts');
      const ownership = tracker.getOwnership('team-1', './path/to/file.ts');

      // Should find the same file (normalized)
      expect(ownership).toBeDefined();
    });
  });

  describe('conflict checking', () => {
    it('should pre-check for conflicts without recording', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file.ts');

      const conflict = tracker.checkConflict('team-1', '/path/to/file.ts', 'mate-2');

      expect(conflict).not.toBeNull();
      expect(conflict?.currentOwner.ownerId).toBe('mate-1');

      // Should not have recorded the conflict
      const conflicts = tracker.getConflicts('team-1');
      expect(conflicts).toHaveLength(0);
    });

    it('should return null when no conflict would occur', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file.ts');

      const conflict = tracker.checkConflict('team-1', '/path/to/file.ts', 'mate-1');
      expect(conflict).toBeNull();
    });
  });

  describe('ownership release', () => {
    it('should release specific files', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file1.ts');
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file2.ts');

      tracker.releaseOwnership('team-1', ['/path/to/file1.ts']);

      expect(tracker.getOwnership('team-1', '/path/to/file1.ts')).toBeNull();
      expect(tracker.getOwnership('team-1', '/path/to/file2.ts')).not.toBeNull();
    });

    it('should release all files owned by a teammate', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file1.ts');
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file2.ts');
      tracker.recordModification('team-1', 'mate-2', 'Worker B', '/path/to/file3.ts');

      tracker.releaseTeammateFiles('team-1', 'mate-1');

      expect(tracker.getOwnership('team-1', '/path/to/file1.ts')).toBeNull();
      expect(tracker.getOwnership('team-1', '/path/to/file2.ts')).toBeNull();
      expect(tracker.getOwnership('team-1', '/path/to/file3.ts')).not.toBeNull();
    });
  });

  describe('queries', () => {
    it('should get all files owned by a teammate', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file1.ts');
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file2.ts');
      tracker.recordModification('team-1', 'mate-2', 'Worker B', '/path/to/file3.ts');

      const files = tracker.getTeammateFiles('team-1', 'mate-1');
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.filePath)).toEqual(expect.arrayContaining([
        expect.stringContaining('file1.ts'),
        expect.stringContaining('file2.ts'),
      ]));
    });

    it('should get all conflicts for a team', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file1.ts');
      tracker.recordModification('team-1', 'mate-2', 'Worker B', '/path/to/file1.ts');
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file2.ts');
      tracker.recordModification('team-1', 'mate-2', 'Worker B', '/path/to/file2.ts');

      const conflicts = tracker.getConflicts('team-1');
      expect(conflicts).toHaveLength(2);
    });

    it('should get team file map', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file1.ts');
      tracker.recordModification('team-1', 'mate-2', 'Worker B', '/path/to/file2.ts');

      const fileMap = tracker.getTeamFileMap('team-1');
      expect(fileMap.size).toBe(2);
    });

    it('should return empty results for unknown team', () => {
      expect(tracker.getTeammateFiles('unknown', 'mate-1')).toEqual([]);
      expect(tracker.getConflicts('unknown')).toEqual([]);
      expect(tracker.getTeamFileMap('unknown').size).toBe(0);
    });
  });

  describe('dispose', () => {
    it('should clean up all resources', () => {
      tracker.recordModification('team-1', 'mate-1', 'Worker A', '/path/to/file.ts');
      tracker.dispose();

      const ownership = tracker.getOwnership('team-1', '/path/to/file.ts');
      expect(ownership).toBeNull();
    });
  });
});
