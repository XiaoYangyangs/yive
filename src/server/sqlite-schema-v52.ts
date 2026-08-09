import type { Database } from 'better-sqlite3'

const RETIRED_TABLES = [
  'candidate_acceptance_cache_leases',
  'candidate_acceptance_cache_entries',
  'candidate_acceptance_coder_recoveries',
  'candidate_acceptance_attempt_runs',
  'candidate_acceptance_gate_reassignments',
  'candidate_acceptance_stale_gate_reports',
  'candidate_acceptance_observation_sources',
  'candidate_acceptance_observations',
  'candidate_acceptance_finding_relationships',
  'candidate_acceptance_finding_sources',
  'candidate_acceptance_findings',
  'candidate_acceptance_remediation_proposals',
  'candidate_acceptance_barrier_aggregates',
  'candidate_acceptance_brief_amendments',
  'candidate_acceptance_gate_dispatch_contexts',
  'candidate_acceptance_artifacts',
  'candidate_acceptance_ci_runs',
  'candidate_acceptance_preflights',
  'candidate_acceptance_gates',
  'candidate_acceptance_rounds',
  'candidate_acceptance_candidates',
  'orchestrator_wake_events',
  'candidate_acceptance_workflows',
  'workflow_intents',
  'execution_profile_pins',
  'execution_profile_revisions',
  'execution_profiles',
  'workspace_role_profile_defaults',
  'provider_credentials',
  'model_providers',
] as const

export const applySchemaVersion52 = (db: Database) => {
  for (const table of RETIRED_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
}
