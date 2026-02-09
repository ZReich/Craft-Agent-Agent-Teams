/**
 * Spec-Driven Development (SDD) types
 *
 * These types define the data model for spec-driven development — a workflow
 * where implementation is guided by structured specification documents with
 * requirements, DRI assignments, and compliance tracking.
 */

// ============================================================
// Spec Schema
// ============================================================

/**
 * A specification document that drives implementation
 */
export interface Spec {
  specId: string;
  title: string;
  /** Directly Responsible Individual who owns the spec */
  ownerDRI: string;
  /** List of reviewer identifiers */
  reviewers: string[];
  status: SpecStatus;
  goals: string[];
  nonGoals: string[];
  requirements: SpecRequirement[];
  risks: SpecRisk[];
  mitigations: string[];
  rolloutPlan?: string;
  rollbackPlan?: string;
  testPlan?: string;
  observabilityPlan?: string;
  relatedTickets: TicketReference[];
  createdAt: string;
  updatedAt: string;
}

/** Lifecycle status of a spec */
export type SpecStatus = 'draft' | 'in-review' | 'approved' | 'in-progress' | 'completed' | 'archived';

/**
 * A single requirement within a spec
 */
export interface SpecRequirement {
  /** Requirement identifier (e.g. "REQ-001") */
  id: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  acceptanceTests: string[];
  status: 'pending' | 'in-progress' | 'implemented' | 'verified';
  /** DRI assigned to this requirement */
  assignedDRI?: string;
  /** Task IDs linked to this requirement */
  linkedTaskIds?: string[];
  /** File patterns that implement this requirement */
  linkedFilePatterns?: string[];
  /** Test file patterns that verify this requirement */
  linkedTestPatterns?: string[];
}

/**
 * A risk identified in a spec
 */
export interface SpecRisk {
  id: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  mitigation: string;
  status: 'identified' | 'mitigated' | 'accepted';
}

// ============================================================
// Ticket Integration Types
// ============================================================

/**
 * A reference to an external ticket or issue
 */
export interface TicketReference {
  provider: TicketProviderType;
  ticketId: string;
  url?: string;
  title?: string;
  status?: string;
  /** Which spec requirements this ticket addresses */
  requirementIds?: string[];
}

/** Supported ticket/issue tracking providers */
export type TicketProviderType = 'github' | 'craft' | 'linear' | 'local';

// ============================================================
// Spec Templates
// ============================================================

/**
 * A reusable spec template (workspace-level)
 */
export interface SpecTemplate {
  id: string;
  name: string;
  description?: string;
  sections: SpecTemplateSection[];
  defaultRequirementPriority?: SpecRequirement['priority'];
  createdAt: string;
}

/**
 * A section within a spec template
 */
export interface SpecTemplateSection {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
}

// ============================================================
// DRI (Directly Responsible Individual) Types
// ============================================================

/**
 * Assignment of a DRI to spec sections or requirements
 */
export interface DRIAssignment {
  /** Teammate name or "self" for solo mode */
  userId: string;
  role: 'owner' | 'reviewer' | 'contributor';
  /** Spec section keys or requirement IDs they're responsible for */
  sections: string[];
  status: 'active' | 'completed';
}

// ============================================================
// Spec Compliance Report
// ============================================================

/**
 * Compliance report generated after spec completion
 */
export interface SpecComplianceReport {
  specId: string;
  timestamp: string;
  /** Overall coverage percentage (0-100) */
  overallCoverage: number;
  requirementsCoverage: RequirementCoverage[];
  /** Requirement IDs not found in output */
  unreferencedRequirements: string[];
  traceabilityMap: TraceabilityEntry[];
  rolloutSafetyCheck?: RolloutSafetyCheck;
}

/**
 * Coverage status for a single requirement
 */
export interface RequirementCoverage {
  requirementId: string;
  coverage: 'full' | 'partial' | 'none';
  referencedInFiles: string[];
  referencedInTests: string[];
  notes?: string;
}

/**
 * Maps a requirement to its implementation artifacts
 */
export interface TraceabilityEntry {
  requirementId: string;
  files: string[];
  tests: string[];
  tasks: string[];
  tickets: string[];
}

/**
 * Safety checks for rollout readiness
 */
export interface RolloutSafetyCheck {
  hasRollbackPlan: boolean;
  hasMonitoring: boolean;
  hasFeatureFlags: boolean;
  issues: string[];
}

// ============================================================
// SDD Session State
// ============================================================

/**
 * Per-session state for spec-driven development
 */
export interface SDDSessionState {
  specModeEnabled: boolean;
  activeSpecId?: string;
  activeSpec?: Spec;
  complianceReports: SpecComplianceReport[];
  driAssignments: DRIAssignment[];
}

// ============================================================
// SDD Quality Gate Extensions
// ============================================================

/** Quality gate stage names specific to SDD */
export type SDDQualityGateStageName = 'spec_compliance' | 'traceability' | 'rollout_safety';
